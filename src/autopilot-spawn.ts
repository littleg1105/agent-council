/**
 * Spawn an implementing `claude -p` subprocess with a permission allowlist
 * scoped to the per-goal contract.
 *
 * From council-20260502-205303 (Fork 1B + Codex's permission spec):
 *   "Govern permissions with an explicit allowlist, not broad shell access:
 *    repo writes except .autopilot/** and profile-defined frozen spec paths,
 *    plus git status/diff/add/commit/rev-parse/log/show, read-only inspection
 *    (rg/ls/find/cat/sed), and the profile verify commands; deny destructive
 *    git, installers, networked tools, and arbitrary Bash."
 *
 * The orchestrator spawns ONE fresh claude -p per iteration (Fork 1B). Each
 * spawn has no memory of prior attempts; the orchestrator owns the iteration
 * boundary, the verifier result, and the rate-limit handling.
 *
 * In PR9.1 we ship the spawn-and-wait happy path. PR9.3 wires the rate-limit
 * detector into the result so the orchestrator can pause-and-resume.
 */

import type { ProjectProfile } from "./autopilot-profile";
import { detectRateLimit, type RateLimitSignal } from "./autopilot-rate-limit";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True if claude -p's exit indicated a rate-limit signal. PR9.3 acts on this. */
  rateLimit: RateLimitSignal;
}

/**
 * Build the --allowedTools / --disallowedTools list per Codex's spec.
 *
 * Allowed:
 *   - Read, Write, Edit (file ops; the pre-commit hook enforces frozen-spec rejection)
 *   - Bash(git status:*), Bash(git diff:*), Bash(git add:*), Bash(git commit:*),
 *     Bash(git rev-parse:*), Bash(git log:*), Bash(git show:*) — read + commit
 *   - Bash(rg:*), Bash(ls:*), Bash(find:*), Bash(cat:*), Bash(sed:*),
 *     Bash(head:*), Bash(tail:*), Bash(grep:*), Bash(wc:*) — read-only inspection
 *   - The profile's verify command, parsed to its first token
 *     (e.g., "poetry", "bun", "go", "cargo", "bundle", "npx")
 *
 * Disallowed (explicit denials override allows):
 *   - Bash(git push:*), Bash(git reset:*), Bash(git checkout:*),
 *     Bash(git branch:*), Bash(git rebase:*) — destructive git
 *   - Bash(rm:*), Bash(mv:*) restricted via allowlist (we just don't allow them)
 *
 * Permission scope for Edit/Write tools is repo-wide BUT the pre-commit
 * hook (autopilot-hook.ts) catches frozen-spec edits before they land as
 * commits. Defense in depth: hook + post-spawn spec_sha check.
 */
function buildToolAllowlist(profile: ProjectProfile): { allowed: string[]; disallowed: string[] } {
  // Extract the FIRST TOKEN of the profile's test command and allow that.
  // E.g., "bun test <spec>" → allow Bash(bun:*); "poetry run pytest <spec>" → allow Bash(poetry:*).
  // The full command is multi-word but the safe-guard is at the first-token level.
  const verifyTokens = new Set<string>();
  const cmdParts = profile.test_command.split(/\s+/).filter(Boolean);
  if (cmdParts[0]) verifyTokens.add(cmdParts[0]);
  if (profile.typecheck_command) {
    const tcParts = profile.typecheck_command.split(/\s+/).filter(Boolean);
    if (tcParts[0]) verifyTokens.add(tcParts[0]);
  }
  // Spec-test command may use a different first token (e.g., "npx vitest run …").
  // Probe with a fake path; safe because spec_test_command is pure.
  const specCmdParts = profile.spec_test_command(".council/specs/probe").split(/\s+/).filter(Boolean);
  if (specCmdParts[0]) verifyTokens.add(specCmdParts[0]);

  const allowed: string[] = [
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
    // Read-only inspection
    "Bash(ls:*)", "Bash(find:*)", "Bash(cat:*)", "Bash(head:*)", "Bash(tail:*)",
    "Bash(grep:*)", "Bash(rg:*)", "Bash(wc:*)", "Bash(sed:*)", "Bash(awk:*)",
    "Bash(file:*)", "Bash(stat:*)", "Bash(pwd:*)", "Bash(echo:*)",
    // Read + commit git
    "Bash(git status:*)", "Bash(git diff:*)", "Bash(git add:*)", "Bash(git commit:*)",
    "Bash(git rev-parse:*)", "Bash(git log:*)", "Bash(git show:*)", "Bash(git ls-files:*)",
    "Bash(git config user.email:*)", "Bash(git config user.name:*)",
  ];
  for (const tok of verifyTokens) {
    allowed.push(`Bash(${tok}:*)`);
  }

  const disallowed: string[] = [
    // Destructive git — never under any circumstance
    "Bash(git push:*)",
    "Bash(git reset:*)",
    "Bash(git checkout:*)",
    "Bash(git branch:*)",
    "Bash(git rebase:*)",
    "Bash(git merge:*)",
    "Bash(git stash:*)",
    "Bash(git clean:*)",
    "Bash(git worktree:*)",
    "Bash(git remote:*)",
    "Bash(git tag:*)",
    "Bash(git filter-branch:*)",
    // Destructive filesystem
    "Bash(rm:*)",
    "Bash(rmdir:*)",
    "Bash(mv:*)",
    "Bash(chmod:*)",
    // Network / install (would invalidate the clean-checkout-verifier guarantee)
    "Bash(curl:*)",
    "Bash(wget:*)",
    "Bash(npm install:*)",
    "Bash(npm uninstall:*)",
    "Bash(pip install:*)",
    "Bash(pip uninstall:*)",
    "Bash(poetry add:*)",
    "Bash(poetry remove:*)",
    "Bash(bun add:*)",
    "Bash(bun remove:*)",
    "Bash(cargo add:*)",
    "Bash(cargo install:*)",
  ];

  return { allowed, disallowed };
}

/**
 * Spawn `claude -p <prompt>` with the per-profile permission allowlist.
 * Captures stdout/stderr, exit code, duration. Detects rate-limit signals
 * for PR9.3's auto-pause flow.
 */
export async function spawnImplementingClaude(args: {
  prompt: string;
  repoRoot: string;
  profile: ProjectProfile;
  /** Per-spawn timeout in ms. Default 30 min — generous so claude can iterate fully. */
  timeoutMs?: number;
  /** Optional model override (passes --model). */
  model?: string;
  /** Optional effort level (default "max"). Passes --effort. */
  effort?: "max" | "high" | "medium" | "low" | "off";
}): Promise<SpawnResult> {
  const startTime = Date.now();
  const timeoutMs = args.timeoutMs ?? 30 * 60_000;
  const effort = args.effort ?? "max";

  const { allowed, disallowed } = buildToolAllowlist(args.profile);

  const argv: string[] = [
    "claude", "-p", args.prompt,
    "--output-format", "json",
    "--add-dir", args.repoRoot,
    "--allowed-tools", allowed.join(" "),
    "--disallowed-tools", disallowed.join(" "),
  ];
  if (effort !== "off") argv.push("--effort", effort);
  if (args.model) argv.push("--model", args.model);

  const proc = Bun.spawn(argv, {
    cwd: args.repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try { proc.kill("SIGTERM"); } catch {}
    setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
  }, timeoutMs);

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  clearTimeout(killTimer);

  // PR9.3 will branch on this. PR9.1 just records it.
  const rateLimit = detectRateLimit("claude", stderr, stdout);

  return {
    exitCode: timedOut ? -1 : exitCode,
    stdout,
    stderr: timedOut ? `${stderr}\n[claude -p killed by timeout after ${timeoutMs / 1000}s]` : stderr,
    durationMs: Date.now() - startTime,
    rateLimit,
  };
}

/**
 * Get the current HEAD commit. Used after a successful verify to record
 * `green_commit` on the goal and `last_green_commit` on the state.
 */
export async function getCurrentCommit(repoRoot: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "rev-parse", "HEAD"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return null;
    return out.trim() || null;
  } catch {
    return null;
  }
}
