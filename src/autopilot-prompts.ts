/**
 * Prompt construction for the autopilot orchestrator.
 *
 * Two prompt types:
 *   1. Bootstrap council prompt — asks the 3 agents to decompose a top-level goal
 *      into N leaf goals + frozen test specs. Output uses a strict structured
 *      format (JSON between ===GOALS=== / ===END=== markers) so the autopilot
 *      can parse it deterministically.
 *
 *   2. Per-goal implementation prompt — what we hand to each `claude -p` subprocess
 *      when we spawn it to implement a specific leaf goal in live mode (PR9). Each
 *      subprocess is a fresh contractor with no memory of prior goals; the contract
 *      carries everything it needs.
 *
 * Both prompt builders are pure functions of inputs — no I/O, no globals — so they
 * are trivially testable with hand-crafted strings.
 */

import type { Goal } from "./autopilot-state";
import type { ProjectProfile } from "./autopilot-profile";

/**
 * Maximum number of leaf goals the council is allowed to produce. From the
 * council synthesis (council-20260502-185738) decision: "1 level, max 8 leaves."
 */
export const MAX_LEAF_GOALS = 8;

export interface DecompositionGoal {
  id: string;
  title: string;
  description: string;
  spec_content: string;
}

/**
 * Build the bootstrap council question that asks for goal decomposition.
 * Each agent produces a complete decomposition; the chairman picks the best one.
 *
 * The `profile` parameter parameterizes the prompt so the council writes specs
 * in the right shape for the target project's language and test framework.
 * Supported profiles cover TypeScript+Bun, TypeScript+Node, Python+pytest, Go,
 * Rust, Ruby+RSpec, and a generic fallback (see autopilot-profile.ts).
 */
export function buildBootstrapPrompt(userGoalText: string, profile: ProjectProfile): string {
  return `You are deliberating on how to decompose a user goal into testable leaf goals
for autonomous implementation. The autopilot will spawn a fresh \`claude -p\`
subprocess for EACH leaf goal — those subprocesses have no memory of other
goals; they implement exactly one leaf and exit.

USER GOAL (verbatim):

\`\`\`
${userGoalText.trim()}
\`\`\`

PROJECT TYPE: **${profile.display_name}** (${profile.language})

${profile.prompt_language_block}

CONTEXT:

- The autopilot runs autonomously for hours; it cannot ask the user for
  clarification mid-run. Decompose so each leaf is self-contained.
- Each leaf is verified by running its frozen test spec via the project's
  test runner: \`${profile.test_command}\`. The done-signal is the runner's
  exit code, not LLM judgment.
- Specs are FROZEN at decomposition. The implementing subprocess CANNOT edit
  them; a pre-commit hook will reject any change to .council/specs/. So write
  specs that test BEHAVIOR, not implementation details that haven't been
  written yet.
- Maximum ${MAX_LEAF_GOALS} leaf goals. Fewer is fine. More is rejected.
- Goals must be ORDERABLE: gN cannot depend on g(N+1). The autopilot will
  process them sequentially.
- Spec files use the extension \`${profile.spec_extension}\`.

EXAMPLE SPEC SHAPE (match this for your generated specs):

\`\`\`
${profile.prompt_spec_example.trim()}
\`\`\`

YOUR TASK:

Each agent: produce a complete decomposition. Format your response with
EXACTLY these three sections, in this order:

1. **Reasoning**: a brief paragraph (3-5 sentences) explaining how you split
   the goal into leaves and why this ordering.

2. **A \`===GOALS===\` block** containing valid JSON with this exact shape.
   The chairman will parse this; deviations from the schema are rejected.
   The \`spec_content\` value is a JSON-encoded string of a complete spec
   file in the project's language (see EXAMPLE SPEC SHAPE above) — make sure
   you JSON-escape newlines as \\n and quotes as \\".

\`\`\`
===GOALS===
[
  {
    "id": "g1",
    "title": "Short imperative title",
    "description": "One paragraph explaining what this leaf goal achieves and why it's the right granularity.",
    "spec_content": "<full spec file content, JSON-escaped>"
  },
  ...
]
===END===
\`\`\`

3. **Concerns**: a short list of failure modes your decomposition is
   vulnerable to (e.g., "spec g3 depends on a library version we haven't
   verified", "leaves g4 and g5 might fight over the same module") so the
   chairman can compare risk profiles.

CHAIRMAN INSTRUCTION (you are reading this too — agents and chairman read the
same prompt): pick the decomposition with the cleanest leaf boundaries and
the most behavior-focused specs. Reject any decomposition that:
- Has > ${MAX_LEAF_GOALS} leaves
- Has specs longer than 100 lines each (Goodhart risk — spec implementation
  details = test the spec, not the goal)
- Has specs that mock everything (must exercise real behavior)
- Has goals that depend on each other in non-orderable ways
- Uses TODO / placeholder content in specs

The chairman's synthesis recommendation MUST contain the chosen
\`===GOALS===\` block VERBATIM, JSON-valid. The autopilot parses this
programmatically — paraphrasing the JSON breaks the loop.

DO NOT:
- Add comments inside the JSON (JSON doesn't allow them; parsing fails)
- Include trailing commas in the JSON
- Use single quotes inside the JSON
- Wrap the JSON in extra markdown fencing inside the ===GOALS=== block
- Generate goals that require mid-implementation user input
`;
}

/**
 * Extract the GOALS JSON from an agent's response or the chairman's synthesis
 * recommendation. Returns null if no valid block found.
 *
 * Robust to:
 *   - leading/trailing markdown fences
 *   - the markers being on their own lines or inline
 *   - extra whitespace
 *
 * Strict on:
 *   - JSON validity (returns null on parse failure rather than partial)
 *   - schema shape (returns null if any goal is missing required fields)
 */
export function parseGoalsBlock(text: string): DecompositionGoal[] | null {
  const startMarker = "===GOALS===";
  const endMarker = "===END===";
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return null;
  const endIdx = text.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) return null;

  let inner = text.slice(startIdx + startMarker.length, endIdx).trim();
  // Strip optional surrounding code fence
  inner = inner.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0 || parsed.length > MAX_LEAF_GOALS) return null;

  const goals: DecompositionGoal[] = [];
  for (const g of parsed) {
    if (!g || typeof g !== "object") return null;
    const obj = g as Record<string, unknown>;
    if (
      typeof obj.id !== "string" ||
      typeof obj.title !== "string" ||
      typeof obj.description !== "string" ||
      typeof obj.spec_content !== "string"
    ) {
      return null;
    }
    if (!obj.id.match(/^g\d+$/)) return null;
    if (obj.spec_content.length === 0) return null;
    goals.push({
      id: obj.id,
      title: obj.title,
      description: obj.description,
      spec_content: obj.spec_content,
    });
  }

  // Verify ordering: ids should be g1, g2, g3, ... (no gaps, no duplicates)
  for (let i = 0; i < goals.length; i++) {
    if (goals[i].id !== `g${i + 1}`) return null;
  }
  return goals;
}

/**
 * Build the per-goal implementation prompt that gets passed to a fresh
 * `claude -p` subprocess in live mode (PR9). Each invocation is a fresh
 * contractor with no memory of prior goals; the prompt carries the entire
 * contract.
 *
 * Note: PR8 ships this builder but does not invoke it (dry-run only). PR9
 * wires it into the live implementation loop.
 */
export function buildImplementationPrompt(args: {
  goal: Goal;
  autopilotDocPath: string;     // e.g. ".autopilot/AUTOPILOT.md"
  goalFilePath: string;          // e.g. ".autopilot/goals/g3.md"
  specFilePath: string;          // e.g. ".council/specs/g3.test.ts"
  verifyCommand: string;         // e.g. "bun run autopilot verify --goal g3"
  maxIterations: number;         // e.g. 30
}): string {
  return `You are an implementing agent in an autonomous loop. You have no memory of
prior goals or sessions; everything you need is in the files referenced
below.

# Read these files BEFORE doing anything

1. \`${args.autopilotDocPath}\` — project state, conventions, hard rules
2. \`${args.goalFilePath}\` — your specific goal (id: ${args.goal.id})
3. \`${args.specFilePath}\` — the FROZEN test spec that defines success

# Your goal

${args.goal.title}

${args.goal.description}

# What "done" means

Run: \`${args.verifyCommand}\`

If it exits 0: commit your work with a Conventional Commit message (e.g.
\`feat(${args.goal.id}): <what you did>\`) and exit. The orchestrator will
take over from there.

If it exits non-zero: iterate. Read the failing test output, change code (NOT
the spec), re-run. Repeat up to ${args.maxIterations} iterations.

# Hard rules

- DO NOT modify \`${args.specFilePath}\` or anything else under
  \`.council/specs/\` — a pre-commit hook will reject any change. The spec is
  the contract.
- DO NOT modify \`.autopilot/state.json\` — the orchestrator owns it.
- DO NOT advance to other goals or touch files unrelated to this goal — other
  sessions are responsible for those.
- DO NOT run destructive git commands (reset --hard, push, branch -D). The
  orchestrator handles rollback.
- DO commit each meaningful step (lets the orchestrator track progress and
  roll back to known-green commits if needed).

# When you can't make it pass

If after ${args.maxIterations} iterations or 30 minutes wall time you can't
make the test pass:

1. Append a brief failure note to \`.autopilot/notes/${args.goal.id}-attempts.md\`
   describing what you tried and where you got stuck.
2. Exit with a non-zero code. The orchestrator will run a stuck-rescue council
   or roll back and mark the goal failed.

Begin by reading the three files listed above, then start implementing.
`;
}

/**
 * Build the synthesizer prompt for the bootstrap council. After the 3 agents
 * each produce their independent decomposition (writing to opinion_*.json),
 * the autopilot invokes a fresh `claude -p` with this prompt to pick the
 * best one and emit the chosen GOALS block to stdout.
 *
 * The `profile` parameter parameterizes the validity criterion so the
 * synthesizer judges specs against the active project's language and test
 * framework — Python+pytest projects don't get rejected for "not being
 * TypeScript". (This was a PR9 leak fixed after the autopilot's first
 * cross-architecture run on a Python project.)
 *
 * Why a separate synthesizer instead of a chairman: the standard chairman
 * flow runs in the same Claude Code session that invoked /agent-council. The
 * autopilot is a Bun process, so there's no parent Claude session to be
 * chairman. A dedicated synthesizer call is the cleanest way to do
 * structured-output picking.
 */
export function buildSynthesizerPrompt(opinionFilePaths: string[], profile: ProjectProfile): string {
  const fileList = opinionFilePaths.map((p, i) => `  ${i + 1}. ${p}`).join("\n");
  return `You are the chairman synthesizing 3 council opinions on a goal-decomposition
question for an autopilot. The target project's profile is:

  Language:       ${profile.language}
  Test framework: ${profile.test_framework}
  Spec extension: ${profile.spec_extension}
  Test command:   ${profile.test_command}

Read each opinion file:

${fileList}

Each agent has produced a decomposition with a \`===GOALS===\` JSON block.
Your job:

1. Read all three opinions.
2. Compare the decompositions on these criteria, in order of importance:
   a. Specs test BEHAVIOR (not implementation detail). Reject Goodhart-prone specs.
   b. Goal boundaries are clean (each leaf is self-contained, orderable).
   c. Specs are not over-mocked (real behavior exercised).
   d. Reasonable count (3-${MAX_LEAF_GOALS} leaves; closer to 5 is usually right).
   e. Spec content is syntactically valid for the project profile above —
      i.e. ${profile.language} code that the ${profile.test_framework} runner
      can execute. Reject specs that use the wrong language/framework
      (a TypeScript spec for a Python project, etc.).
3. Pick the SINGLE best decomposition. You may NOT merge or hybridize — pick
   one agent's output verbatim. Hybridizing risks introducing inconsistencies
   that breaks the autopilot's parser.
4. Output a brief reasoning section explaining your pick (1 paragraph).
5. Then output the chosen agent's \`===GOALS===\` block VERBATIM. The
   autopilot parses this programmatically — do not paraphrase, reformat, or
   add JSON comments.

If ALL THREE decompositions fail the criteria above (rare but possible), output
the literal text \`===NO_VIABLE_DECOMPOSITION===\` instead of a GOALS block,
followed by a paragraph explaining why. The autopilot will surface this to the
user instead of writing broken specs.
`;
}
