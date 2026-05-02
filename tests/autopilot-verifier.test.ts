import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import { verifyInWorktree, verifySpecSha } from "../src/autopilot-verifier";
import { PROFILE_PYTHON_POETRY, PROFILE_TYPESCRIPT_BUN } from "../src/autopilot-profile";

const tmpDir = resolve(import.meta.dir, ".tmp-verifier-test");

afterAll(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("verifyInWorktree — shape and error path", () => {
  test("VerifyResult shape: passed/exitCode/stdout/stderr/command/durationMs all present", async () => {
    // Note: git's repo-discovery walks up parent dirs. Even a "non-repo"
    // tmp dir inside the agent-council source tree resolves to its parent.
    // The result shape is universal regardless — that's what we lock here.
    const dir = resolve(tmpDir, "shape");
    mkdirSync(dir, { recursive: true });
    const result = await verifyInWorktree({
      repoRoot: dir,
      commit: undefined,
      specPath: ".x-no-such-file",
      profile: PROFILE_TYPESCRIPT_BUN,
      timeoutMs: 5_000,
    });
    expect(typeof result.passed).toBe("boolean");
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.stdout).toBe("string");
    expect(typeof result.stderr).toBe("string");
    expect(typeof result.command).toBe("string");
    expect(typeof result.durationMs).toBe("number");
    expect(result.command).toContain("bun test");  // profile's spec_test_command was invoked
  });

  test("invalid commit ref produces failure result with non-zero exit", async () => {
    // /tmp/<random> is OUTSIDE any git repo, so git worktree truly fails.
    // Use OS tmp not the test fixtures dir (which lives inside our git tree).
    const { tmpdir } = await import("os");
    const dir = resolve(tmpdir(), `verifier-truly-no-repo-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const result = await verifyInWorktree({
        repoRoot: dir,
        commit: undefined,
        specPath: "spec.test.ts",
        profile: PROFILE_TYPESCRIPT_BUN,
        timeoutMs: 5_000,
      });
      expect(result.passed).toBe(false);
      expect(result.exitCode).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("verifySpecSha — frozen-spec defense", () => {
  test("matches when file content's hash equals expected", async () => {
    const dir = resolve(tmpDir, "sha-match");
    mkdirSync(dir, { recursive: true });
    mkdirSync(resolve(dir, ".council", "specs"), { recursive: true });
    const specPath = resolve(dir, ".council", "specs", "test_g1.py");
    writeFileSync(specPath, "import pytest\n\ndef test_g1():\n    assert True\n", "utf-8");
    const { fileHash } = await import("../src/autopilot-state");
    const expected = await fileHash(specPath);

    const out = await verifySpecSha({
      repoRoot: dir,
      specPath: ".council/specs/test_g1.py",
      expectedSha: expected,
    });
    expect(out.matches).toBe(true);
    expect(out.actualSha).toBe(expected);
  });

  test("does NOT match when file content has changed (frozen-spec violation)", async () => {
    const dir = resolve(tmpDir, "sha-mismatch");
    mkdirSync(dir, { recursive: true });
    mkdirSync(resolve(dir, ".council", "specs"), { recursive: true });
    const specPath = resolve(dir, ".council", "specs", "test_g1.py");
    writeFileSync(specPath, "import pytest\n\ndef test_g1():\n    assert True\n", "utf-8");
    const { fileHash } = await import("../src/autopilot-state");
    const original = await fileHash(specPath);

    // Tamper
    writeFileSync(specPath, "import pytest\n\ndef test_g1():\n    pass  # cheated!\n", "utf-8");

    const out = await verifySpecSha({
      repoRoot: dir,
      specPath: ".council/specs/test_g1.py",
      expectedSha: original,
    });
    expect(out.matches).toBe(false);
    expect(out.actualSha).not.toBe(original);
  });
});
