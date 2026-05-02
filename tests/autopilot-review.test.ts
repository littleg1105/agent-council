import { describe, test, expect } from "bun:test";
import {
  ALL_VETO_CODES,
  buildFinalReviewPrompt,
  parseAgentVerdict,
  synthesizeVerdict,
  type VetoCode,
} from "../src/autopilot-review";
import { PROFILE_PYTHON_POETRY } from "../src/autopilot-profile";
import type { Goal } from "../src/autopilot-state";

const sampleGoal: Goal = {
  id: "g1",
  title: "do the thing",
  description: "thing description",
  spec_file: ".council/specs/test_g1.py",
  spec_sha: "abc",
  status: "done",
  green_commit: "deadbeef",
  iteration: 5,
  last_test_hash: null,
  tracked_tree_hash: null,
  stuck_rescues_used: 0,
  failure_reason: null,
  notes_file: null,
};

describe("buildFinalReviewPrompt", () => {
  test("includes the user goal verbatim", () => {
    const out = buildFinalReviewPrompt({
      userGoalText: "Build a thing that does X.",
      goals: [sampleGoal],
      diffSummary: "x",
      diffContent: "y",
      specsCombined: "z",
      profile: PROFILE_PYTHON_POETRY,
    });
    expect(out).toContain("Build a thing that does X.");
  });

  test("instructs only the 4 allowed VETO codes", () => {
    const out = buildFinalReviewPrompt({
      userGoalText: "g", goals: [sampleGoal], diffSummary: "x", diffContent: "y", specsCombined: "z",
      profile: PROFILE_PYTHON_POETRY,
    });
    for (const code of ALL_VETO_CODES) {
      expect(out).toContain(code);
    }
  });

  test("explicitly rejects soft objections (coverage/refactoring/idiomatic)", () => {
    const out = buildFinalReviewPrompt({
      userGoalText: "g", goals: [sampleGoal], diffSummary: "x", diffContent: "y", specsCombined: "z",
      profile: PROFILE_PYTHON_POETRY,
    });
    expect(out).toContain("Coverage feels low");
    expect(out).toContain("more refactoring");
    expect(out).toContain("more idiomatic");
  });

  test("instructs the VETO/OK marker format", () => {
    const out = buildFinalReviewPrompt({
      userGoalText: "g", goals: [sampleGoal], diffSummary: "x", diffContent: "y", specsCombined: "z",
      profile: PROFILE_PYTHON_POETRY,
    });
    expect(out).toContain("===VERDICT_VETO===");
    expect(out).toContain("===VERDICT_OK===");
  });

  test("includes the goal decomposition + diff content", () => {
    const out = buildFinalReviewPrompt({
      userGoalText: "g",
      goals: [sampleGoal],
      diffSummary: "src/foo.py | 12 ++++--",
      diffContent: "diff --git a/src/foo.py b/src/foo.py\n+def foo(): pass",
      specsCombined: "import pytest\ndef test_g1(): pass",
      profile: PROFILE_PYTHON_POETRY,
    });
    expect(out).toContain("g1");
    expect(out).toContain("do the thing");
    expect(out).toContain("src/foo.py | 12");
    expect(out).toContain("def foo(): pass");
    expect(out).toContain("import pytest");
  });
});

describe("parseAgentVerdict", () => {
  test("parses VERDICT_VETO with valid code", () => {
    const out = `Some reasoning.

===VERDICT_VETO===
SPEC_MISMATCH
The diff at src/foo.py:42 returns the wrong type — spec asserts int, got str.
`;
    const v = parseAgentVerdict(out);
    expect(v).not.toBeNull();
    expect(v!.kind).toBe("veto");
    if (v!.kind === "veto") {
      expect(v.code).toBe("SPEC_MISMATCH");
      expect(v.reasoning).toContain("src/foo.py:42");
    }
  });

  test("parses VERDICT_OK", () => {
    const out = `Looked at the diff carefully.

===VERDICT_OK===
None of the four reject criteria apply. Implementation is real, scope is right.
`;
    const v = parseAgentVerdict(out);
    expect(v).not.toBeNull();
    expect(v!.kind).toBe("ok");
  });

  test("rejects veto with INVALID reject code (returns null, conservative)", () => {
    const out = `===VERDICT_VETO===
COVERAGE_LOW
Tests don't cover edge cases.
`;
    const v = parseAgentVerdict(out);
    expect(v).toBeNull();
  });

  test("returns null when no marker present", () => {
    expect(parseAgentVerdict("just a wall of text with no marker")).toBeNull();
  });

  test("each of the 4 valid codes is accepted", () => {
    for (const code of ALL_VETO_CODES) {
      const v = parseAgentVerdict(`===VERDICT_VETO===\n${code}\nreason\n`);
      expect(v).not.toBeNull();
      if (v!.kind === "veto") expect(v.code).toBe(code);
    }
  });
});

describe("synthesizeVerdict", () => {
  function veto(code: VetoCode, reasoning = "r"): { kind: "veto"; code: VetoCode; reasoning: string } {
    return { kind: "veto", code, reasoning };
  }
  function ok(reasoning = "r"): { kind: "ok"; reasoning: string } {
    return { kind: "ok", reasoning };
  }

  test("3/3 same-code VETO → vetoed with that code", () => {
    const v = synthesizeVerdict([veto("SPEC_MISMATCH"), veto("SPEC_MISMATCH"), veto("SPEC_MISMATCH")]);
    expect(v.vetoed).toBe(true);
    expect(v.code).toBe("SPEC_MISMATCH");
  });

  test("2/3 same-code VETO → vetoed", () => {
    const v = synthesizeVerdict([veto("PLACEHOLDER_LOGIC"), veto("PLACEHOLDER_LOGIC"), ok()]);
    expect(v.vetoed).toBe(true);
    expect(v.code).toBe("PLACEHOLDER_LOGIC");
  });

  test("2 vetos with DIFFERENT codes → vetoed; pick most-counted (or by registration order on tie)", () => {
    // 2 different codes, each w/ 1 vote — picks one (registration-order by enum walk)
    const v = synthesizeVerdict([veto("SCOPE_BREACH"), veto("SPEC_MISMATCH"), ok()]);
    expect(v.vetoed).toBe(true);
    // SPEC_MISMATCH comes first in ALL_VETO_CODES
    expect(v.code).toBe("SPEC_MISMATCH");
  });

  test("3/3 OK → approved", () => {
    const v = synthesizeVerdict([ok(), ok(), ok()]);
    expect(v.vetoed).toBe(false);
    expect(v.code).toBeUndefined();
  });

  test("1 lone VETO + 2 OK → approved (verifier-pass remains source of truth)", () => {
    const v = synthesizeVerdict([veto("SPEC_MISMATCH"), ok(), ok()]);
    expect(v.vetoed).toBe(false);
  });

  test("1 VETO + 1 OK + 1 unparseable → CONSERVATIVE veto (not enough OK to override)", () => {
    const v = synthesizeVerdict([veto("SPEC_MISMATCH"), ok(), null]);
    expect(v.vetoed).toBe(true);
  });

  test("0 vetos + 0 oks (all unparseable) → approved (defer to verifier)", () => {
    const v = synthesizeVerdict([null, null, null]);
    expect(v.vetoed).toBe(false);
  });
});
