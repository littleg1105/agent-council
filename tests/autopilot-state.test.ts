import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import {
  AUTOPILOT_STATE_SCHEMA_VERSION,
  defaultState,
  fileHash,
  goalId,
  readState,
  writeState,
  type AutopilotState,
  type Goal,
} from "../src/autopilot-state";

const tmpDir = resolve(import.meta.dir, ".tmp-autopilot-state-test");

afterAll(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("autopilot-state", () => {
  test("defaultState produces a valid initial state", () => {
    const s = defaultState("./goal.md", true);
    expect(s.schema_version).toBe(AUTOPILOT_STATE_SCHEMA_VERSION);
    expect(s.goal_file).toBe("./goal.md");
    expect(s.dry_run).toBe(true);
    expect(s.live_mode).toBe(false);
    expect(s.queue).toEqual([]);
    expect(s.completed).toEqual([]);
    expect(s.goals).toEqual([]);
    expect(s.paused_until).toBeNull();
  });

  test("defaultState with dryRun=false sets live_mode=true", () => {
    const s = defaultState("./goal.md", false);
    expect(s.dry_run).toBe(false);
    expect(s.live_mode).toBe(true);
  });

  test("readState returns null when file does not exist", () => {
    const dir = resolve(tmpDir, "missing");
    expect(readState(dir)).toBeNull();
  });

  test("writeState then readState round-trips identically", async () => {
    const dir = resolve(tmpDir, "round-trip");
    mkdirSync(dir, { recursive: true });
    const original: AutopilotState = {
      ...defaultState("./goal.md", true),
      queue: ["g1", "g2"],
      goals: [makeGoal("g1"), makeGoal("g2")],
    };
    await writeState(dir, original);
    const read = readState(dir);
    expect(read).toEqual(original);
  });

  test("readState rejects mismatched schema_version with a clear error", async () => {
    const dir = resolve(tmpDir, "bad-version");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, "state.json"),
      JSON.stringify({ schema_version: 999, goal_file: "x" }),
      "utf-8"
    );
    expect(() => readState(dir)).toThrow(/schema_version mismatch/);
  });

  test("writeState is atomic (writes via .tmp + rename)", async () => {
    // Verify by checking that the tmp file does NOT exist after a successful write.
    const dir = resolve(tmpDir, "atomic");
    mkdirSync(dir, { recursive: true });
    await writeState(dir, defaultState("./goal.md", true));
    expect(existsSync(resolve(dir, "state.json"))).toBe(true);
    expect(existsSync(resolve(dir, ".state.json.tmp"))).toBe(false);
  });

  test("goalId generates g1, g2, g3, ... from index", () => {
    expect(goalId(0)).toBe("g1");
    expect(goalId(1)).toBe("g2");
    expect(goalId(7)).toBe("g8");
  });

  test("fileHash produces stable sha256 hex for the same content", async () => {
    const dir = resolve(tmpDir, "hash");
    mkdirSync(dir, { recursive: true });
    const path = resolve(dir, "spec.test.ts");
    writeFileSync(path, "import { test } from 'bun:test';\ntest('x', () => {});\n", "utf-8");
    const hash1 = await fileHash(path);
    const hash2 = await fileHash(path);
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  test("fileHash returns empty string for non-existent file", async () => {
    expect(await fileHash(resolve(tmpDir, "does-not-exist.txt"))).toBe("");
  });
});

function makeGoal(id: string): Goal {
  return {
    id,
    title: `${id} title`,
    description: `${id} description`,
    spec_file: `.council/specs/${id}.test.ts`,
    spec_sha: "",
    status: "pending",
    green_commit: null,
    iteration: 0,
    last_test_hash: null,
    tracked_tree_hash: null,
    stuck_rescues_used: 0,
    failure_reason: null,
    notes_file: null,
  };
}
