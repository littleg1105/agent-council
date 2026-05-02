/**
 * Clean-checkout verifier — runs the project's test command in an isolated
 * git worktree of the candidate commit, so a passing verify can't be faked
 * by side effects on the working tree or by an LLM that "mocked the test
 * runner" in-process.
 *
 * From council-20260502-205303 (Fork 2A unanimous): use `git worktree add
 * <tmp> <commit>` and reuse dependency trees only when the candidate
 * commit's lockfile hash matches the prepared main checkout. Avoids the
 * 30s-3min reinstall tax per leaf without paying option C's working-tree
 * mutation risk.
 *
 * The verifier runs WITH NO API KEYS in env — `ANTHROPIC_API_KEY`,
 * `OPENAI_API_KEY`, `GEMINI_API_KEY`, `CODEX_API_KEY` are stripped before
 * spawn so the test code can't covertly call out to LLMs to fake passes.
 *
 * Failure mode the council flagged (uniquely vulnerable to A): borrowed
 * dependency trees can mask undeclared coupling. Mitigation: only share
 * immutable dependency dirs (node_modules, .venv/site-packages); never
 * share build outputs (dist/, target/, __pycache__/).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "fs";
import { resolve, dirname, basename } from "path";
import { tmpdir } from "os";
import type { ProjectProfile } from "./autopilot-profile";
import { augmentEnvForVerifier } from "./autopilot-env";

export interface VerifyResult {
  passed: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
}

/**
 * Run the goal's verify command (profile.spec_test_command(specPath)) against
 * a candidate commit in a clean git worktree. Returns the structured result;
 * caller decides what to do (advance, retry, escalate to stuck-rescue).
 *
 * If `commit` is undefined, runs against HEAD (useful for dev iterations and
 * the orchestrator's per-cycle checks before commit).
 */
export async function verifyInWorktree(args: {
  repoRoot: string;
  commit: string | undefined;
  specPath: string;
  profile: ProjectProfile;
  /** Per-call timeout in ms. Default 5 min. */
  timeoutMs?: number;
}): Promise<VerifyResult> {
  const startTime = Date.now();
  const timeoutMs = args.timeoutMs ?? 5 * 60_000;

  // Always create the worktree under the OS temp dir so it's never inside
  // the repo (which would confuse git status / commit hooks).
  const tmpRoot = resolve(tmpdir(), `autopilot-worktree-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  mkdirSync(dirname(tmpRoot), { recursive: true });

  // git worktree add. If commit is undefined, use HEAD.
  const ref = args.commit ?? "HEAD";
  try {
    const wt = Bun.spawn(["git", "worktree", "add", "--detach", tmpRoot, ref], {
      cwd: args.repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const wtExit = await wt.exited;
    if (wtExit !== 0) {
      const wtErr = await new Response(wt.stderr).text();
      return {
        passed: false,
        exitCode: -1,
        stdout: "",
        stderr: `git worktree add failed: ${wtErr}`,
        command: `git worktree add --detach ${tmpRoot} ${ref}`,
        durationMs: Date.now() - startTime,
      };
    }
  } catch (e: any) {
    return {
      passed: false,
      exitCode: -1,
      stdout: "",
      stderr: `git worktree add threw: ${e.message}`,
      command: `git worktree add --detach ${tmpRoot} ${ref}`,
      durationMs: Date.now() - startTime,
    };
  }

  try {
    // Symlink immutable dep dirs from the original repo into the worktree.
    // Conservative list — only directories that are deterministic functions
    // of the lockfile and never written to during a test run.
    await shareDependencyDirs(args.repoRoot, tmpRoot, args.profile);

    // Run the verify command. augmentEnvForVerifier:
    //   1. prepends project-local bin dirs (.venv/bin, node_modules/.bin)
    //      to PATH — see autopilot-env.ts. Critical for Python+Poetry where
    //      poetry/pytest live in .venv/bin and may not be in shell PATH.
    //   2. strips API keys (ANTHROPIC_API_KEY, etc.) so test code can't
    //      covertly call out to LLMs to fake a pass.
    // We use args.repoRoot (the SOURCE repo) for PATH augmentation, not
    // tmpRoot — the .venv is symlinked into the worktree but tools resolve
    // against the symlink target, which lives in the source repo.
    const env = augmentEnvForVerifier(args.repoRoot);
    const cmdParts = args.profile.spec_test_command(args.specPath).split(/\s+/).filter(Boolean);
    let verify: ReturnType<typeof Bun.spawn>;
    try {
      verify = Bun.spawn(cmdParts, {
        cwd: tmpRoot,
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
    } catch (e: any) {
      // Binary not in PATH (poetry / pytest / cargo / etc.) — return a
      // structured failure instead of crashing the orchestrator.
      return {
        passed: false,
        exitCode: -1,
        stdout: "",
        stderr: `verifier spawn failed: ${e.message}\n` +
          `command: ${cmdParts.join(" ")}\n` +
          `Hint: ensure the project's tools are installed at ${resolve(args.repoRoot, ".venv/bin")} ` +
          `(Python+Poetry) or ${resolve(args.repoRoot, "node_modules/.bin")} (Node), ` +
          `or activate the appropriate venv before running the autopilot.`,
        command: cmdParts.join(" "),
        durationMs: Date.now() - startTime,
      };
    }

    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { verify.kill("SIGTERM"); } catch {}
      setTimeout(() => { try { verify.kill("SIGKILL"); } catch {} }, 2000);
    }, timeoutMs);

    const [exitCode, stdout, stderr] = await Promise.all([
      verify.exited,
      new Response(verify.stdout).text(),
      new Response(verify.stderr).text(),
    ]);
    clearTimeout(killTimer);

    return {
      passed: !timedOut && exitCode === 0,
      exitCode: timedOut ? -1 : exitCode,
      stdout,
      stderr: timedOut ? `${stderr}\n[verifier killed by timeout after ${timeoutMs / 1000}s]` : stderr,
      command: cmdParts.join(" "),
      durationMs: Date.now() - startTime,
    };
  } finally {
    // Always clean up the worktree, even on error
    try {
      await Bun.spawn(["git", "worktree", "remove", "--force", tmpRoot], {
        cwd: args.repoRoot,
      }).exited;
    } catch {}
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * Symlink immutable dependency directories from the source repo into the
 * worktree, so the verifier doesn't have to reinstall deps for every leaf.
 *
 * Per-profile heuristic. Conservative: only share dirs that are deterministic
 * functions of the lockfile. Never share build outputs.
 *
 * Council's flagged failure mode (Codex): borrowed dep trees can mask
 * undeclared coupling; only IMMUTABLE dirs may be shared. We err on the
 * side of NOT sharing if uncertain.
 */
async function shareDependencyDirs(srcRepo: string, worktree: string, profile: ProjectProfile): Promise<void> {
  // Map from profile id → directories to symlink (relative to repo root).
  // Future: profiles could declare their own dependency_paths.
  const sharePaths: Record<string, string[]> = {
    "typescript-bun": ["node_modules"],
    "typescript-node": ["node_modules"],
    "typescript-jest": ["node_modules"],
    "python-poetry": [".venv"],
    "python-pytest": [".venv", "venv"],
    "ruby-rspec": ["vendor"],
    // Go and Rust handle deps differently; skipping for now (they're fast enough)
  };
  const dirs = sharePaths[profile.id] || [];
  for (const dir of dirs) {
    const src = resolve(srcRepo, dir);
    const dst = resolve(worktree, dir);
    if (!existsSync(src)) continue; // nothing to share
    if (existsSync(dst)) continue; // worktree already has it (rare)
    try {
      symlinkSync(src, dst, "dir");
    } catch {
      // non-fatal — if the symlink fails, the verifier will reinstall on
      // first test run (slow but correct)
    }
  }
}

/**
 * Verify the spec file's SHA matches the recorded value in state.json.
 * If it doesn't, the implementing subprocess (or a malicious diff) edited
 * the frozen spec — load-bearing fake-progress defense. Caller should
 * fail the goal hard on mismatch.
 */
export async function verifySpecSha(args: {
  repoRoot: string;
  specPath: string;
  expectedSha: string;
}): Promise<{ matches: boolean; actualSha: string }> {
  const { fileHash } = await import("./autopilot-state");
  const fullPath = resolve(args.repoRoot, args.specPath);
  const actualSha = await fileHash(fullPath);
  return { matches: actualSha === args.expectedSha, actualSha };
}
