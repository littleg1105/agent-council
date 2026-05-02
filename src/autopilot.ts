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
  buildSynthesizerPrompt,
  parseGoalsBlock,
  type DecompositionGoal,
} from "./autopilot-prompts";
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

interface CliArgs {
  goalFile: string;
  repoRoot: string;
  dryRun: boolean;     // default true
  live: boolean;        // explicit --live; overrides dry_run
  resume: boolean;      // future: resume from saved state
  reset: boolean;       // wipe .autopilot/ and start fresh
  // councilBin is autodetected; override for testing
  councilBin?: string;
}

function parseArgs(argv: string[]): CliArgs {
  let goalFile = "";
  let repoRoot = process.cwd();
  let dryRun = true;
  let live = false;
  let resume = false;
  let reset = false;
  let councilBin: string | undefined;

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

  return { goalFile, repoRoot, dryRun, live, resume, reset, councilBin };
}

function printHelp(): void {
  console.error(`Usage: autopilot --goal <goal.md> [options]

Options:
  --goal, -g <path>        User-supplied goal markdown file
  --repo, -r <path>        Repo root (default: cwd)
  --dry-run                Bootstrap only — decompose, write specs, exit (default)
  --live                   Run the full implementation loop (PR9; not yet shipping)
  --resume                 Resume from existing .autopilot/state.json
  --reset                  Wipe .autopilot/ and start fresh
  --council-bin <path>     Override path to council binary (default: autodetect)
  --help, -h               Show this help

Files written under <repo>/.autopilot/:
  state.json               Orchestrator state (compaction-survivable)
  AUTOPILOT.md             Project context (regenerated each spawn)
  goals/g<N>.md            Per-leaf goal files (frozen at decomposition)
  notes/g<N>-attempts.md   Failure notes when a goal gets stuck (live mode only)

Files written under <repo>/.council/specs/:
  g<N>.test.ts             Frozen test specs (do not edit)
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
}): Promise<DecompositionGoal[]> {
  const opinionFiles = ["claude", "codex", "gemini"]
    .map((id) => resolve(args.sessionDir, "stage1", `opinion_${id}.json`))
    .filter((p) => existsSync(p));
  if (opinionFiles.length === 0) {
    throw new Error(`no opinion files found in ${args.sessionDir}/stage1/`);
  }

  const prompt = buildSynthesizerPrompt(opinionFiles);
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
    const specPath = resolve(specsDir, `${id}.test.ts`);

    const goalDoc = `# ${id}: ${d.title}

${d.description}

## Acceptance

This goal is verified by the test spec at \`.council/specs/${id}.test.ts\`. The
spec is FROZEN at decomposition time — the implementing session cannot edit
it. When \`bun test .council/specs/${id}.test.ts\` exits 0, the goal is done.
`;

    writeFileSync(goalPath, goalDoc, "utf-8");
    writeFileSync(specPath, d.spec_content, "utf-8");

    const sha = await fileHash(specPath);
    goals.push({
      id,
      title: d.title,
      description: d.description,
      spec_file: `.council/specs/${id}.test.ts`,
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

  // 1. Bootstrap council
  const councilBin = locateCouncilBin(args.councilBin);
  const question = buildBootstrapPrompt(userGoalText);
  const sessionDir = await dispatchBootstrapCouncil({
    councilBin,
    question,
    repoRoot: args.repoRoot,
  });

  // 2. Synthesize decomposition
  const decomposition = await runSynthesizer({
    sessionDir,
    repoRoot: args.repoRoot,
  });

  // 3. Write goal artifacts
  const goals = await writeGoalArtifacts({
    repoRoot: args.repoRoot,
    decomposition,
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
  console.error(`  Test specs:    ${resolve(args.repoRoot, ".council", "specs")}/g*.test.ts`);
  console.error(`  State:         ${resolve(autopilotDir, "state.json")}`);
  console.error(`  Project doc:   ${docPath}`);
  console.error("");
  if (args.dryRun) {
    console.error("Dry-run mode. Review the specs before running with --live.");
    console.error("Live mode (implementation loop) will ship in a future PR.");
  }
}

// Entry point. Don't run main() during test imports (matches council.ts pattern).
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.live && !args.resume) {
    console.error(
      "[autopilot] --live mode is not yet implemented in this build. " +
      "PR8 ships --dry-run only. Falling back to dry-run."
    );
    args.dryRun = true;
    args.live = false;
  }
  if (args.resume) {
    console.error("[autopilot] --resume is not yet implemented (PR9).");
    process.exit(2);
  }
  await bootstrap(args);
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
