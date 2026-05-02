/**
 * Autopilot orchestrator (PR8 — dry-run only).
 *
 * Architecture: Strategy C from council-20260502-185738. The autopilot is a
 * standalone Bun process that orchestrates the council + (in PR9) spawns
 * `claude -p` subprocesses to implement leaf goals.
 *
 * PR8 ships only the bootstrap path:
 *   1. Read user goal
 *   2. Invoke the council to decompose it into leaf goals + frozen test specs
 *   3. Invoke a synthesizer (`claude -p`) to pick the best decomposition
 *   4. Write goal files + spec files to disk
 *   5. Initialize state.json
 *   6. Generate AUTOPILOT.md
 *   7. Exit with summary — user can review specs before going live
 *
 * Live mode (PR9) adds the per-goal implementation loop, stuck detection,
 * rate-limit auto-pause-and-resume, clean-checkout verifier, and final review.
 *
 * NOT a council member; the autopilot DISPATCHES the council. This file
 * intentionally does not import from src/council.ts — it shells out to the
 * `bun run src/council.ts` CLI so the autopilot binary stays decoupled from
 * council internals. This means subprocess overhead per dispatch but
 * dramatically simpler ownership of state.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { resolve } from "path";
import {
  buildBootstrapPrompt,
  buildImplementationPrompt,
  buildSynthesizerPrompt,
  parseGoalsBlock,
  type DecompositionGoal,
  type PreviousIterationContext,
} from "./autopilot-prompts";
import { spawnImplementingClaude, getCurrentCommit } from "./autopilot-spawn";
import { verifyInWorktree, verifySpecSha, type VerifyResult } from "./autopilot-verifier";
import { installPreCommitHook, uninstallPreCommitHook } from "./autopilot-hook";
import {
  computeFailureSignature,
  detectStuck,
  getTreeHash,
  type FailureSignature,
  type StuckHistory,
  type StuckTrigger,
} from "./autopilot-stuck";
import { installSignalHandlers, readAndConsumeControl } from "./autopilot-control";
import {
  defaultState,
  fileHash,
  goalId,
  readState,
  writeState,
  type AutopilotState,
  type Goal,
} from "./autopilot-state";
import { renderAutopilotDoc } from "./autopilot-doc";
import {
  detectProfile,
  loadCustomProfile,
  listProfileIds,
  profileById,
  type ProjectProfile,
} from "./autopilot-profile";

interface CliArgs {
  goalFile: string;
  repoRoot: string;
  dryRun: boolean;     // default true
  live: boolean;        // explicit --live; overrides dry_run
  resume: boolean;      // future: resume from saved state
  reset: boolean;       // wipe .autopilot/ and start fresh
  councilBin?: string;  // override council binary (for testing)
  profileId?: string;   // --profile <id> override; auto-detect if absent
  profileFile?: string; // --profile-file <path> custom profile JSON
}

function parseArgs(argv: string[]): CliArgs {
  let goalFile = "";
  let repoRoot = process.cwd();
  let dryRun = true;
  let live = false;
  let resume = false;
  let reset = false;
  let councilBin: string | undefined;
  let profileId: string | undefined;
  let profileFile: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--goal" || a === "-g") goalFile = argv[++i];
    else if (a === "--repo" || a === "-r") repoRoot = resolve(argv[++i]);
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--live") {
      live = true;
      dryRun = false;
    }
    else if (a === "--resume") resume = true;
    else if (a === "--reset") reset = true;
    else if (a === "--council-bin") councilBin = argv[++i];
    else if (a === "--profile") profileId = argv[++i];
    else if (a === "--profile-file") profileFile = argv[++i];
    else if (a === "--help" || a === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  if (!goalFile && !resume) {
    console.error("Error: --goal <path> required (or --resume to continue an existing run)");
    printHelp();
    process.exit(1);
  }

  return { goalFile, repoRoot, dryRun, live, resume, reset, councilBin, profileId, profileFile };
}

function printHelp(): void {
  console.error(`autopilot — autonomous-loop orchestrator built on top of agent-council

Decomposes a user-supplied goal into testable leaf goals via a multi-agent
council, writes frozen test specs in the project's native test format, and
(in live mode — not yet shipping) spawns fresh \`claude -p\` subprocesses to
implement each leaf against its spec.

USAGE

  autopilot --goal <goal.md> [options]

OPTIONS

  --goal, -g <path>        User-supplied goal markdown file (required unless --resume)
  --repo, -r <path>        Repo root (default: cwd)
  --dry-run                Bootstrap only — decompose, write specs, exit (DEFAULT)
  --live                   Bootstrap + run the live implementation loop. Spawns
                           fresh \`claude -p\` per leaf goal until verifier passes
                           or iteration cap (30) hit. Pre-commit hook installed.
  --resume                 Continue an existing run from .autopilot/state.json.
                           Honors paused_until if rate-limited; exits 75 if
                           still inside the pause window so a scheduler can retry.
  --reset                  Wipe .autopilot/ and start fresh
  --council-bin <path>     Override path to council binary (default: autodetect)
  --profile <id>           Override project profile (default: auto-detect from manifest files)
                           Built-in: ${listProfileIds().join(", ")}
  --profile-file <path>    Load a custom profile from JSON (for stacks not covered above)
  --help, -h               Show this help

PROJECT PROFILE AUTO-DETECTION

  pyproject.toml + poetry        → python-poetry        (poetry run pytest)
  pyproject.toml / setup.py      → python-pytest        (pytest)
  package.json + bun             → typescript-bun       (bun test)
  package.json + vitest          → typescript-node      (npx vitest run)
  package.json + jest            → typescript-jest      (npx jest)
  go.mod                         → go                   (go test)
  Cargo.toml                     → rust                 (cargo test)
  Gemfile + rspec                → ruby-rspec           (bundle exec rspec)
  (none of the above)            → generic              (manual config required)

  Override with --profile <id> or --profile-file <custom.json>.

FILES WRITTEN

  <repo>/.autopilot/state.json          Orchestrator state (compaction-survivable, gitignored)
  <repo>/.autopilot/AUTOPILOT.md         Project context (regenerated each spawn in live mode)
  <repo>/.autopilot/goals/g<N>.md        Per-leaf goal files (frozen at decomposition)
  <repo>/.autopilot/notes/g<N>-*.md      Failure notes (live mode only)
  <repo>/.council/specs/g<N>.<ext>       Frozen test specs in the project's native format
                                          (.test.ts for TS, test_*.py for Python, *_test.go for
                                          Go, *_test.rs for Rust, *_spec.rb for Ruby)

EXAMPLES

  # Bootstrap a TypeScript+Bun project (auto-detected from package.json + bun.lock)
  autopilot --goal goal.md

  # Bootstrap a Python+Poetry project (auto-detected from pyproject.toml [tool.poetry])
  autopilot --goal goal.md --repo /path/to/python-project

  # Force a specific profile (override auto-detect)
  autopilot --goal goal.md --profile python-pytest

  # Use a custom profile (e.g. Elixir+Mix)
  autopilot --goal goal.md --profile-file ./elixir-mix.json

  # Wipe and re-bootstrap with a new goal
  autopilot --goal goal.md --reset

WORKFLOW (DRY-RUN)

  1. You write goal.md describing what you want built (see goal-template.md).
  2. autopilot detects the project profile (or you pass --profile).
  3. autopilot dispatches the council (3 agents in parallel, max-effort) to
     decompose the goal into 3-8 leaf goals + frozen test specs in the
     project's native test framework.
  4. A synthesizer pass picks the best decomposition and writes:
       - .autopilot/goals/g<N>.md   (one file per leaf goal)
       - .council/specs/g<N>.<ext>  (frozen test specs — DO NOT EDIT)
       - .autopilot/state.json      (orchestrator state)
       - .autopilot/AUTOPILOT.md    (project context for spawned subprocesses)
  5. autopilot prints a summary and exits.
  6. You review the specs. If they're wrong: --reset and rephrase the goal.
     If they're right: (live mode, future PR) re-run with --live.

LEARN MORE

  docs/autopilot.md     — full guide, architecture, fake-progress defenses
  docs/profiles.md      — profile system, supported architectures, custom profiles
  README.md             — project overview, install
  CLAUDE.md             — architecture notes for AI assistants
`);
}

/**
 * Locate the council binary. Same probing logic as the SKILL.md files.
 */
function locateCouncilBin(override?: string): string {
  if (override) return override;
  const candidates = [
    `${process.env.HOME}/.claude/skills/agent-council/bin/council`,
    `${process.env.HOME}/.claude/skills/agent-council/council`,
    `${process.env.HOME}/.agents/skills/agent-council/bin/council`,
    `${process.env.HOME}/.gemini/skills/agent-council/bin/council`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fall back to a relative path (works when run from inside the repo)
  const repoLocal = resolve(process.cwd(), "bin/council");
  if (existsSync(repoLocal)) return repoLocal;
  throw new Error(
    "Could not locate the agent-council binary. Pass --council-bin <path> or " +
    "ensure agent-council is installed at one of the standard skill paths."
  );
}

/**
 * Resolve the active project profile from CLI args. Priority:
 *   1. --profile-file <path>: load custom JSON profile
 *   2. --profile <id>: pick a built-in by id (errors if unknown)
 *   3. auto-detect from manifest files in repo root
 *
 * Returns the chosen profile; never null (falls back to generic if nothing matches).
 */
function resolveProfile(args: CliArgs): ProjectProfile {
  if (args.profileFile) {
    const profile = loadCustomProfile(resolve(args.profileFile));
    console.error(`[autopilot] Loaded custom profile from ${args.profileFile}: ${profile.display_name}`);
    return profile;
  }
  if (args.profileId) {
    const profile = profileById(args.profileId);
    if (!profile) {
      throw new Error(
        `Unknown profile id: "${args.profileId}". Built-in: ${listProfileIds().join(", ")}. ` +
        `Use --profile-file <path> to load a custom profile.`
      );
    }
    console.error(`[autopilot] Using --profile override: ${profile.display_name}`);
    return profile;
  }
  const detected = detectProfile(args.repoRoot);
  if (detected.id === "generic") {
    console.error(
      `[autopilot] WARNING: no project type detected at ${args.repoRoot}. Falling back to ` +
      `generic profile. The bootstrap council will be told the runner is not configured. ` +
      `Use --profile <id> or --profile-file <path> to fix.`
    );
  } else {
    console.error(`[autopilot] Auto-detected project profile: ${detected.display_name}`);
  }
  return detected;
}

/**
 * Dispatch the bootstrap council to decompose the user goal. Returns the
 * council session directory containing opinion_*.json files.
 */
async function dispatchBootstrapCouncil(args: {
  councilBin: string;
  question: string;
  repoRoot: string;
}): Promise<string> {
  // Council expects a question file; write it to a temp path so it survives
  // the council subprocess exit.
  const qPath = resolve(args.repoRoot, ".autopilot", ".bootstrap-question.tmp.md");
  mkdirSync(resolve(args.repoRoot, ".autopilot"), { recursive: true });
  writeFileSync(qPath, args.question, "utf-8");

  console.error("[autopilot] Dispatching bootstrap council (3 agents, max-effort)...");
  const proc = Bun.spawn([
    "bun", "run", args.councilBin,
    "--question-file", qPath,
    "--project", "autopilot",
    "--skip-preflight",
  ], {
    stdout: "pipe",
    stderr: "inherit",  // let the user see the heartbeat live
    cwd: args.repoRoot,
  });
  const stdoutText = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`bootstrap council exited with code ${exitCode}`);
  }
  // The council's last stdout line is the session directory path
  const lines = stdoutText.trim().split("\n").filter((l) => l.trim());
  const sessionDir = lines[lines.length - 1].trim();
  if (!existsSync(sessionDir)) {
    throw new Error(`council returned non-existent session dir: ${sessionDir}`);
  }
  console.error(`[autopilot] Bootstrap council session: ${sessionDir}`);
  return sessionDir;
}

/**
 * Synthesize the council opinions into a final decomposition. Spawns a
 * fresh `claude -p` (not via the council) since the synthesizer needs to
 * read the opinion files and emit structured output, not deliberate.
 */
async function runSynthesizer(args: {
  sessionDir: string;
  repoRoot: string;
  profile: ProjectProfile;
}): Promise<DecompositionGoal[]> {
  const opinionFiles = ["claude", "codex", "gemini"]
    .map((id) => resolve(args.sessionDir, "stage1", `opinion_${id}.json`))
    .filter((p) => existsSync(p));
  if (opinionFiles.length === 0) {
    throw new Error(`no opinion files found in ${args.sessionDir}/stage1/`);
  }

  const prompt = buildSynthesizerPrompt(opinionFiles, args.profile);
  console.error(`[autopilot] Synthesizing decomposition from ${opinionFiles.length} opinions...`);

  // Use claude -p to read the opinion files and emit the chosen GOALS block.
  // --add-dir grants read access to the council session directory.
  const proc = Bun.spawn([
    "claude", "-p", prompt,
    "--effort", "max",
    "--output-format", "json",
    "--add-dir", args.sessionDir,
  ], {
    stdout: "pipe",
    stderr: "inherit",
    cwd: args.repoRoot,
  });
  const stdoutText = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`synthesizer exited with code ${exitCode}`);
  }

  // Claude -p in --output-format json returns { result: "...", ... }
  let synthText: string;
  try {
    const parsed = JSON.parse(stdoutText);
    synthText = parsed.result || "";
  } catch {
    // Fall back to raw stdout in case format changed
    synthText = stdoutText;
  }

  if (synthText.includes("===NO_VIABLE_DECOMPOSITION===")) {
    console.error("[autopilot] Synthesizer rejected all three decompositions:");
    console.error(synthText);
    throw new Error("no viable decomposition; user intervention required");
  }

  const goals = parseGoalsBlock(synthText);
  if (!goals) {
    console.error("[autopilot] Synthesizer output:");
    console.error(synthText.slice(0, 2000));
    throw new Error(
      "could not parse ===GOALS===...===END=== block from synthesizer output. " +
      "The synthesizer is supposed to emit verbatim JSON; it didn't."
    );
  }
  console.error(`[autopilot] Synthesizer picked decomposition with ${goals.length} leaf goals.`);
  return goals;
}

/**
 * Write goal files and spec files to disk. Returns the populated Goal records
 * with computed spec_sha values for tamper detection.
 */
async function writeGoalArtifacts(args: {
  repoRoot: string;
  decomposition: DecompositionGoal[];
  profile: ProjectProfile;
}): Promise<Goal[]> {
  const goalsDir = resolve(args.repoRoot, ".autopilot", "goals");
  const specsDir = resolve(args.repoRoot, ".council", "specs");
  mkdirSync(goalsDir, { recursive: true });
  mkdirSync(specsDir, { recursive: true });

  const goals: Goal[] = [];
  for (let i = 0; i < args.decomposition.length; i++) {
    const d = args.decomposition[i];
    const id = goalId(i);
    if (d.id !== id) {
      throw new Error(`decomposition has out-of-order id: expected ${id}, got ${d.id}`);
    }
    const goalPath = resolve(goalsDir, `${id}.md`);
    const specFilename = args.profile.spec_filename(id);
    const specPath = resolve(specsDir, specFilename);
    const specRelPath = `.council/specs/${specFilename}`;
    const verifyCmd = args.profile.spec_test_command(specRelPath);

    const goalDoc = `# ${id}: ${d.title}

${d.description}

## Acceptance

This goal is verified by the test spec at \`${specRelPath}\`. The spec is
FROZEN at decomposition time — the implementing session cannot edit it.
When \`${verifyCmd}\` exits 0, the goal is done.

Project profile: **${args.profile.display_name}** (${args.profile.language})
Test framework: ${args.profile.test_framework}
`;

    writeFileSync(goalPath, goalDoc, "utf-8");
    writeFileSync(specPath, d.spec_content, "utf-8");

    const sha = await fileHash(specPath);
    goals.push({
      id,
      title: d.title,
      description: d.description,
      spec_file: specRelPath,
      spec_sha: sha,
      status: "pending",
      green_commit: null,
      iteration: 0,
      last_test_hash: null,
      tracked_tree_hash: null,
      stuck_rescues_used: 0,
      failure_reason: null,
      notes_file: null,
    });
  }
  return goals;
}

async function bootstrap(args: CliArgs): Promise<void> {
  const autopilotDir = resolve(args.repoRoot, ".autopilot");

  if (args.reset && existsSync(autopilotDir)) {
    console.error(`[autopilot] --reset: wiping ${autopilotDir}`);
    const { rmSync } = await import("fs");
    rmSync(autopilotDir, { recursive: true, force: true });
    // Also uninstall the pre-commit hook IF we authored it (idempotent: leaves
    // user-authored hooks untouched).
    const hookResult = uninstallPreCommitHook(args.repoRoot);
    if (hookResult === "removed") {
      console.error(`[autopilot] --reset: removed autopilot pre-commit hook`);
    }
  }

  const existing = readState(autopilotDir);
  if (existing && !args.reset) {
    console.error(
      `[autopilot] Existing state found at ${resolve(autopilotDir, "state.json")}. ` +
      `Use --reset to start fresh, or --resume (PR9) to continue.`
    );
    process.exit(1);
  }

  if (!existsSync(args.goalFile)) {
    console.error(`[autopilot] goal file not found: ${args.goalFile}`);
    process.exit(1);
  }
  const userGoalText = readFileSync(args.goalFile, "utf-8");

  // 0. Resolve project profile (auto-detect or CLI override). Determines
  //    the spec format the bootstrap council will produce.
  const profile = resolveProfile(args);

  // 1. Bootstrap council (profile-aware prompt — language, test framework,
  //    verify command all baked in)
  const councilBin = locateCouncilBin(args.councilBin);
  const question = buildBootstrapPrompt(userGoalText, profile);
  const sessionDir = await dispatchBootstrapCouncil({
    councilBin,
    question,
    repoRoot: args.repoRoot,
  });

  // 2. Synthesize decomposition (profile-aware so the synthesizer judges specs
  //    against the right language/framework — not a hardcoded TypeScript bias)
  const decomposition = await runSynthesizer({
    sessionDir,
    repoRoot: args.repoRoot,
    profile,
  });

  // 3. Write goal artifacts (per-profile filenames + verify commands)
  const goals = await writeGoalArtifacts({
    repoRoot: args.repoRoot,
    decomposition,
    profile,
  });

  // 4. Initialize state
  const state: AutopilotState = {
    ...defaultState(args.goalFile, args.dryRun),
    plan_session: sessionDir.split("/").pop() || null,
    queue: goals.map((g) => g.id),
    goals,
  };
  await writeState(autopilotDir, state);

  // 5. Generate AUTOPILOT.md (regenerated per-spawn in live mode)
  const docPath = resolve(autopilotDir, "AUTOPILOT.md");
  const doc = renderAutopilotDoc({
    state,
    userGoalText,
    currentGoalId: null,  // dry-run: nothing in flight
    profile,
  });
  writeFileSync(docPath, doc, "utf-8");

  // 6. Print summary
  console.error("");
  console.error("[autopilot] Bootstrap complete.");
  console.error(`  Goal: ${args.goalFile}`);
  console.error(`  Decomposed into ${goals.length} leaf goals:`);
  for (const g of goals) {
    console.error(`    ${g.id}: ${g.title}`);
  }
  console.error("");
  console.error(`  Goal files:    ${resolve(autopilotDir, "goals")}/g*.md`);
  // Use the profile's spec_filename to render an accurate glob pattern
  // (e.g. test_g*.py for Python, g*_test.go for Go, g*.test.ts for TypeScript).
  const specGlob = profile.spec_filename("g*");
  console.error(`  Test specs:    ${resolve(args.repoRoot, ".council", "specs")}/${specGlob}`);
  console.error(`  State:         ${resolve(autopilotDir, "state.json")}`);
  console.error(`  Project doc:   ${docPath}`);
  console.error("");
  if (args.dryRun) {
    console.error("Dry-run mode. Review the specs before running with --live.");
    console.error("Live mode (implementation loop) will ship in a future PR.");
  }
}

/* ============================================================
 * Live mode (PR9.1) — implementation loop with worktree verifier
 * ============================================================
 *
 * From council-20260502-205303 fork picks: 1B (multiple short claude -p per
 * iteration), 2A (worktree-based verifier). Stuck detection (3C), rate-limit
 * pause (5B), and final-review veto (4A) ship in PR9.2 / PR9.3 / PR9.4.
 */

const LIVE_MAX_ITERATIONS_PER_GOAL = 30;

/** Exit codes the orchestrator emits when live mode terminates non-normally. */
const EX_TEMPFAIL = 75;     // sysexits — temporary failure (rate-limited; resume later)
const EX_USER_PAUSE = 130;  // SIGINT-like — user explicitly paused

interface LiveResult {
  status: "all_done" | "all_failed" | "partial" | "rate_limited" | "user_paused";
  completed: string[];
  failed: string[];
  pausedUntil?: string;
}

async function runLiveMode(args: {
  state: AutopilotState;
  autopilotDir: string;
  repoRoot: string;
  profile: ProjectProfile;
  userGoalText: string;
  /** Council binary path. Auto-detected by caller; passed through for testability. */
  councilBin: string;
}): Promise<LiveResult> {
  // PR9.3: install SIGINT/SIGTERM handlers for clean ctrl-C
  const signalReceived = installSignalHandlers();

  // Install the pre-commit hook (load-bearing frozen-spec defense).
  const hookResult = installPreCommitHook(args.repoRoot);
  if (hookResult === "no-git") {
    console.error("[autopilot] WARNING: target repo has no .git/hooks/ — pre-commit hook NOT installed.");
    console.error("[autopilot] Frozen-spec defense is degraded. Implementing claude could edit specs without rejection.");
  } else if (hookResult === "preserved") {
    console.error("[autopilot] WARNING: existing pre-commit hook found that we did not author — left untouched.");
    console.error("[autopilot] Frozen-spec defense is degraded. Add the autopilot's hook content manually if you want it.");
  } else {
    console.error(`[autopilot] Pre-commit hook ${hookResult} (frozen-spec defense active).`);
  }

  // Process goals in queue order. Each goal: spawn-verify-loop until green
  // or iteration cap.
  while (args.state.queue.length > 0) {
    // PR9.3: check for user-issued control commands (.autopilot/control.json)
    // and OS signals BEFORE starting each goal. Acting at goal boundaries is
    // safer than mid-iteration (state is consistent; nothing in flight).
    const userInterrupt = checkUserInterrupt(args.autopilotDir, signalReceived);
    if (userInterrupt) {
      console.error(`[autopilot] user interrupt: ${userInterrupt.kind} (${userInterrupt.reason ?? "no reason given"})`);
      args.state.paused_reason = "user_pause";
      args.state.paused_until = null;  // user-paused has no auto-resume time
      await writeState(args.autopilotDir, args.state);
      return { status: "user_paused", completed: args.state.completed, failed: args.state.failed };
    }

    const goalId = args.state.queue[0];
    const goal = args.state.goals.find((g) => g.id === goalId);
    if (!goal) {
      console.error(`[autopilot] internal error: queue references missing goal ${goalId}; skipping`);
      args.state.queue.shift();
      await writeState(args.autopilotDir, args.state);
      continue;
    }

    console.error("");
    console.error(`[autopilot] === ${goal.id}: ${goal.title} ===`);
    console.error(`[autopilot]   spec_file:   ${goal.spec_file}`);
    console.error(`[autopilot]   verify cmd:  ${args.profile.spec_test_command(goal.spec_file)}`);

    const result = await runLeafGoal({
      goal,
      state: args.state,
      autopilotDir: args.autopilotDir,
      repoRoot: args.repoRoot,
      profile: args.profile,
      userGoalText: args.userGoalText,
      councilBin: args.councilBin,
    });

    if (result === "rate_limited") {
      console.error(`[autopilot] rate-limited mid-goal ${goal.id}. Saving state and exiting.`);
      console.error(`[autopilot] Resume with: bun run bin/autopilot --resume --repo ${args.repoRoot}`);
      return {
        status: "rate_limited",
        completed: args.state.completed,
        failed: args.state.failed,
        pausedUntil: args.state.paused_until ?? undefined,
      };
    }

    // Goal terminal state: done OR failed. Pop from queue, update lists.
    args.state.queue.shift();
    if (goal.status === "done") {
      args.state.completed.push(goal.id);
      console.error(`[autopilot] ✓ ${goal.id} done at commit ${goal.green_commit?.slice(0, 8)} after ${goal.iteration} iteration(s)`);
    } else {
      args.state.failed.push(goal.id);
      console.error(`[autopilot] ✗ ${goal.id} failed: ${goal.failure_reason}`);
    }
    args.state.current_goal_id = null;
    args.state.last_progress_at = new Date().toISOString();
    await writeState(args.autopilotDir, args.state);
  }

  // All goals processed.
  if (args.state.failed.length === 0) {
    return { status: "all_done", completed: args.state.completed, failed: [] };
  }
  if (args.state.completed.length === 0) {
    return { status: "all_failed", completed: [], failed: args.state.failed };
  }
  return { status: "partial", completed: args.state.completed, failed: args.state.failed };
}

/**
 * Run one leaf goal to terminal state (done | failed | rate_limited).
 *
 * Per Fork 1B: orchestrator owns the iteration boundary. Each iteration is a
 * fresh `claude -p` spawn with the previous iteration's verifier output baked
 * into the prompt. After spawn exits, run verifier in clean worktree; if green,
 * mark done and return; if red, loop. Hard cap at LIVE_MAX_ITERATIONS_PER_GOAL.
 */
async function runLeafGoal(args: {
  goal: Goal;
  state: AutopilotState;
  autopilotDir: string;
  repoRoot: string;
  profile: ProjectProfile;
  userGoalText: string;
  /** Council binary for stuck-rescue dispatches (PR9.2). */
  councilBin: string;
}): Promise<"done" | "failed" | "rate_limited"> {
  args.goal.status = "in_progress";
  args.state.current_goal_id = args.goal.id;
  await writeState(args.autopilotDir, args.state);

  let previous: PreviousIterationContext | null = null;
  // Per-goal stuck-detection history (PR9.2 — Fork 3C).
  const history: StuckHistory = {
    signatures: [],
    treeHashes: [],
    lastGreenAt: args.state.last_progress_at,  // start counting from last orchestrator-level progress
  };

  while (args.goal.iteration < LIVE_MAX_ITERATIONS_PER_GOAL) {
    args.goal.iteration += 1;
    console.error(`[autopilot]   iteration ${args.goal.iteration}/${LIVE_MAX_ITERATIONS_PER_GOAL}`);

    // Regenerate AUTOPILOT.md with current state (per-spawn freshness).
    const docPath = resolve(args.autopilotDir, "AUTOPILOT.md");
    writeFileSync(docPath, renderAutopilotDoc({
      state: args.state,
      userGoalText: args.userGoalText,
      currentGoalId: args.goal.id,
      profile: args.profile,
    }), "utf-8");

    // Spawn fresh claude -p with the per-iteration contract.
    const prompt = buildImplementationPrompt({
      goal: args.goal,
      autopilotDocPath: ".autopilot/AUTOPILOT.md",
      goalFilePath: `.autopilot/goals/${args.goal.id}.md`,
      specFilePath: args.goal.spec_file,
      verifyCommand: args.profile.spec_test_command(args.goal.spec_file),
      maxIterations: LIVE_MAX_ITERATIONS_PER_GOAL,
      previous,
    });

    const spawn = await spawnImplementingClaude({
      prompt,
      repoRoot: args.repoRoot,
      profile: args.profile,
    });

    if (spawn.rateLimit.isRateLimited) {
      console.error(`[autopilot]     ⏸ rate-limited (${spawn.rateLimit.window}); resets ${spawn.rateLimit.resetsAt ?? "(unknown)"}`);
      args.state.paused_until = spawn.rateLimit.resetsAt;
      args.state.paused_reason = "rate_limit";
      await writeState(args.autopilotDir, args.state);
      return "rate_limited";
    }
    if (spawn.exitCode !== 0) {
      console.error(`[autopilot]     ⚠ claude -p exited ${spawn.exitCode} (continuing — verifier is the source of truth)`);
    }

    // Defense in depth: spec_sha must match (catches any pre-commit-hook bypass).
    const specCheck = await verifySpecSha({
      repoRoot: args.repoRoot,
      specPath: args.goal.spec_file,
      expectedSha: args.goal.spec_sha,
    });
    if (!specCheck.matches) {
      args.goal.status = "failed";
      args.goal.failure_reason = `Spec tampered (expected sha ${args.goal.spec_sha.slice(0, 12)}, got ${specCheck.actualSha.slice(0, 12)}). Frozen-spec defense violated.`;
      await writeState(args.autopilotDir, args.state);
      return "failed";
    }

    // Run verifier in clean worktree (no API keys, isolated FS).
    const verify = await verifyInWorktree({
      repoRoot: args.repoRoot,
      commit: undefined,  // HEAD
      specPath: args.goal.spec_file,
      profile: args.profile,
    });
    args.goal.last_test_hash = `exit=${verify.exitCode}|stdout_len=${verify.stdout.length}`;

    if (verify.passed) {
      const commit = await getCurrentCommit(args.repoRoot);
      args.goal.status = "done";
      args.goal.green_commit = commit;
      args.state.last_green_commit = commit;
      console.error(`[autopilot]     ✓ verifier passed (${verify.durationMs}ms) at ${commit?.slice(0, 8)}`);
      await writeState(args.autopilotDir, args.state);
      return "done";
    }

    console.error(`[autopilot]     ✗ verifier failed (exit ${verify.exitCode}, ${verify.durationMs}ms); checking stuck heuristic`);
    previous = {
      iteration: args.goal.iteration,
      failingTestsOutput: verify.stdout,
      verifierStderr: verify.stderr,
      verifierExitCode: verify.exitCode,
    };

    // PR9.2: Stuck detection (Fork 3C — weighted heuristic).
    history.signatures.push(computeFailureSignature(verify, args.profile));
    history.treeHashes.push(await getTreeHash(args.repoRoot));
    args.goal.last_test_hash = history.signatures[history.signatures.length - 1].normalizedOutputHash;

    const stuck = detectStuck(history);
    if (stuck.stuck) {
      console.error(`[autopilot]     ⚠ STUCK detected: ${stuck.reason}`);
      const rescueOutcome = await runStuckRescue({
        goal: args.goal,
        state: args.state,
        autopilotDir: args.autopilotDir,
        repoRoot: args.repoRoot,
        profile: args.profile,
        userGoalText: args.userGoalText,
        councilBin: args.councilBin,
        trigger: stuck,
        history,
        latestVerify: verify,
      });
      if (rescueOutcome === "rescued") {
        // Council provided guidance; reset stuck history (one rescue per goal).
        // The rescue notes are already in .autopilot/notes/<id>-rescue.md;
        // the implementing claude will read them via AUTOPILOT.md context.
        history.signatures = [];
        history.treeHashes = [];
        history.lastGreenAt = new Date().toISOString();
        console.error(`[autopilot]     ↪ rescue council guidance written; continuing with reset stuck history`);
      } else {
        // Rescue exhausted (already used 1) OR rescue council itself failed.
        // Roll back to last_green_commit and mark failed.
        if (args.state.last_green_commit) {
          console.error(`[autopilot]     ↩ rolling back to last green commit ${args.state.last_green_commit.slice(0, 8)}`);
          await rollbackToCommit(args.repoRoot, args.state.last_green_commit);
        }
        args.goal.status = "failed";
        args.goal.failure_reason = `stuck (${stuck.reason}); rescue council exhausted; rolled back to ${args.state.last_green_commit?.slice(0, 8) ?? "(no green commit)"}`;
        await appendFailedGoalsLog(args.repoRoot, args.goal, args.goal.failure_reason);
        await writeState(args.autopilotDir, args.state);
        return "failed";
      }
    }
    await writeState(args.autopilotDir, args.state);  // persist iteration count
  }

  // Iteration cap exhausted (no rescue triggered earlier). Roll back + fail.
  if (args.state.last_green_commit) {
    console.error(`[autopilot]     ↩ iteration cap; rolling back to last green ${args.state.last_green_commit.slice(0, 8)}`);
    await rollbackToCommit(args.repoRoot, args.state.last_green_commit);
  }
  args.goal.status = "failed";
  args.goal.failure_reason = `iteration cap (${LIVE_MAX_ITERATIONS_PER_GOAL}) reached without verifier passing`;
  await appendFailedGoalsLog(args.repoRoot, args.goal, args.goal.failure_reason);
  await writeState(args.autopilotDir, args.state);
  return "failed";
}

/* ============================================================
 * Stuck rescue council (PR9.2)
 * ============================================================
 *
 * Fork 3C policy: ONE rescue council per goal. If rescue produces
 * concrete guidance, write it to .autopilot/notes/<id>-rescue.md and
 * let the implementing claude continue. If rescue is already used, OR
 * the council itself fails, roll back to last_green_commit, mark goal
 * failed, append to FAILED_GOALS.md, advance.
 */

async function runStuckRescue(args: {
  goal: Goal;
  state: AutopilotState;
  autopilotDir: string;
  repoRoot: string;
  profile: ProjectProfile;
  userGoalText: string;
  councilBin: string;
  trigger: StuckTrigger;
  history: StuckHistory;
  latestVerify: VerifyResult;
}): Promise<"rescued" | "exhausted"> {
  if (args.goal.stuck_rescues_used >= 1) {
    console.error(`[autopilot]     stuck-rescue already used for ${args.goal.id}; not retrying`);
    return "exhausted";
  }
  args.goal.stuck_rescues_used += 1;
  await writeState(args.autopilotDir, args.state);

  // Build rescue prompt: facts, what's failed, what to recommend.
  const triggerStr = !args.trigger.stuck ? "(not stuck — internal bug)" :
    args.trigger.reason === "same_failure_with_git_advance" ? `Same failure across ${args.trigger.iterations} iterations while git advanced.` :
    args.trigger.reason === "no_green_for_30min" ? `${args.trigger.minutesElapsed} minutes without a red→green transition.` :
    "Tree hash unchanged across 3 cycles (claude not making commits).";
  const lastSig = args.history.signatures[args.history.signatures.length - 1];
  const failingIdsList = lastSig.failingTestIds.length > 0
    ? lastSig.failingTestIds.slice(0, 10).map((s) => `  - ${s}`).join("\n")
    : "(no extractable failing test ids; output may be malformed)";

  const goalFile = resolve(args.autopilotDir, "goals", `${args.goal.id}.md`);
  const specFile = resolve(args.repoRoot, args.goal.spec_file);
  const rescuePrompt = `The autopilot is stuck on a leaf goal. Help unblock it with concrete
guidance — but do NOT propose changes to the frozen test spec. Specs are
contract; the implementing claude must satisfy them, not edit them.

# Stuck-rescue context

Goal id: ${args.goal.id}
Goal title: ${args.goal.title}
Iterations attempted: ${args.goal.iteration}
Stuck trigger: ${args.trigger.stuck ? args.trigger.reason : "(unknown)"}
Trigger detail: ${triggerStr}

Project profile: ${args.profile.display_name} (${args.profile.language})
Verify command: ${args.profile.spec_test_command(args.goal.spec_file)}

# Files relevant to this goal

  - ${goalFile} (the leaf goal description)
  - ${specFile} (FROZEN spec — do NOT propose edits to this)
  - The implementing claude has full repo write access EXCEPT \`.council/specs/\`

# Latest failing test output (verbatim, possibly truncated)

\`\`\`
${args.latestVerify.stdout.slice(0, 4000)}
${args.latestVerify.stderr.length > 0 ? "\nstderr:\n" + args.latestVerify.stderr.slice(0, 1500) : ""}
\`\`\`

Failing test ids (last iteration):
${failingIdsList}

# What to produce

1. Diagnose the most likely root cause — be SPECIFIC, cite file/line if you can.
2. Recommend ONE next action the implementing claude should try. Concrete.
   Not "consider X" — pick one.
3. If you believe the spec itself is broken (genuinely impossible to satisfy
   without spec changes), say so EXPLICITLY at the top: "SPEC IS BROKEN: ..."
   The autopilot will fail the goal cleanly in that case.

Each council member: produce a short (150-300 word) diagnosis + recommendation.
The chairman picks the single best one. The implementing claude reads the
chairman's recommendation and uses it as guidance for the next iteration.

Do NOT propose making the test pass by changing the test. The pre-commit
hook rejects spec edits. If the spec is wrong, say "SPEC IS BROKEN".
`;

  // Dispatch to the council
  const sessionDir = await dispatchBootstrapCouncil({
    councilBin: args.councilBin,
    question: rescuePrompt,
    repoRoot: args.repoRoot,
  }).catch((e) => {
    console.error(`[autopilot]     rescue council dispatch failed: ${e.message}`);
    return null;
  });
  if (!sessionDir) return "exhausted";

  // Lightweight synthesis: pick the longest opinion as a stand-in for
  // chairman synthesis. The dedicated synthesizer (used in bootstrap) is
  // overkill here — the rescue is advisory, not contract-bearing.
  const stage1 = resolve(sessionDir, "stage1");
  if (!existsSync(stage1)) return "exhausted";
  let bestOpinion = "";
  for (const id of ["claude", "codex", "gemini"]) {
    const path = resolve(stage1, `opinion_${id}.json`);
    if (!existsSync(path)) continue;
    try {
      const op = JSON.parse(readFileSync(path, "utf-8"));
      if (op.status !== "ok" || typeof op.response !== "string") continue;
      if (op.response.length > bestOpinion.length) bestOpinion = op.response;
    } catch {}
  }
  if (!bestOpinion) return "exhausted";

  // SPEC-broken short-circuit: the council can flag this explicitly.
  if (/SPEC IS BROKEN/i.test(bestOpinion)) {
    console.error(`[autopilot]     rescue council says SPEC IS BROKEN; failing goal cleanly`);
    args.goal.failure_reason = `rescue council declared spec broken: ${bestOpinion.slice(0, 300)}`;
    return "exhausted";
  }

  // Write rescue notes for the implementing claude to read via AUTOPILOT.md.
  const notesDir = resolve(args.autopilotDir, "notes");
  mkdirSync(notesDir, { recursive: true });
  const notesPath = resolve(notesDir, `${args.goal.id}-rescue.md`);
  const notesContent = `# Stuck-rescue council guidance for ${args.goal.id}

The implementing claude got stuck on this goal. The orchestrator dispatched
a rescue council; the chairman's guidance is below. Read it before your next
iteration.

**Stuck trigger:** ${args.trigger.stuck ? args.trigger.reason : "(unknown)"}
**Iterations attempted:** ${args.goal.iteration}
**Failing test ids (last iteration):**
${failingIdsList}

---

${bestOpinion}

---

This is ADVISORY — you are still the implementer. The spec is still frozen.
If you've tried the suggestion and it doesn't work, append your reasoning to
\`.autopilot/notes/${args.goal.id}-attempts.md\` and exit.
`;
  writeFileSync(notesPath, notesContent, "utf-8");
  args.goal.notes_file = `.autopilot/notes/${args.goal.id}-rescue.md`;
  await writeState(args.autopilotDir, args.state);

  console.error(`[autopilot]     rescue notes written: ${notesPath}`);
  return "rescued";
}

/**
 * Check both interruption mechanisms (PR9.3): control.json file and OS
 * signals. Returns the source of interruption if any.
 *
 * Polling is at goal boundaries (not mid-iteration) so state is always
 * consistent at the point we'd save and exit.
 */
function checkUserInterrupt(
  autopilotDir: string,
  signalReceived: () => "SIGINT" | "SIGTERM" | null
): { kind: string; reason?: string } | null {
  // Check OS signals first (cheaper)
  const sig = signalReceived();
  if (sig) return { kind: `os-signal:${sig}`, reason: "user pressed ctrl-C or sent kill" };

  // Check control.json
  const control = readAndConsumeControl(autopilotDir);
  if (control) {
    return { kind: `control:${control.command}`, reason: control.reason };
  }
  return null;
}

async function rollbackToCommit(repoRoot: string, commit: string): Promise<void> {
  try {
    await Bun.spawn(["git", "reset", "--hard", commit], {
      cwd: repoRoot,
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  } catch (e: any) {
    console.error(`[autopilot]     rollback failed: ${e.message}`);
  }
}

async function appendFailedGoalsLog(repoRoot: string, goal: Goal, reason: string): Promise<void> {
  const path = resolve(repoRoot, ".autopilot", "FAILED_GOALS.md");
  const entry = `## ${goal.id}: ${goal.title}\n\n` +
    `**Failed at:** ${new Date().toISOString()}\n` +
    `**Iterations:** ${goal.iteration}\n` +
    `**Reason:** ${reason}\n` +
    `**Spec:** \`${goal.spec_file}\`\n` +
    `**Notes:** ${goal.notes_file ? `\`${goal.notes_file}\`` : "(none)"}\n\n` +
    `---\n\n`;
  try {
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : "# Failed goals\n\n";
    writeFileSync(path, existing + entry, "utf-8");
  } catch {}
}

/**
 * --resume entry point. Reads existing state and continues where we left off.
 * Honors `paused_until` from a prior rate-limit; if still in the future, exits
 * with EX_TEMPFAIL and tells the user when to retry.
 */
async function runResume(args: CliArgs): Promise<LiveResult> {
  const autopilotDir = resolve(args.repoRoot, ".autopilot");
  const state = readState(autopilotDir);
  if (!state) {
    console.error(`[autopilot] no .autopilot/state.json at ${autopilotDir}; nothing to resume`);
    process.exit(1);
  }

  // Honor paused_until: if we're still inside the rate-limit window, exit and
  // tell the user (or scheduler) when to retry.
  if (state.paused_until) {
    const resumeAt = new Date(state.paused_until);
    const now = new Date();
    if (resumeAt > now) {
      const minsLeft = Math.ceil((resumeAt.getTime() - now.getTime()) / 60_000);
      console.error(`[autopilot] still paused (${state.paused_reason}); resume scheduled for ${state.paused_until} (~${minsLeft}min from now)`);
      console.error(`[autopilot] re-run --resume after that timestamp.`);
      process.exit(EX_TEMPFAIL);
    }
    console.error(`[autopilot] paused_until window passed; clearing pause and continuing`);
    state.paused_until = null;
    state.paused_reason = null;
    await writeState(autopilotDir, state);
  }

  // Resolve profile (honors --profile / --profile-file overrides; otherwise auto-detects).
  const profile = resolveProfile(args);

  // Load the original user goal text from the goal file referenced in state.
  const goalFilePath = state.goal_file;
  if (!existsSync(goalFilePath)) {
    console.error(`[autopilot] goal file referenced by state.json no longer exists: ${goalFilePath}`);
    console.error(`[autopilot] either restore the file or --reset and re-bootstrap`);
    process.exit(1);
  }
  const userGoalText = readFileSync(goalFilePath, "utf-8");

  const councilBin = locateCouncilBin(args.councilBin);
  return runLiveMode({ state, autopilotDir, repoRoot: args.repoRoot, profile, userGoalText, councilBin });
}

// Entry point. Don't run main() during test imports (matches council.ts pattern).
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // --resume takes precedence: load existing state, continue.
  if (args.resume) {
    const result = await runResume(args);
    if (result.status === "rate_limited") process.exit(EX_TEMPFAIL);
    if (result.status === "user_paused") process.exit(EX_USER_PAUSE);
    if (result.status === "all_failed") process.exit(1);
    return;
  }

  // Fresh run: bootstrap. If --live, then run live mode after bootstrap.
  await bootstrap(args);

  if (args.live) {
    const autopilotDir = resolve(args.repoRoot, ".autopilot");
    const state = readState(autopilotDir);
    if (!state) {
      console.error("[autopilot] internal error: state.json missing after bootstrap");
      process.exit(1);
    }
    const profile = resolveProfile(args);
    const userGoalText = readFileSync(state.goal_file, "utf-8");

    console.error("");
    console.error("[autopilot] === Entering live mode (PR9.1 — happy-path loop) ===");
    console.error("[autopilot] Stuck detection / final-review veto / rate-limit pause are happy-path-only.");
    console.error("[autopilot] PR9.2-9.4 will harden the orchestrator against those edge cases.");

    const liveCouncilBin = locateCouncilBin(args.councilBin);
    const result = await runLiveMode({ state, autopilotDir, repoRoot: args.repoRoot, profile, userGoalText, councilBin: liveCouncilBin });

    console.error("");
    console.error(`[autopilot] Live mode finished: ${result.status}`);
    console.error(`[autopilot]   completed: ${result.completed.length} (${result.completed.join(", ") || "(none)"})`);
    console.error(`[autopilot]   failed:    ${result.failed.length} (${result.failed.join(", ") || "(none)"})`);

    if (result.status === "rate_limited") process.exit(EX_TEMPFAIL);
    if (result.status === "all_failed") process.exit(1);
  }
}

// Run main() unless this file was imported by a test runner.
// Same pattern as src/council.ts — Bun.main is the entry point; tests import
// the file via "../src/autopilot" which still leaves Bun.main pointing at the
// test runner.
const _entryFile = Bun.main;
const _isTestImport = _entryFile.includes("bun-test") || _entryFile.includes("/tests/") || _entryFile.endsWith(".test.ts");
if (!_isTestImport) {
  main().catch((e) => {
    console.error(`[autopilot] FATAL: ${e.message}`);
    process.exit(1);
  });
}
