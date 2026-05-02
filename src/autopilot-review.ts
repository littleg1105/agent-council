/**
 * Final-review council with VETO-only authority (PR9.4).
 *
 * From council-20260502-205303 (Fork 4A — Codex's framing, picked unanimously
 * by Codex+Claude):
 *
 *   "A final-review veto should fail the run immediately, not spawn a
 *    whole-run rescue council and not get relabeled as 'complete'; otherwise
 *    the council gains constructive authority after green, which breaks the
 *    `VETO but never BLESS` line. Veto criteria must be concrete and
 *    diff-citable only: SPEC_MISMATCH, PLACEHOLDER_LOGIC, TEST_ONLY_CHEAT,
 *    and SCOPE_BREACH; not 'coverage feels low' or 'I'd prefer more
 *    refactoring.'"
 *
 * Architecture:
 *   - Truth flows up from `bun test` exit codes (verifier already ran per-leaf
 *     and globally before this council fires).
 *   - This council can ONLY VETO (downgrade `done` → fail). It cannot grant
 *     `done`. The verifier's exit code is the necessary condition for done;
 *     council approval is a secondary check that can deny but not bless.
 *   - 4 explicit reject codes — anything else is rejected as not a veto.
 *   - "Fail fast" — no auto-rescue at the run level. User wakes up to a
 *     vetoed run + reasoning + decides what to do.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";
import type { ProjectProfile } from "./autopilot-profile";
import type { AutopilotState, Goal } from "./autopilot-state";

export type VetoCode =
  | "SPEC_MISMATCH"        // diff doesn't actually satisfy the spec — assertions diverge
  | "PLACEHOLDER_LOGIC"    // return-stubs / TODO-only / pass-through-mocks
  | "TEST_ONLY_CHEAT"      // changes ONLY to test infrastructure (mocking-out the runner, etc.)
  | "SCOPE_BREACH";        // touches files outside the goal's expected surface

export const ALL_VETO_CODES: ReadonlyArray<VetoCode> = [
  "SPEC_MISMATCH",
  "PLACEHOLDER_LOGIC",
  "TEST_ONLY_CHEAT",
  "SCOPE_BREACH",
];

export interface VetoVerdict {
  vetoed: boolean;
  /** When vetoed, the reject code (one of ALL_VETO_CODES). */
  code?: VetoCode;
  /** Council reasoning (synthesized from agent opinions). For diagnostic display. */
  reasoning: string;
  /** Council session id for replay (`/council-replay <id>`). */
  sessionId: string;
}

/**
 * Build the final-review prompt. Constrains the council to the 4 explicit
 * VETO codes and forbids "coverage feels low" -style soft objections.
 *
 * Includes:
 *   - Original user goal text (so the council knows the intent)
 *   - The full goal decomposition (titles + descriptions per leaf)
 *   - Whole-run diff (from initial commit to last_green_commit)
 *   - File-by-file change summary (which files changed, line counts)
 *   - All frozen specs (so the council can compare diff-vs-spec)
 *
 * The prompt instructs each agent to either:
 *   - Output `===VERDICT_VETO===` followed by exactly one of the 4 reject
 *     codes and a 2-3 sentence justification (file:line citations required).
 *   - OR output `===VERDICT_OK===` and a brief explanation of why none of
 *     the 4 reject criteria apply.
 */
export function buildFinalReviewPrompt(args: {
  userGoalText: string;
  goals: Goal[];
  diffSummary: string;        // condensed diff (file paths + line counts)
  diffContent: string;        // full diff (truncated if huge)
  specsCombined: string;      // all frozen specs concatenated
  profile: ProjectProfile;
}): string {
  return `You are sitting in final review for an autonomous-loop run that has just
finished green-on-every-verifier. Your authority is **VETO ONLY**: you can
deny the run \`done\` (downgrade to \`needs_review\`), but you cannot grant
it. Truth-by-process (each leaf's frozen test spec passing under
\`${args.profile.spec_test_command("<spec>")}\` in a clean checkout) already
holds. Your job is to catch the failure modes the verifier can't see.

# Original user goal

\`\`\`
${args.userGoalText.trim()}
\`\`\`

# Goal decomposition (frozen at start of run)

${args.goals.map((g) => `**${g.id}**: ${g.title}\n  ${g.description}`).join("\n\n")}

# All frozen test specs (the contract)

\`\`\`
${args.specsCombined}
\`\`\`

# Diff summary (what changed)

\`\`\`
${args.diffSummary}
\`\`\`

# Full diff (truncated if huge)

\`\`\`diff
${args.diffContent}
\`\`\`

# The four allowed VETO codes (only these — nothing else is a veto)

You may VETO with EXACTLY ONE of:

  **SPEC_MISMATCH** — the implementation diff does not actually satisfy the
    behavior the spec describes. The verifier passed, but the implementation
    diverges from spec intent (e.g., a spec asserting on the SHAPE of a
    return value where the implementation returns the right shape but with
    semantically wrong content).

  **PLACEHOLDER_LOGIC** — the diff consists primarily of return-stubs, TODO
    comments, pass-through mocks, or hardcoded constants that would make
    the spec pass without implementing real behavior. Cite the specific
    file:line where placeholder is most egregious.

  **TEST_ONLY_CHEAT** — the diff changed ONLY test infrastructure (test
    helpers, mocked runtime, conftest.py, vitest config, etc.) to make
    the verifier pass without implementing the behavior in production
    code. Cite the test infra file(s) modified.

  **SCOPE_BREACH** — the diff touches files outside the goals' expected
    surface (e.g., goal g3 said "implement the runner" but the diff
    rewrote the data layer of secreqgen too). Cite the out-of-scope files.

# What is NOT a veto (these will be rejected as soft objections)

  - "Coverage feels low"
  - "I'd prefer more refactoring"
  - "Could be more idiomatic"
  - "Documentation is thin"
  - "Edge cases not handled" (unless an edge case IS in the spec and the
    diff doesn't satisfy it — that's SPEC_MISMATCH)

# Your output format (each agent)

Output EXACTLY ONE of:

  \`\`\`
  ===VERDICT_VETO===
  <ONE_REJECT_CODE>
  <2-3 sentences citing diff file:line>
  \`\`\`

  OR:

  \`\`\`
  ===VERDICT_OK===
  <Why none of the 4 reject criteria apply. 2-3 sentences. No "consider
  also..." soft objections — those are out of scope here.>
  \`\`\`

If 2 of 3 agents VETO with the same code, the run is vetoed. If they VETO
with different codes, the chairman synthesizer picks the strongest one. If
2 of 3 say OK, the run is approved (verifier-pass-already-blessed-it remains
the source of truth).

The chairman will NOT grant \`done\` — only verifier-pass does that. The
chairman can only confirm or deny the veto.
`;
}

/**
 * Parse VERDICT marker from a single agent's response. Returns the verdict
 * if extractable; null if neither marker is found OR the marker isn't
 * followed by a valid reject code (for VETO).
 */
export function parseAgentVerdict(text: string): { kind: "veto"; code: VetoCode; reasoning: string } | { kind: "ok"; reasoning: string } | null {
  // Try VETO first (more specific)
  const vetoMatch = text.match(/===VERDICT_VETO===\s*\n?\s*([A-Z_]+)\s*\n?([\s\S]*?)(?:\n===|$)/);
  if (vetoMatch) {
    const code = vetoMatch[1].trim() as VetoCode;
    if (!(ALL_VETO_CODES as readonly string[]).includes(code)) {
      // Invalid reject code — treat as malformed, not a veto. Conservative: don't veto on parse failures.
      return null;
    }
    return { kind: "veto", code, reasoning: vetoMatch[2].trim() };
  }
  const okMatch = text.match(/===VERDICT_OK===\s*\n?([\s\S]*?)(?:\n===|$)/);
  if (okMatch) {
    return { kind: "ok", reasoning: okMatch[1].trim() };
  }
  return null;
}

/**
 * Synthesize the council's overall verdict from the per-agent verdicts.
 * Council-can-VETO-but-never-BLESS asymmetry encoded here:
 *   - If 2/3 (or 3/3) VETO with the SAME code → vetoed with that code
 *   - If 2/3 (or 3/3) VETO with DIFFERENT codes → vetoed; pick the most
 *     severe code (SPEC_MISMATCH > PLACEHOLDER_LOGIC > TEST_ONLY_CHEAT >
 *     SCOPE_BREACH)
 *   - Otherwise → approved (verifier-pass remains the source of truth)
 *
 * If <2 agents emitted parseable verdicts (e.g., 2 of 3 returned OK markers),
 * we approve unless someone explicitly vetoed.
 */
export function synthesizeVerdict(
  perAgent: ReturnType<typeof parseAgentVerdict>[]
): { vetoed: boolean; code?: VetoCode; reasoning: string } {
  const vetos = perAgent.filter((v): v is { kind: "veto"; code: VetoCode; reasoning: string } => v?.kind === "veto");
  const oks = perAgent.filter((v): v is { kind: "ok"; reasoning: string } => v?.kind === "ok");

  if (vetos.length >= 2) {
    // 2+ vetos — count by code, pick highest count, ties broken by registration
    // order in ALL_VETO_CODES (which is severity order: SPEC_MISMATCH first,
    // then PLACEHOLDER_LOGIC, TEST_ONLY_CHEAT, SCOPE_BREACH).
    const counts = new Map<VetoCode, number>();
    for (const v of vetos) counts.set(v.code, (counts.get(v.code) ?? 0) + 1);
    let pickedCode: VetoCode = ALL_VETO_CODES[0];
    let pickedCount = counts.get(pickedCode) ?? 0;
    for (const code of ALL_VETO_CODES) {
      const c = counts.get(code) ?? 0;
      // Strictly greater: registration order wins on tie (SPEC_MISMATCH first).
      if (c > pickedCount) { pickedCode = code; pickedCount = c; }
    }
    const reasoning = vetos.filter((v) => v.code === pickedCode)
      .map((v) => `[${v.code}] ${v.reasoning}`)
      .join("\n\n---\n\n");
    return { vetoed: true, code: pickedCode, reasoning };
  }

  if (vetos.length === 1 && oks.length >= 2) {
    // Lone veto vs. 2+ OKs — approve (verifier-pass still the source of truth;
    // a single dissent is recorded but not blocking).
    return {
      vetoed: false,
      reasoning: `1 of 3 agents vetoed (${vetos[0].code}); 2+ approved. Truth-by-process remains.`,
    };
  }

  if (vetos.length === 1 && oks.length < 2) {
    // 1 veto, no clear OK majority — be conservative. This catches the case
    // where parsing failed for some agents.
    return {
      vetoed: true,
      code: vetos[0].code,
      reasoning: `1 of 3 agents vetoed (${vetos[0].code}); fewer than 2 emitted parseable OK verdicts. Conservative veto.\n\n${vetos[0].reasoning}`,
    };
  }

  // No vetos
  return {
    vetoed: false,
    reasoning: oks.length > 0
      ? oks.map((v) => v.reasoning).join("\n\n---\n\n")
      : "No agent emitted a parseable verdict. Defaulting to verifier-pass authority.",
  };
}

/**
 * Compute a condensed diff summary (file paths + line counts) and full diff
 * for a range of commits in the repo.
 */
export async function computeRunDiff(args: {
  repoRoot: string;
  fromCommit: string | null;  // initial commit; null means "first commit of the repo"
  toCommit: string;            // last green commit
  maxDiffBytes?: number;       // default 50KB; truncate beyond
}): Promise<{ summary: string; content: string }> {
  const range = args.fromCommit ? `${args.fromCommit}..${args.toCommit}` : args.toCommit;
  const maxBytes = args.maxDiffBytes ?? 50_000;

  // Summary: file paths + line counts
  let summary = "";
  try {
    const sumProc = Bun.spawn(["git", "diff", "--stat", range], {
      cwd: args.repoRoot, stdout: "pipe", stderr: "pipe",
    });
    summary = await new Response(sumProc.stdout).text();
    await sumProc.exited;
  } catch {
    summary = "(git diff --stat failed)";
  }

  // Full diff (truncated if huge)
  let content = "";
  try {
    const diffProc = Bun.spawn(["git", "diff", range], {
      cwd: args.repoRoot, stdout: "pipe", stderr: "pipe",
    });
    content = await new Response(diffProc.stdout).text();
    await diffProc.exited;
    if (content.length > maxBytes) {
      content = content.slice(0, maxBytes) + `\n\n[... diff truncated; ${content.length - maxBytes} chars elided ...]`;
    }
  } catch {
    content = "(git diff failed)";
  }

  return { summary, content };
}

/**
 * Concatenate all frozen spec files for inclusion in the review prompt.
 */
export function bundleSpecs(repoRoot: string, goals: Goal[]): string {
  const parts: string[] = [];
  for (const g of goals) {
    const path = resolve(repoRoot, g.spec_file);
    if (!existsSync(path)) continue;
    parts.push(`# ${g.spec_file}\n\n${readFileSync(path, "utf-8")}\n`);
  }
  return parts.join("\n---\n\n");
}

/**
 * Write the final-review verdict to disk for diagnostic record.
 */
export function writeReviewArtifact(args: {
  autopilotDir: string;
  verdict: VetoVerdict;
}): string {
  mkdirSync(args.autopilotDir, { recursive: true });
  const path = resolve(args.autopilotDir, args.verdict.vetoed ? "FINAL_REVIEW_VETO.md" : "FINAL_REVIEW_OK.md");
  const header = args.verdict.vetoed
    ? `# Final review: VETOED (${args.verdict.code})\n\n`
    : `# Final review: APPROVED (verifier-pass + council non-objection)\n\n`;
  const body = `Council session: \`${args.verdict.sessionId}\`\n\n${args.verdict.reasoning}\n`;
  writeFileSync(path, header + body, "utf-8");
  return path;
}
