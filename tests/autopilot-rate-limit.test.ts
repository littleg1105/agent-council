import { describe, test, expect } from "bun:test";
import { computeResumeAt, detectRateLimit } from "../src/autopilot-rate-limit";

describe("detectRateLimit — Claude", () => {
  test("matches 'usage limit reached' as 5h window", () => {
    const sig = detectRateLimit("claude", "Error: Usage limit reached for this 5-hour window. Try again at 2pm.");
    expect(sig.isRateLimited).toBe(true);
    expect(sig.window).toBe("5h");
    expect(sig.resetsAt).not.toBeNull();
  });

  test("matches 'rate limit' generic", () => {
    const sig = detectRateLimit("claude", "rate limit exceeded");
    expect(sig.isRateLimited).toBe(true);
  });

  test("matches HTTP 429 in stderr", () => {
    const sig = detectRateLimit("claude", "HTTP 429 Too Many Requests");
    expect(sig.isRateLimited).toBe(true);
  });

  test("returns false for normal stderr (skill conflict warnings, etc.)", () => {
    const sig = detectRateLimit("claude", "Skill conflict detected: 'foo' overriding 'bar'");
    expect(sig.isRateLimited).toBe(false);
    expect(sig.evidence).toBe("");
  });

  test("returns false for empty stderr", () => {
    const sig = detectRateLimit("claude", "");
    expect(sig.isRateLimited).toBe(false);
  });
});

describe("detectRateLimit — Codex", () => {
  test("matches 'rate_limit_exceeded' as 1h window", () => {
    const sig = detectRateLimit("codex", "Error: rate_limit_exceeded for org");
    expect(sig.isRateLimited).toBe(true);
    expect(sig.window).toBe("1h");
  });

  test("matches HTTP 429", () => {
    const sig = detectRateLimit("codex", "API returned 429");
    expect(sig.isRateLimited).toBe(true);
  });

  test("matches 'weekly limit' as 1d window (proxy for resume)", () => {
    const sig = detectRateLimit("codex", "weekly limit reached");
    expect(sig.isRateLimited).toBe(true);
    expect(sig.window).toBe("1d");
  });
});

describe("detectRateLimit — Gemini", () => {
  test("matches 'RESOURCE_EXHAUSTED' as 1m window (per-RPM limits)", () => {
    const sig = detectRateLimit("gemini", "Error: RESOURCE_EXHAUSTED");
    expect(sig.isRateLimited).toBe(true);
    expect(sig.window).toBe("1m");
  });

  test("matches 'quota exhausted' as 1d window", () => {
    const sig = detectRateLimit("gemini", "quota exhausted for the day");
    expect(sig.isRateLimited).toBe(true);
    expect(sig.window).toBe("1d");
  });

  test("returns false for skill-conflict noise", () => {
    const sig = detectRateLimit("gemini", "Skill conflict detected: council overriding agent-council");
    expect(sig.isRateLimited).toBe(false);
  });
});

describe("detectRateLimit evidence capture", () => {
  test("evidence is a short context snippet around the match", () => {
    const stderr = "Some preceding context. Error: rate limit exceeded due to abuse. Following context.";
    const sig = detectRateLimit("claude", stderr);
    expect(sig.isRateLimited).toBe(true);
    expect(sig.evidence.length).toBeGreaterThan(0);
    expect(sig.evidence.length).toBeLessThanOrEqual(200);
    expect(sig.evidence.toLowerCase()).toContain("rate limit");
  });
});

describe("computeResumeAt", () => {
  test("returns null when nothing is rate-limited", () => {
    const all = [
      { isRateLimited: false, agent: "claude" as const, window: "unknown" as const, resetsAt: null, evidence: "" },
      { isRateLimited: false, agent: "codex" as const, window: "unknown" as const, resetsAt: null, evidence: "" },
    ];
    expect(computeResumeAt(all)).toBeNull();
  });

  test("returns the soonest reset across multiple limited agents", () => {
    const sooner = new Date(Date.now() + 60_000).toISOString();
    const later = new Date(Date.now() + 5 * 60 * 60_000).toISOString();
    const all = [
      { isRateLimited: true, agent: "claude" as const, window: "5h" as const, resetsAt: later, evidence: "x" },
      { isRateLimited: true, agent: "gemini" as const, window: "1m" as const, resetsAt: sooner, evidence: "y" },
    ];
    expect(computeResumeAt(all)).toBe(sooner);
  });

  test("ignores limited agents with null resetsAt (window=unknown)", () => {
    const known = new Date(Date.now() + 3600_000).toISOString();
    const all = [
      { isRateLimited: true, agent: "claude" as const, window: "unknown" as const, resetsAt: null, evidence: "x" },
      { isRateLimited: true, agent: "codex" as const, window: "1h" as const, resetsAt: known, evidence: "y" },
    ];
    expect(computeResumeAt(all)).toBe(known);
  });
});
