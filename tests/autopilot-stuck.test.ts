import { describe, test, expect } from "bun:test";
import {
  computeFailureSignature,
  detectStuck,
  sameFailure,
  type FailureSignature,
  type StuckHistory,
} from "../src/autopilot-stuck";
import {
  PROFILE_PYTHON_POETRY,
  PROFILE_TYPESCRIPT_BUN,
  PROFILE_GO,
  PROFILE_RUST,
  PROFILE_RUBY_RSPEC,
  PROFILE_GENERIC,
} from "../src/autopilot-profile";
import type { VerifyResult } from "../src/autopilot-verifier";

function vr(stdout: string, stderr: string = "", exitCode: number = 1): VerifyResult {
  return { passed: false, exitCode, stdout, stderr, command: "test", durationMs: 100 };
}

describe("computeFailureSignature — pytest", () => {
  test("extracts FAILED test ids", () => {
    const out = `=================================== FAILURES ===================================
______________________________ test_g3_runner ___________________________________

    def test_g3_runner():
>       assert 1 == 2
E       assert 1 == 2

tests/test_g3.py:14: AssertionError
=========================== short test summary info ============================
FAILED tests/test_g3.py::test_g3_runner - assert 1 == 2
FAILED tests/test_g3.py::test_g3_other - ...
==================== 2 failed in 0.04s ========================================
`;
    const sig = computeFailureSignature(vr(out), PROFILE_PYTHON_POETRY);
    expect(sig.failingTestIds).toEqual([
      "tests/test_g3.py::test_g3_other",
      "tests/test_g3.py::test_g3_runner",  // sorted
    ]);
    expect(sig.firstAssertionLocation).toBe("tests/test_g3.py:14");
    expect(sig.exitCode).toBe(1);
  });

  test("first assertion skips files under .council/specs/", () => {
    const out = `.council/specs/test_g3.py:5: AssertionError
src/secreqgen/foo.py:42: ValueError
src/secreqgen/bar.py:99: TypeError
`;
    const sig = computeFailureSignature(vr(out), PROFILE_PYTHON_POETRY);
    expect(sig.firstAssertionLocation).toBe("src/secreqgen/foo.py:42");
  });
});

describe("computeFailureSignature — bun:test", () => {
  test("extracts (fail) lines", () => {
    const out = `tests/foo.test.ts:
(fail) my suite > does the thing [1.20ms]
(fail) my suite > does another thing [0.34ms]
`;
    const sig = computeFailureSignature(vr(out), PROFILE_TYPESCRIPT_BUN);
    expect(sig.failingTestIds).toEqual([
      "my suite > does another thing",
      "my suite > does the thing",
    ]);
  });
});

describe("computeFailureSignature — go test", () => {
  test("extracts --- FAIL lines", () => {
    const out = `=== RUN   TestG1
    foo_test.go:42: expected 4 got 5
--- FAIL: TestG1 (0.01s)
=== RUN   TestG2
--- FAIL: TestG2 (0.00s)
FAIL
exit status 1
`;
    const sig = computeFailureSignature(vr(out), PROFILE_GO);
    expect(sig.failingTestIds).toEqual(["TestG1", "TestG2"]);
    expect(sig.firstAssertionLocation).toBe("foo_test.go:42");
  });
});

describe("computeFailureSignature — cargo test", () => {
  test("extracts test ... FAILED lines", () => {
    const out = `running 2 tests
test foo::bar ... FAILED
test foo::baz ... FAILED

failures:

---- foo::bar stdout ----
thread 'foo::bar' panicked at 'assertion failed', src/lib.rs:99
`;
    const sig = computeFailureSignature(vr(out), PROFILE_RUST);
    expect(sig.failingTestIds).toEqual(["foo::bar", "foo::baz"]);
  });
});

describe("computeFailureSignature — RSpec", () => {
  test("extracts numbered failures after Failures: header", () => {
    const out = `Failures:

  1) MyClass#do_thing returns expected value
     Failure/Error: expect(thing).to eq(42)
       expected: 42
            got: 41

  2) MyClass#another fails for other reason
     Failure/Error: ...
`;
    const sig = computeFailureSignature(vr(out), PROFILE_RUBY_RSPEC);
    expect(sig.failingTestIds).toContain("MyClass#do_thing returns expected value");
    expect(sig.failingTestIds.length).toBe(2);
  });
});

describe("computeFailureSignature — generic profile (no extractor)", () => {
  test("falls back to normalized hash when no per-runner parser", () => {
    const sig = computeFailureSignature(vr("some opaque output"), PROFILE_GENERIC);
    expect(sig.failingTestIds).toEqual([]);
    expect(sig.normalizedOutputHash.length).toBeGreaterThan(0);
  });
});

describe("normalized output hash — strips noise", () => {
  test("same content with different timings produces same hash", () => {
    const a = computeFailureSignature(vr("test foo failed in 12ms\nresult: 5 passed, 3 failed"), PROFILE_GENERIC);
    const b = computeFailureSignature(vr("test foo failed in 47ms\nresult: 7 passed, 1 failed"), PROFILE_GENERIC);
    expect(a.normalizedOutputHash).toBe(b.normalizedOutputHash);
  });

  test("same content with different temp paths produces same hash", () => {
    const a = computeFailureSignature(vr("opened /tmp/abc123/foo.py at line 5"), PROFILE_GENERIC);
    const b = computeFailureSignature(vr("opened /tmp/xyz789/foo.py at line 5"), PROFILE_GENERIC);
    expect(a.normalizedOutputHash).toBe(b.normalizedOutputHash);
  });

  test("genuinely different content produces different hashes", () => {
    const a = computeFailureSignature(vr("foo failed: expected 4 got 5"), PROFILE_GENERIC);
    const b = computeFailureSignature(vr("bar failed: null pointer"), PROFILE_GENERIC);
    expect(a.normalizedOutputHash).not.toBe(b.normalizedOutputHash);
  });
});

describe("sameFailure — comparison logic", () => {
  test("same exit code + same test ids = same failure", () => {
    const a: FailureSignature = { exitCode: 1, failingTestIds: ["t1", "t2"], firstAssertionLocation: "", normalizedOutputHash: "x" };
    const b: FailureSignature = { exitCode: 1, failingTestIds: ["t1", "t2"], firstAssertionLocation: "", normalizedOutputHash: "y" };
    expect(sameFailure(a, b)).toBe(true);
  });

  test("different exit code = different failure", () => {
    const a: FailureSignature = { exitCode: 1, failingTestIds: ["t1"], firstAssertionLocation: "", normalizedOutputHash: "x" };
    const b: FailureSignature = { exitCode: 2, failingTestIds: ["t1"], firstAssertionLocation: "", normalizedOutputHash: "x" };
    expect(sameFailure(a, b)).toBe(false);
  });

  test("falls back to first-assertion-location when test ids missing on one side", () => {
    const a: FailureSignature = { exitCode: 1, failingTestIds: [], firstAssertionLocation: "src/foo.py:42", normalizedOutputHash: "x" };
    const b: FailureSignature = { exitCode: 1, failingTestIds: [], firstAssertionLocation: "src/foo.py:42", normalizedOutputHash: "y" };
    expect(sameFailure(a, b)).toBe(true);
  });

  test("falls back to normalized hash when both ids and location missing", () => {
    const a: FailureSignature = { exitCode: 1, failingTestIds: [], firstAssertionLocation: "", normalizedOutputHash: "h1" };
    const b: FailureSignature = { exitCode: 1, failingTestIds: [], firstAssertionLocation: "", normalizedOutputHash: "h1" };
    const c: FailureSignature = { exitCode: 1, failingTestIds: [], firstAssertionLocation: "", normalizedOutputHash: "h2" };
    expect(sameFailure(a, b)).toBe(true);
    expect(sameFailure(a, c)).toBe(false);
  });
});

describe("detectStuck — Fork 3C weighted heuristic", () => {
  function fakeSig(testId: string): FailureSignature {
    return { exitCode: 1, failingTestIds: [testId], firstAssertionLocation: "", normalizedOutputHash: testId };
  }

  test("not stuck on first iteration", () => {
    const h: StuckHistory = {
      signatures: [fakeSig("t1")],
      treeHashes: ["a"],
      lastGreenAt: new Date().toISOString(),
    };
    const r = detectStuck(h);
    expect(r.stuck).toBe(false);
  });

  test("PRIMARY: same-failure 5x with tree advancing → stuck", () => {
    const h: StuckHistory = {
      signatures: [fakeSig("t1"), fakeSig("t1"), fakeSig("t1"), fakeSig("t1"), fakeSig("t1")],
      treeHashes: ["a", "b", "c", "d", "e"],  // tree changed each iteration
      lastGreenAt: new Date().toISOString(),
    };
    const r = detectStuck(h);
    expect(r.stuck).toBe(true);
    if (r.stuck) expect(r.reason).toBe("same_failure_with_git_advance");
  });

  test("PRIMARY does NOT trigger when tree is also unchanged (LIVENESS handles that)", () => {
    const h: StuckHistory = {
      signatures: [fakeSig("t1"), fakeSig("t1"), fakeSig("t1"), fakeSig("t1"), fakeSig("t1")],
      treeHashes: ["a", "a", "a", "a", "a"],  // tree never changed
      lastGreenAt: new Date().toISOString(),
    };
    const r = detectStuck(h);
    expect(r.stuck).toBe(true);
    // Liveness is the more specific failure mode; primary's "tree advancing" condition fails
    if (r.stuck) expect(r.reason).toBe("tree_unchanged_3_cycles");
  });

  test("PRIMARY does NOT trigger when failures vary across iterations", () => {
    const h: StuckHistory = {
      signatures: [fakeSig("t1"), fakeSig("t2"), fakeSig("t1"), fakeSig("t3"), fakeSig("t1")],
      treeHashes: ["a", "b", "c", "d", "e"],
      lastGreenAt: new Date().toISOString(),
    };
    const r = detectStuck(h);
    expect(r.stuck).toBe(false);
  });

  test("BACKSTOP: lastGreenAt > 30 min ago → stuck", () => {
    const oldGreen = new Date(Date.now() - 31 * 60_000).toISOString();
    const h: StuckHistory = {
      signatures: [fakeSig("t1"), fakeSig("t2")],
      treeHashes: ["a", "b"],
      lastGreenAt: oldGreen,
    };
    const r = detectStuck(h);
    expect(r.stuck).toBe(true);
    if (r.stuck) expect(r.reason).toBe("no_green_for_30min");
  });

  test("LIVENESS: tree-unchanged 3+ cycles → stuck", () => {
    const h: StuckHistory = {
      signatures: [fakeSig("t1"), fakeSig("t2"), fakeSig("t3")],
      treeHashes: ["a", "a", "a"],
      lastGreenAt: new Date().toISOString(),
    };
    const r = detectStuck(h);
    expect(r.stuck).toBe(true);
    if (r.stuck) expect(r.reason).toBe("tree_unchanged_3_cycles");
  });

  test("LIVENESS: tree-unchanged 2 cycles is NOT stuck (need 3)", () => {
    const h: StuckHistory = {
      signatures: [fakeSig("t1"), fakeSig("t2")],
      treeHashes: ["a", "a"],
      lastGreenAt: new Date().toISOString(),
    };
    const r = detectStuck(h);
    expect(r.stuck).toBe(false);
  });
});
