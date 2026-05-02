/**
 * Autopilot state.json schema + atomic read/write.
 *
 * Source of truth for the autopilot's working memory. Lives at
 * `<repo>/.autopilot/state.json` (repo-local, gitignored).
 *
 * Compaction-survivable by design: every iteration re-reads from disk; conversation
 * context is cache only. Atomic writes (.tmp + rename) prevent half-written state
 * from corrupting recovery after a crash or interrupt.
 */

import { existsSync, mkdirSync, readFileSync, renameSync } from "fs";
import { resolve, dirname } from "path";

export const AUTOPILOT_STATE_SCHEMA_VERSION = 1;

export type GoalStatus =
  | "pending"        // not yet started
  | "in_progress"    // currently being implemented (live mode)
  | "needs_review"   // implementation done; awaiting final-review council
  | "done"           // verified + approved
  | "failed";        // gave up after stuck-rescue exhausted

export interface Goal {
  id: string;                          // "g1", "g2", ...
  title: string;
  description: string;                 // one-paragraph what-this-achieves
  spec_file: string;                   // relative path, e.g. ".council/specs/g1.test.ts"
  spec_sha: string;                    // sha256 of the frozen spec at decomposition time
  status: GoalStatus;
  green_commit: string | null;         // commit at which this goal first verified
  iteration: number;                   // implementation iterations so far
  last_test_hash: string | null;       // for stuck detection (no progress between cycles)
  tracked_tree_hash: string | null;    // git ls-tree hash for stuck detection
  stuck_rescues_used: number;          // capped at 1 per goal (per Strategy C)
  failure_reason: string | null;
  notes_file: string | null;           // path to .autopilot/notes/<id>-attempts.md if any
}

export type PauseReason = "rate_limit" | "user_pause" | null;

export interface AutopilotState {
  schema_version: typeof AUTOPILOT_STATE_SCHEMA_VERSION;
  started_at: string;                  // ISO timestamp
  goal_file: string;                   // user-supplied path, e.g. "./goal.md"
  plan_session: string | null;         // council session id of the upfront decomposition
  current_goal_id: string | null;
  queue: string[];                     // goal ids still to process
  completed: string[];                 // goal ids in done state
  failed: string[];                    // goal ids in failed state
  goals: Goal[];                       // full goal records
  last_green_commit: string | null;    // most recent green commit across all goals
  last_progress_at: string;            // ISO; for stuck detection at the orchestrator level
  paused_until: string | null;         // ISO; non-null when waiting for rate-limit window reset
  paused_reason: PauseReason;
  dry_run: boolean;                    // set by --dry-run flag (default true)
  live_mode: boolean;                  // set by --live flag (overrides dry_run)
}

export function defaultState(goalFile: string, dryRun: boolean): AutopilotState {
  const now = new Date().toISOString();
  return {
    schema_version: AUTOPILOT_STATE_SCHEMA_VERSION,
    started_at: now,
    goal_file: goalFile,
    plan_session: null,
    current_goal_id: null,
    queue: [],
    completed: [],
    failed: [],
    goals: [],
    last_green_commit: null,
    last_progress_at: now,
    paused_until: null,
    paused_reason: null,
    dry_run: dryRun,
    live_mode: !dryRun,
  };
}

/**
 * Read state.json from `<autopilotDir>/state.json`. Returns null if no file exists.
 * Validates schema_version; throws on mismatch (deliberate — we want loud failure
 * if a future schema migration forgets to bump the version).
 */
export function readState(autopilotDir: string): AutopilotState | null {
  const path = resolve(autopilotDir, "state.json");
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  const parsed = JSON.parse(raw);
  if (parsed.schema_version !== AUTOPILOT_STATE_SCHEMA_VERSION) {
    throw new Error(
      `state.json schema_version mismatch: expected ${AUTOPILOT_STATE_SCHEMA_VERSION}, got ${parsed.schema_version}. ` +
      `Either delete .autopilot/state.json to start fresh, or migrate the file manually.`
    );
  }
  return parsed as AutopilotState;
}

/**
 * Atomic write: write to .state.json.tmp, then rename. Prevents partial writes
 * from corrupting recovery if the orchestrator crashes mid-write.
 */
export async function writeState(autopilotDir: string, state: AutopilotState): Promise<void> {
  mkdirSync(autopilotDir, { recursive: true });
  const tmpPath = resolve(autopilotDir, ".state.json.tmp");
  const finalPath = resolve(autopilotDir, "state.json");
  await Bun.write(tmpPath, JSON.stringify(state, null, 2));
  renameSync(tmpPath, finalPath);
}

/**
 * Compute sha256 of a file's content for spec-tamper detection. Returns hex string.
 */
export async function fileHash(path: string): Promise<string> {
  if (!existsSync(path)) return "";
  const content = readFileSync(path);
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(content);
  return hasher.digest("hex");
}

/**
 * Goal-id generator. "g1", "g2", ... — deterministic from index.
 */
export function goalId(index: number): string {
  return `g${index + 1}`;
}
