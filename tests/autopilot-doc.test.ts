import { describe, test, expect } from "bun:test";
import { renderAutopilotDoc } from "../src/autopilot-doc";
import { defaultState, type AutopilotState, type Goal } from "../src/autopilot-state";

function makeGoal(id: string, status: Goal["status"] = "pending", title = `${id} title`): Goal {
  return {
    id,
    title,
    description: `${id} description`,
    spec_file: `.council/specs/${id}.test.ts`,
    spec_sha: "abc123",
    status,
    green_commit: status === "done" ? "deadbeef" : null,
    iteration: 0,
    last_test_hash: null,
    tracked_tree_hash: null,
    stuck_rescues_used: 0,
    failure_reason: null,
    notes_file: null,
  };
}

describe("renderAutopilotDoc", () => {
  test("includes the original user goal verbatim", () => {
    const state = makeStateWithGoals([], false);
    const doc = renderAutopilotDoc({
      state,
      userGoalText: "Build a Markov chain text generator with stress tests.",
      currentGoalId: null,
    });
    expect(doc).toContain("Build a Markov chain text generator with stress tests.");
  });

  test("highlights the current goal with 'YOU ARE HERE' marker", () => {
    const state = makeStateWithGoals(
      [makeGoal("g1", "done"), makeGoal("g2", "in_progress"), makeGoal("g3", "pending")],
      true
    );
    const doc = renderAutopilotDoc({
      state,
      userGoalText: "x",
      currentGoalId: "g2",
    });
    expect(doc).toContain("g2");
    expect(doc).toContain("YOU ARE HERE");
  });

  test("surfaces hard rules verbatim (frozen specs, no state edits, no destructive git)", () => {
    const state = makeStateWithGoals([], false);
    const doc = renderAutopilotDoc({ state, userGoalText: "x", currentGoalId: null });
    expect(doc).toContain("Frozen specs");
    expect(doc).toContain(".council/specs/");
    expect(doc).toContain(".autopilot/state.json");
    expect(doc.toLowerCase()).toContain("destructive git");
  });

  test("dry-run mode is reflected in the snapshot", () => {
    const state = makeStateWithGoals([], false);
    const doc = renderAutopilotDoc({ state, userGoalText: "x", currentGoalId: null });
    expect(doc).toContain("DRY-RUN");
  });

  test("live mode is reflected in the snapshot", () => {
    const state = makeStateWithGoals([], true);
    const doc = renderAutopilotDoc({ state, userGoalText: "x", currentGoalId: null });
    expect(doc).toContain("LIVE");
  });

  test("completed-goal summaries appear with their green commit", () => {
    const state = makeStateWithGoals(
      [makeGoal("g1", "done", "Completed thing"), makeGoal("g2", "pending")],
      true
    );
    state.completed = ["g1"];
    const doc = renderAutopilotDoc({ state, userGoalText: "x", currentGoalId: "g2" });
    expect(doc).toContain("Completed thing");
    expect(doc).toContain("deadbeef"); // the fake green_commit
  });

  test("status icons are correct for each state", () => {
    const state = makeStateWithGoals(
      [
        makeGoal("g1", "done"),
        makeGoal("g2", "in_progress"),
        makeGoal("g3", "needs_review"),
        makeGoal("g4", "pending"),
        makeGoal("g5", "failed"),
      ],
      true
    );
    const doc = renderAutopilotDoc({ state, userGoalText: "x", currentGoalId: null });
    expect(doc).toContain("[x] **g1**");  // done
    expect(doc).toContain("[~] **g2**");  // in_progress
    expect(doc).toContain("[?] **g3**");  // needs_review
    expect(doc).toContain("[ ] **g4**");  // pending
    expect(doc).toContain("[!] **g5**");  // failed
  });
});

function makeStateWithGoals(goals: Goal[], live: boolean): AutopilotState {
  return {
    ...defaultState("./goal.md", !live),
    goals,
    queue: goals.map((g) => g.id),
    last_green_commit: live ? "abc123" : null,
  };
}
