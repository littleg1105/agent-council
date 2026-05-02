import { describe, test, expect } from "bun:test";
import {
  MAX_LEAF_GOALS,
  buildBootstrapPrompt,
  buildImplementationPrompt,
  buildSynthesizerPrompt,
  parseGoalsBlock,
} from "../src/autopilot-prompts";
import type { Goal } from "../src/autopilot-state";

describe("buildBootstrapPrompt", () => {
  test("includes the user goal verbatim", () => {
    const out = buildBootstrapPrompt("Build a Markov chain text generator with stress tests.");
    expect(out).toContain("Build a Markov chain text generator with stress tests.");
  });

  test("instructs the structured GOALS block format", () => {
    const out = buildBootstrapPrompt("any goal");
    expect(out).toContain("===GOALS===");
    expect(out).toContain("===END===");
    expect(out).toContain("spec_content");
  });

  test("declares the leaf cap", () => {
    const out = buildBootstrapPrompt("any goal");
    expect(out).toContain(`Maximum ${MAX_LEAF_GOALS}`);
  });
});

describe("parseGoalsBlock", () => {
  const validBlock = (n: number) => {
    const goals = Array.from({ length: n }, (_, i) => ({
      id: `g${i + 1}`,
      title: `Title ${i + 1}`,
      description: "desc",
      spec_content: "import { test } from 'bun:test';\ntest('x', () => {});\n",
    }));
    return `===GOALS===\n${JSON.stringify(goals, null, 2)}\n===END===`;
  };

  test("extracts a valid block from synthesizer-style output", () => {
    const text = `Reasoning: this is great.\n\n${validBlock(3)}\n\nNotes: none.`;
    const out = parseGoalsBlock(text);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(3);
    expect(out![0].id).toBe("g1");
    expect(out![2].id).toBe("g3");
  });

  test("returns null when no GOALS block is present", () => {
    expect(parseGoalsBlock("nothing here")).toBeNull();
    expect(parseGoalsBlock("===GOALS===\nbut no end marker")).toBeNull();
  });

  test("returns null on invalid JSON", () => {
    const text = `===GOALS===\n[{not valid json}]\n===END===`;
    expect(parseGoalsBlock(text)).toBeNull();
  });

  test("returns null when ids are out of order", () => {
    const goals = [
      { id: "g1", title: "a", description: "d", spec_content: "x" },
      { id: "g3", title: "b", description: "d", spec_content: "x" }, // should be g2
    ];
    const text = `===GOALS===\n${JSON.stringify(goals)}\n===END===`;
    expect(parseGoalsBlock(text)).toBeNull();
  });

  test("returns null when ids are duplicated", () => {
    const goals = [
      { id: "g1", title: "a", description: "d", spec_content: "x" },
      { id: "g1", title: "b", description: "d", spec_content: "x" },
    ];
    const text = `===GOALS===\n${JSON.stringify(goals)}\n===END===`;
    expect(parseGoalsBlock(text)).toBeNull();
  });

  test("returns null when leaf count exceeds MAX_LEAF_GOALS", () => {
    const text = validBlock(MAX_LEAF_GOALS + 1);
    expect(parseGoalsBlock(text)).toBeNull();
  });

  test("returns null on empty array", () => {
    const text = `===GOALS===\n[]\n===END===`;
    expect(parseGoalsBlock(text)).toBeNull();
  });

  test("returns null when a goal is missing required fields", () => {
    const goals = [{ id: "g1", title: "a", description: "d" }]; // missing spec_content
    const text = `===GOALS===\n${JSON.stringify(goals)}\n===END===`;
    expect(parseGoalsBlock(text)).toBeNull();
  });

  test("returns null when spec_content is empty string", () => {
    const goals = [{ id: "g1", title: "a", description: "d", spec_content: "" }];
    const text = `===GOALS===\n${JSON.stringify(goals)}\n===END===`;
    expect(parseGoalsBlock(text)).toBeNull();
  });

  test("tolerates surrounding markdown code fence inside the block", () => {
    const goals = [{ id: "g1", title: "a", description: "d", spec_content: "x" }];
    const text = `===GOALS===\n\`\`\`json\n${JSON.stringify(goals)}\n\`\`\`\n===END===`;
    const out = parseGoalsBlock(text);
    expect(out).not.toBeNull();
    expect(out![0].id).toBe("g1");
  });
});

describe("buildImplementationPrompt", () => {
  const goal: Goal = {
    id: "g3",
    title: "Add the foo widget",
    description: "Implements the foo widget per spec.",
    spec_file: ".council/specs/g3.test.ts",
    spec_sha: "deadbeef",
    status: "pending",
    green_commit: null,
    iteration: 0,
    last_test_hash: null,
    tracked_tree_hash: null,
    stuck_rescues_used: 0,
    failure_reason: null,
    notes_file: null,
  };

  test("references all three context files", () => {
    const out = buildImplementationPrompt({
      goal,
      autopilotDocPath: ".autopilot/AUTOPILOT.md",
      goalFilePath: ".autopilot/goals/g3.md",
      specFilePath: ".council/specs/g3.test.ts",
      verifyCommand: "bun run autopilot verify --goal g3",
      maxIterations: 30,
    });
    expect(out).toContain(".autopilot/AUTOPILOT.md");
    expect(out).toContain(".autopilot/goals/g3.md");
    expect(out).toContain(".council/specs/g3.test.ts");
  });

  test("includes the goal title and description", () => {
    const out = buildImplementationPrompt({
      goal,
      autopilotDocPath: ".autopilot/AUTOPILOT.md",
      goalFilePath: ".autopilot/goals/g3.md",
      specFilePath: ".council/specs/g3.test.ts",
      verifyCommand: "bun run autopilot verify --goal g3",
      maxIterations: 30,
    });
    expect(out).toContain("Add the foo widget");
    expect(out).toContain("Implements the foo widget per spec.");
  });

  test("calls out hard rules — no spec edits, no state edits, no destructive git", () => {
    const out = buildImplementationPrompt({
      goal,
      autopilotDocPath: "x",
      goalFilePath: "y",
      specFilePath: ".council/specs/g3.test.ts",
      verifyCommand: "z",
      maxIterations: 30,
    });
    expect(out.toLowerCase()).toContain("do not modify");
    expect(out).toContain(".council/specs");
    expect(out).toContain(".autopilot/state.json");
  });

  test("specifies the verify command verbatim", () => {
    const verify = "bun run autopilot verify --goal g3";
    const out = buildImplementationPrompt({
      goal,
      autopilotDocPath: "x", goalFilePath: "y", specFilePath: "z",
      verifyCommand: verify,
      maxIterations: 30,
    });
    expect(out).toContain(verify);
  });
});

describe("buildSynthesizerPrompt", () => {
  test("references each opinion file path", () => {
    const out = buildSynthesizerPrompt([
      "/tmp/sess/stage1/opinion_claude.json",
      "/tmp/sess/stage1/opinion_codex.json",
      "/tmp/sess/stage1/opinion_gemini.json",
    ]);
    expect(out).toContain("opinion_claude.json");
    expect(out).toContain("opinion_codex.json");
    expect(out).toContain("opinion_gemini.json");
  });

  test("instructs the synthesizer to emit verbatim GOALS block", () => {
    const out = buildSynthesizerPrompt(["/x"]);
    expect(out).toContain("===GOALS===");
    expect(out).toContain("verbatim");
  });

  test("provides the no-viable-decomposition fallback marker", () => {
    const out = buildSynthesizerPrompt(["/x"]);
    expect(out).toContain("===NO_VIABLE_DECOMPOSITION===");
  });
});
