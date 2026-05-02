/**
 * Stuck detection for the autopilot's per-leaf implementation loop.
 *
 * From council-20260502-205303 (Fork 3C — weighted heuristic):
 *
 *   "same failure signature + git advanced" is the PRIMARY signal —
 *      catches "Claude is committing but tests are still broken in the
 *      same way" (the most expensive undetected failure mode).
 *   "30 minutes no red→green transition" is the BACKSTOP — catches
 *      cases where the failure varies but no progress is real.
 *   "tree hash unchanged 3 cycles" is just LIVENESS — catches cases
 *      where Claude isn't even making commits.
 *
 * The failure-signature algorithm (Codex's spec):
 *   1. exit code + sorted failing test ids when extractable
 *   2. + first assertion file:line OUTSIDE the frozen spec
 *   3. fallback: normalized output hash (strip ANSI, timing, temp paths)
 *
 * Per-profile parsers extract test names + assertion locations from
 * pytest / bun:test / vitest / jest / go test / cargo test / rspec output.
 * Generic fallback: hash of stripped output.
 */

import type { ProjectProfile } from "./autopilot-profile";
import type { VerifyResult } from "./autopilot-verifier";

/**
 * A computed signature representing "what is failing right now". Compared
 * across iterations to detect "claude is digging deeper in the same hole."
 */
export interface FailureSignature {
  /** Exit code is the primary differentiator. */
  exitCode: number;
  /** Sorted, deduped failing-test ids when extractable from output. */
  failingTestIds: string[];
  /**
   * file:line of the first assertion failure OUTSIDE .council/specs/.
   * Implementation detail — if claude keeps changing the same line in
   * the same source file, that's a strong "stuck on this assertion" signal.
   * Empty when no extractable.
   */
  firstAssertionLocation: string;
  /** Normalized output hash — fallback when other fields are empty. */
  normalizedOutputHash: string;
}

/**
 * Compute the failure signature from a verify result. Per-profile parsers
 * handle the per-test-runner output formats; the normalized-hash fallback
 * always produces something.
 */
export function computeFailureSignature(verify: VerifyResult, profile: ProjectProfile): FailureSignature {
  const ids = extractFailingTestIds(verify.stdout, verify.stderr, profile);
  const loc = extractFirstAssertionLocation(verify.stdout, verify.stderr, profile);
  const normHash = normalizedOutputHashSync(`${verify.stdout}\n${verify.stderr}`);
  return {
    exitCode: verify.exitCode,
    failingTestIds: ids,
    firstAssertionLocation: loc,
    normalizedOutputHash: normHash,
  };
}

/**
 * Two signatures are "the same failure" when:
 *   - Same exit code, AND
 *   - (Same failing-test ids, OR same first-assertion location, OR — if neither
 *     is extractable for both — same normalized output hash)
 *
 * The OR-of-three lets us tolerate flaky parsers without losing detection.
 */
export function sameFailure(a: FailureSignature, b: FailureSignature): boolean {
  if (a.exitCode !== b.exitCode) return false;
  // Prefer test-ids when both have them
  if (a.failingTestIds.length > 0 && b.failingTestIds.length > 0) {
    return idsEqual(a.failingTestIds, b.failingTestIds);
  }
  // Else first-assertion location when both have it
  if (a.firstAssertionLocation && b.firstAssertionLocation) {
    return a.firstAssertionLocation === b.firstAssertionLocation;
  }
  // Last resort: normalized output hash
  return a.normalizedOutputHash === b.normalizedOutputHash;
}

function idsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ============================================================
 * Per-profile failing-test-id extractors
 * ============================================================
 *
 * Output-format parsers per test runner. Conservative: better to miss a
 * test name (fall back to first-assertion or hash) than to extract
 * a wrong one.
 */

function extractFailingTestIds(stdout: string, stderr: string, profile: ProjectProfile): string[] {
  const text = `${stdout}\n${stderr}`;
  let extractor: (text: string) => string[];
  switch (profile.id) {
    case "python-poetry":
    case "python-pytest":
      extractor = extractPytestFailures;
      break;
    case "typescript-bun":
      extractor = extractBunTestFailures;
      break;
    case "typescript-node":
      extractor = extractVitestFailures;
      break;
    case "typescript-jest":
      extractor = extractJestFailures;
      break;
    case "go":
      extractor = extractGoTestFailures;
      break;
    case "rust":
      extractor = extractCargoTestFailures;
      break;
    case "ruby-rspec":
      extractor = extractRspecFailures;
      break;
    default:
      return [];
  }
  const ids = extractor(text);
  // Sort + dedupe so "same failures in different order" still match
  return [...new Set(ids)].sort();
}

/** pytest: "FAILED tests/test_foo.py::test_bar" or "tests/test_foo.py::test_bar FAILED" */
function extractPytestFailures(text: string): string[] {
  const ids: string[] = [];
  const patterns = [
    /^FAILED\s+(\S+::\S+)/gm,
    /^(\S+::\S+)\s+FAILED/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) ids.push(m[1]);
  }
  return ids;
}

/** bun:test: "(fail) <suite> > <test name> [time]" */
function extractBunTestFailures(text: string): string[] {
  const ids: string[] = [];
  const re = /^\(fail\)\s+(.+?)\s*\[/gm;
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1].trim());
  return ids;
}

/** vitest: lines starting with "× " followed by test name */
function extractVitestFailures(text: string): string[] {
  const ids: string[] = [];
  const re = /^\s*×\s+(.+?)(?:\s+\d+ms)?$/gm;
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1].trim());
  return ids;
}

/** jest: "✕ <test name>" or "FAIL <suite>" + indented "✕ <name>" */
function extractJestFailures(text: string): string[] {
  const ids: string[] = [];
  const re = /^\s*✕\s+(.+?)(?:\s+\(\d+\s*ms\))?$/gm;
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1].trim());
  return ids;
}

/** go test: "--- FAIL: TestFoo (0.00s)" */
function extractGoTestFailures(text: string): string[] {
  const ids: string[] = [];
  const re = /^---\s+FAIL:\s+(\w+)/gm;
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

/** cargo test: "test foo::bar ... FAILED" */
function extractCargoTestFailures(text: string): string[] {
  const ids: string[] = [];
  const re = /^test\s+(\S+)\s+\.\.\.\s+FAILED/gm;
  let m;
  while ((m = re.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

/** rspec: "Failures:" section then "1) <description>" lines */
function extractRspecFailures(text: string): string[] {
  const ids: string[] = [];
  // Take everything after "Failures:" header
  const failuresIdx = text.indexOf("Failures:");
  if (failuresIdx === -1) return ids;
  const tail = text.slice(failuresIdx);
  const re = /^\s*\d+\)\s+(.+?)$/gm;
  let m;
  while ((m = re.exec(tail)) !== null) ids.push(m[1].trim());
  return ids;
}

/* ============================================================
 * First-assertion-location extractor
 * ============================================================
 *
 * Best-effort: looks for "<path>:<line>" patterns in failure output where
 * <path> is NOT under .council/specs/ (we want the assertion in source code,
 * not in the spec — same spec assertion across iterations would always match
 * trivially, defeating the purpose).
 */

function extractFirstAssertionLocation(stdout: string, stderr: string, _profile: ProjectProfile): string {
  const text = `${stdout}\n${stderr}`;
  // Generic file:line:column or file:line pattern. Filters .council/specs/ out.
  const re = /([\w./\-+]+\.(?:py|ts|tsx|js|jsx|go|rs|rb|exs|erl)):(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const path = m[1];
    if (path.includes(".council/specs/")) continue;
    return `${path}:${m[2]}`;
  }
  return "";
}

/* ============================================================
 * Normalized output hash (fallback signature)
 * ============================================================ */

function normalizedOutputHashSync(text: string): string {
  // Strip ANSI escapes
  let s = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
  // Strip timing — "(123ms)", "in 1.23s", "took 0.04 sec", "[12.34ms]"
  s = s.replace(/\b\d+(\.\d+)?\s*(ms|s|sec)\b/g, "");
  s = s.replace(/\[\d+(\.\d+)?\s*ms\]/g, "");
  s = s.replace(/\(\d+(\.\d+)?\s*(ms|s)\)/g, "");
  // Strip absolute /tmp/ paths and other temp-dir references
  s = s.replace(/\/private\/var\/folders\/[^\s)]+/g, "/<tmp>");
  s = s.replace(/\/tmp\/\S+/g, "/<tmp>");
  s = s.replace(/\/var\/folders\/[^\s)]+/g, "/<tmp>");
  // Strip common counters that vary per run ("Ran 5 tests", "5 passed, 3 failed")
  s = s.replace(/\bRan\s+\d+\s+tests?\b/g, "Ran N tests");
  s = s.replace(/\b\d+\s+passed/g, "N passed");
  s = s.replace(/\b\d+\s+failed/g, "N failed");
  // Collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  // Hash (use Bun.CryptoHasher; fall back to a simple hash if unavailable)
  if (typeof Bun !== "undefined" && Bun.CryptoHasher) {
    const h = new Bun.CryptoHasher("sha256");
    h.update(s);
    return h.digest("hex").slice(0, 32);
  }
  // Fallback: FNV-1a 32-bit (deterministic, no deps)
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/* ============================================================
 * Stuck-state detector
 * ============================================================ */

export interface StuckHistory {
  /** Failure signature from each iteration (newest last). */
  signatures: FailureSignature[];
  /** Tracked-tree git ls-tree hash from each iteration (newest last). */
  treeHashes: string[];
  /** Wall-clock timestamp of last red→green transition (or run start). */
  lastGreenAt: string;
}

export type StuckTrigger =
  | { stuck: false }
  | { stuck: true; reason: "same_failure_with_git_advance"; iterations: number }
  | { stuck: true; reason: "no_green_for_30min"; minutesElapsed: number }
  | { stuck: true; reason: "tree_unchanged_3_cycles" };

/**
 * Council Fork 3C: weighted heuristic.
 *
 *   - PRIMARY: same failure signature for >= SAME_FAILURE_THRESHOLD
 *     consecutive iterations AND git advanced (claude is committing but
 *     not making the test green)
 *   - BACKSTOP: 30+ minutes since last red→green
 *   - LIVENESS: tree hash unchanged for >= 3 consecutive cycles (claude
 *     isn't even making commits)
 */
export const SAME_FAILURE_THRESHOLD = 5;
export const NO_GREEN_TIMEOUT_MIN = 30;
export const TREE_UNCHANGED_THRESHOLD = 3;

export function detectStuck(history: StuckHistory): StuckTrigger {
  const sigs = history.signatures;
  const trees = history.treeHashes;

  // PRIMARY: same-failure repeats AND tree advancing
  if (sigs.length >= SAME_FAILURE_THRESHOLD && trees.length >= SAME_FAILURE_THRESHOLD) {
    const last = sigs[sigs.length - 1];
    const allSame = sigs.slice(-SAME_FAILURE_THRESHOLD).every((s) => sameFailure(s, last));
    const treesAdvancing = (() => {
      const recent = trees.slice(-SAME_FAILURE_THRESHOLD);
      const unique = new Set(recent);
      return unique.size > 1; // tree changed at least once during the window
    })();
    if (allSame && treesAdvancing) {
      return { stuck: true, reason: "same_failure_with_git_advance", iterations: SAME_FAILURE_THRESHOLD };
    }
  }

  // BACKSTOP: time since last green
  const lastGreenMs = new Date(history.lastGreenAt).getTime();
  const elapsedMin = (Date.now() - lastGreenMs) / 60_000;
  if (elapsedMin >= NO_GREEN_TIMEOUT_MIN) {
    return { stuck: true, reason: "no_green_for_30min", minutesElapsed: Math.floor(elapsedMin) };
  }

  // LIVENESS: tree-unchanged for 3 cycles
  if (trees.length >= TREE_UNCHANGED_THRESHOLD) {
    const recent = trees.slice(-TREE_UNCHANGED_THRESHOLD);
    if (new Set(recent).size === 1) {
      return { stuck: true, reason: "tree_unchanged_3_cycles" };
    }
  }

  return { stuck: false };
}

/**
 * Get the current git ls-tree hash for the working directory. Used as the
 * tree-hash signal in the liveness check.
 */
export async function getTreeHash(repoRoot: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "ls-tree", "-r", "HEAD"], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const text = await new Response(proc.stdout).text();
    await proc.exited;
    if (typeof Bun !== "undefined" && Bun.CryptoHasher) {
      const h = new Bun.CryptoHasher("sha256");
      h.update(text);
      return h.digest("hex").slice(0, 16);
    }
    // Fallback (same as normalizedOutputHashSync's fallback)
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = (hash * 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  } catch {
    return "";
  }
}
