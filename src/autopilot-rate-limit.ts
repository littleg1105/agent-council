/**
 * Rate-limit detection for the autopilot.
 *
 * Under subscription mode (no per-token billing), what bounds an unattended
 * run is rate-limit windows, not dollar costs. This module parses each CLI's
 * stderr/stdout for rate-limit signals and returns a structured result so the
 * orchestrator can decide whether to auto-pause-and-resume.
 *
 * PR8 ships the detector + tests. PR9 wires it into the live implementation
 * loop with actual pause-and-resume behavior.
 *
 * Per-CLI signal patterns observed in the wild (best-effort; subject to CLI
 * version drift — verify against your installed versions):
 *
 *   Claude Code: messages mentioning "usage limit", "rate limit", "quota",
 *                or HTTP 429 in error responses. The CLI's `claude -p` exits
 *                non-zero with the message in stderr.
 *
 *   Codex (OpenAI): HTTP 429 errors, "rate_limit_exceeded", "quota_exceeded".
 *                   The CLI surfaces these in stderr with structured prefixes.
 *
 *   Gemini: HTTP 429, "RESOURCE_EXHAUSTED", "quota". The Gemini CLI's stderr
 *           includes a `ModelError` with these classifications.
 */

import type { AgentId } from "./adapters";

export type RateLimitWindow = "5h" | "1h" | "1m" | "1d" | "unknown";

export interface RateLimitSignal {
  isRateLimited: boolean;
  agent: AgentId;
  window: RateLimitWindow;
  /** ISO timestamp when the window resets. null if unknown. */
  resetsAt: string | null;
  /** Raw matched substring for diagnostics (truncated to 200 chars). */
  evidence: string;
}

const NOT_RATE_LIMITED = (agent: AgentId): RateLimitSignal => ({
  isRateLimited: false,
  agent,
  window: "unknown",
  resetsAt: null,
  evidence: "",
});

/**
 * Patterns are ordered: more-specific window indicators first. Each pattern
 * captures (a) whether the line is a rate-limit signal and (b) what window
 * type it implies. Window-specific patterns let the orchestrator schedule
 * resumes appropriately.
 */
interface Pattern {
  re: RegExp;
  window: RateLimitWindow;
}

const CLAUDE_PATTERNS: Pattern[] = [
  // Claude Code Pro/Max usage windows are 5-hourly
  { re: /usage limit (?:reached|exceeded)/i, window: "5h" },
  { re: /message limit/i, window: "5h" },
  { re: /5[\s-]?hour/i, window: "5h" },
  { re: /rate.?limit(?:ed)?/i, window: "unknown" },
  { re: /\b429\b/, window: "unknown" },
  { re: /quota.{0,30}exceeded/i, window: "unknown" },
];

const CODEX_PATTERNS: Pattern[] = [
  { re: /rate_limit_exceeded/i, window: "1h" },
  { re: /rate.?limit(?:ed)?/i, window: "1h" },
  { re: /\b429\b/, window: "1h" },
  { re: /quota.{0,30}exceeded/i, window: "unknown" },
  { re: /weekly.{0,30}limit/i, window: "1d" },
];

const GEMINI_PATTERNS: Pattern[] = [
  { re: /RESOURCE_EXHAUSTED/i, window: "1m" },     // Gemini RPM is per-minute
  { re: /\b429\b/, window: "1m" },
  { re: /quota.{0,30}(?:exceeded|exhausted)/i, window: "1d" },
  { re: /rate.?limit(?:ed)?/i, window: "1m" },
];

function matchPatterns(text: string, patterns: Pattern[]): { window: RateLimitWindow; evidence: string } | null {
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) {
      const start = Math.max(0, m.index! - 60);
      const end = Math.min(text.length, m.index! + m[0].length + 60);
      const evidence = text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 200);
      return { window: p.window, evidence };
    }
  }
  return null;
}

function windowToResetMs(window: RateLimitWindow): number | null {
  switch (window) {
    case "1m": return 60_000;
    case "1h": return 60 * 60_000;
    case "5h": return 5 * 60 * 60_000;
    case "1d": return 24 * 60 * 60_000;
    case "unknown": return null;
  }
}

/**
 * Detect rate-limit signal in a CLI's stderr (and optionally stdout).
 * Returns a structured signal; orchestrator decides what to do with it.
 */
export function detectRateLimit(
  agent: AgentId,
  stderr: string,
  stdout: string = ""
): RateLimitSignal {
  const patterns = ({
    claude: CLAUDE_PATTERNS,
    codex: CODEX_PATTERNS,
    gemini: GEMINI_PATTERNS,
  } as const)[agent];
  const text = `${stderr}\n${stdout}`;
  const match = matchPatterns(text, patterns);
  if (!match) return NOT_RATE_LIMITED(agent);
  const resetMs = windowToResetMs(match.window);
  const resetsAt = resetMs ? new Date(Date.now() + resetMs).toISOString() : null;
  return {
    isRateLimited: true,
    agent,
    window: match.window,
    resetsAt,
    evidence: match.evidence,
  };
}

/**
 * Compute the soonest-resume timestamp from multiple per-agent signals.
 * Returns null if none are rate-limited (caller should not pause).
 */
export function computeResumeAt(signals: RateLimitSignal[]): string | null {
  const limited = signals.filter((s) => s.isRateLimited && s.resetsAt !== null);
  if (limited.length === 0) return null;
  const earliest = limited.reduce((min, s) => {
    if (!min) return s;
    return new Date(s.resetsAt!) < new Date(min.resetsAt!) ? s : min;
  }, null as RateLimitSignal | null);
  return earliest?.resetsAt ?? null;
}
