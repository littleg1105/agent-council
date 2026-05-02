import { describe, test, expect } from "bun:test";
import {
  MAX_LEAF_GOALS,
  buildBootstrapPrompt,
  buildImplementationPrompt,
  buildSynthesizerPrompt,
  parseGoalsBlock,
} from "../src/autopilot-prompts";
import type { Goal } from "../src/autopilot-state";
import {
  PROFILE_TYPESCRIPT_BUN,
  PROFILE_PYTHON_POETRY,
  PROFILE_PYTHON_PYTEST,
  PROFILE_GO,
  PROFILE_RUST,
  PROFILE_RUBY_RSPEC,
  PROFILE_GENERIC,
} from "../src/autopilot-profile";

describe("buildBootstrapPrompt", () => {
  test("includes the user goal verbatim", () => {
    const out = buildBootstrapPrompt("Build a Markov chain text generator with stress tests.", PROFILE_TYPESCRIPT_BUN);
    expect(out).toContain("Build a Markov chain text generator with stress tests.");
  });

  test("instructs the structured GOALS block format", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_TYPESCRIPT_BUN);
    expect(out).toContain("===GOALS===");
    expect(out).toContain("===END===");
    expect(out).toContain("spec_content");
  });

  test("declares the leaf cap", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_TYPESCRIPT_BUN);
    expect(out).toContain(`Maximum ${MAX_LEAF_GOALS}`);
  });
});

describe("buildBootstrapPrompt — multi-architecture (PR9)", () => {
  test("TypeScript+Bun profile: prompt mentions bun:test and bun test", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_TYPESCRIPT_BUN);
    expect(out).toContain("Bun + TypeScript");
    expect(out).toContain("bun:test");
    expect(out).toContain("bun test");
    expect(out).toContain(".test.ts");
  });

  test("Python+Poetry profile: prompt mentions pytest and poetry run pytest, NOT bun", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_PYTHON_POETRY);
    expect(out).toContain("pytest");
    expect(out).toContain("poetry run pytest");
    expect(out).not.toContain("bun:test");
    expect(out).not.toContain("Bun + TypeScript");
  });

  test("Python+pytest profile: prompt mentions pytest, NOT poetry", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_PYTHON_PYTEST);
    expect(out).toContain("pytest");
    expect(out).not.toContain("poetry run");
    expect(out).not.toContain("bun:test");
  });

  test("Go profile: prompt mentions go test and warns about package-aware discovery", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_GO);
    expect(out).toContain("Go");
    expect(out).toContain("go test");
    expect(out).toContain("package-aware");
    expect(out).not.toContain("bun:test");
  });

  test("Rust profile: prompt mentions cargo test and tests/ directory convention", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_RUST);
    expect(out).toContain("Rust");
    expect(out).toContain("cargo test");
    expect(out).toContain("tests/");
    expect(out).not.toContain("bun:test");
  });

  test("Ruby+RSpec profile: prompt mentions rspec and bundle exec", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_RUBY_RSPEC);
    expect(out).toContain("RSpec");
    expect(out).toContain("bundle exec rspec");
    expect(out).toContain("_spec.rb");
    expect(out).not.toContain("bun:test");
  });

  test("Generic profile: prompt warns about no test runner configured", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_GENERIC);
    expect(out.toLowerCase()).toContain("no project type");
    expect(out).not.toContain("bun:test");
  });

  test("Spec example shape from the profile is included", () => {
    const out = buildBootstrapPrompt("any goal", PROFILE_PYTHON_POETRY);
    expect(out).toContain("def test_g1");
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
