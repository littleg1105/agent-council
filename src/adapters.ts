import { resolve } from "path";

// --- Types ---

export type AgentId = "claude" | "codex" | "gemini";

export type EffortLevel = "max" | "high" | "medium" | "low" | "off";

export interface DispatchOptions {
  effort: EffortLevel;
  stream: boolean;
  model?: string;
}

export const DEFAULT_DISPATCH_OPTIONS: DispatchOptions = {
  effort: "off",
  stream: false,
};

export interface SessionOutcome {
  result: string;
  recorded_at: string;
}

export interface SessionMeta {
  id: string;
  question: string;
  project: string;
  chairman: AgentId;
  members: AgentId[];
  mode: "fast" | "thorough" | "quick";
  created_at: string;
  context_files: string[];
  parent_id: string | null;
  revisits: string[];
  outcome?: SessionOutcome;
  schema_version?: number;
}

export type ErrorClass = "auth" | "rate_limit" | "timeout" | "parse" | "startup" | "unknown";

export interface AgentResult {
  agent: AgentId;
  model?: string;
  status: "ok" | "error" | "timeout";
  structured: boolean;
  response: string;
  recommendation?: string;
  reasoning?: string[];
  assumptions?: string[];
  belief_update_trigger?: string;
  tradeoffs?: string;
  confidence?: string;
  dissent_points?: string;
  raw_response?: string;
  error?: string;
  error_class?: ErrorClass;
  raw_stderr?: string;
  duration_ms: number;
  timestamp: string;
  // Set on timeout when the buffered stdout had parseable content (additive, optional).
  // The chairman synthesis ignores these; the viewer surfaces them with a partial-recovery badge.
  partial_response?: string;
  partial_recommendation?: string;
}

export interface PreflightStatus {
  agent: AgentId;
  status: "ready" | "degraded" | "down";
  reason?: string;
}

export interface AgentAdapter {
  id: AgentId;
  binary: string;
  detect(): Promise<boolean>;
  command(prompt: string, repoRoot: string, opts?: DispatchOptions): string[];
  parseOutput(
    stdout: string,
    stderr: string,
    exitCode: number,
    durationMs: number
  ): AgentResult;
}

// --- Shared helpers ---

async function binaryExists(name: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["which", name], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

// --- Error classification ---

export function classifyError(stderr: string): ErrorClass {
  const lower = stderr.toLowerCase();
  if (/\b(auth|login|unauthorized|unauthenticated|api.?key)\b/.test(lower)) return "auth";
  if (/\b(token expired|invalid token|token revoked|access token)\b/.test(lower)) return "auth";
  if (/\b(rate.?limit|quota|too many requests|429)\b/.test(lower)) return "rate_limit";
  if (/\b(timeout|timed?\s*out|deadline)\b/.test(lower)) return "timeout";
  if (/\b(json|parse|syntax error|unexpected token)\b/.test(lower)) return "parse";
  if (/\b(not found|no such file|enoent|permission denied|cannot execute|spawn)\b/.test(lower)) return "startup";
  return "unknown";
}

export function errorClassMessage(errorClass: ErrorClass, agent: AgentId): string {
  switch (errorClass) {
    case "auth": return `${agent} authentication expired. Run \`${agent} login\` to fix.`;
    case "rate_limit": return `${agent} rate limited. Try again in a few minutes.`;
    case "timeout": return `${agent} timed out.`;
    case "parse": return `${agent} response was not valid JSON.`;
    case "startup": return `${agent} failed to start. Check installation.`;
    case "unknown": return `${agent} failed.`;
  }
}

// --- Preflight health check ---

export async function preflightCheck(
  adapter: AgentAdapter,
  repoRoot: string,
  timeoutMs: number = 30_000
): Promise<PreflightStatus> {
  // Step 1: version check
  try {
    const vProc = Bun.spawn([adapter.binary, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const vExit = await vProc.exited;
    if (vExit !== 0) {
      return { agent: adapter.id, status: "down", reason: `${adapter.binary} --version exited with code ${vExit}` };
    }
  } catch {
    return { agent: adapter.id, status: "down", reason: `${adapter.binary} binary not found or not executable` };
  }

  // Step 2: no-op prompt to validate auth + output format
  try {
    const cmd = adapter.command("Reply with just the word OK", repoRoot, DEFAULT_DISPATCH_OPTIONS);
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: repoRoot,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    clearTimeout(timer);

    if (timedOut) {
      return { agent: adapter.id, status: "degraded", reason: `No-op prompt timed out after ${timeoutMs / 1000}s` };
    }
    if (exitCode !== 0) {
      const ec = classifyError(stderr);
      const detail = stderr.trim().split("\n").find((l) => l.trim()) || "";
      const truncated = detail.length > 200 ? detail.slice(0, 200) + "…" : detail;
      const baseMsg = errorClassMessage(ec, adapter.id);
      const reason = truncated ? `${baseMsg} ${truncated}` : baseMsg;
      return { agent: adapter.id, status: "degraded", reason };
    }
    return { agent: adapter.id, status: "ready" };
  } catch (e: any) {
    return { agent: adapter.id, status: "degraded", reason: e.message };
  }
}

// Fuzzy heading normalization: maps variant headings to canonical keys
const HEADING_ALIASES: Record<string, string> = {
  "recommendation": "recommendation",
  "updated recommendation": "recommendation",
  "reasoning": "reasoning",
  "trade-offs": "tradeoffs",
  "tradeoffs": "tradeoffs",
  "trade offs": "tradeoffs",
  "confidence": "confidence",
  "updated confidence": "confidence",
  "dissent points": "dissent_points",
  "dissent_points": "dissent_points",
  "strongest counter-argument": "dissent_points",
  "assumptions": "assumptions",
  "key assumptions": "assumptions",
  "my assumptions": "assumptions",
  "updated assumptions": "assumptions",
  "what would change my mind": "belief_update_trigger",
  "belief update trigger": "belief_update_trigger",
  "change my mind": "belief_update_trigger",
  "what changed": "what_changed",
};

function normalizeHeading(raw: string): string {
  const lower = raw.toLowerCase().trim();
  return HEADING_ALIASES[lower] || lower;
}

function parseBulletList(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
  return lines.length > 0 ? lines : [text.trim()];
}

export function parseStructuredSections(text: string): {
  structured: boolean;
  recommendation?: string;
  reasoning?: string[];
  tradeoffs?: string;
  confidence?: string;
  dissent_points?: string;
  assumptions?: string[];
  belief_update_trigger?: string;
  what_changed?: string;
} {
  const sections: Record<string, string> = {};
  const sectionPattern = /^###\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  const positions: { name: string; start: number }[] = [];

  while ((match = sectionPattern.exec(text)) !== null) {
    positions.push({
      name: normalizeHeading(match[1]),
      start: match.index + match[0].length,
      headingStart: match.index,
    });
  }

  for (let i = 0; i < positions.length; i++) {
    const end = i + 1 < positions.length ? positions[i + 1].headingStart : text.length;
    sections[positions[i].name] = text.slice(positions[i].start, end).trim();
  }

  const hasRecommendation = "recommendation" in sections;
  const hasReasoning = "reasoning" in sections;

  if (!hasRecommendation && !hasReasoning) {
    return { structured: false };
  }

  return {
    structured: true,
    recommendation: sections["recommendation"],
    reasoning: sections["reasoning"] ? parseBulletList(sections["reasoning"]) : undefined,
    tradeoffs: sections["tradeoffs"],
    confidence: sections["confidence"],
    dissent_points: sections["dissent_points"],
    assumptions: sections["assumptions"] ? parseBulletList(sections["assumptions"]) : undefined,
    belief_update_trigger: sections["belief_update_trigger"],
    what_changed: sections["what_changed"],
  };
}

function makeResult(
  agent: AgentId,
  responseText: string,
  durationMs: number
): AgentResult {
  const parsed = parseStructuredSections(responseText);
  return {
    agent,
    status: "ok",
    structured: parsed.structured,
    response: responseText,
    recommendation: parsed.recommendation,
    reasoning: parsed.reasoning,
    tradeoffs: parsed.tradeoffs,
    confidence: parsed.confidence,
    dissent_points: parsed.dissent_points,
    assumptions: parsed.assumptions,
    belief_update_trigger: parsed.belief_update_trigger,
    duration_ms: durationMs,
    timestamp: new Date().toISOString(),
  };
}

function makeError(
  agent: AgentId,
  error: string,
  stderr: string,
  durationMs: number
): AgentResult {
  return {
    agent,
    status: "error",
    structured: false,
    response: "",
    error,
    raw_stderr: stderr,
    duration_ms: durationMs,
    timestamp: new Date().toISOString(),
  };
}

// --- Claude Adapter ---
// Output: single JSON object with .result field containing the text response

function claudeEffortArg(level: EffortLevel): string[] {
  if (level === "off") return [];
  return ["--effort", level];
}

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  binary: "claude",

  detect: () => binaryExists("claude"),

  command(prompt: string, _repoRoot: string, opts: DispatchOptions = DEFAULT_DISPATCH_OPTIONS): string[] {
    const argv = ["claude", "-p", prompt, "--output-format", "json"];
    argv.push(...claudeEffortArg(opts.effort));
    if (opts.model) argv.push("--model", opts.model);
    return argv;
  },

  parseOutput(stdout, stderr, exitCode, durationMs) {
    if (exitCode !== 0) {
      return makeError("claude", `Exit code ${exitCode}`, stderr, durationMs);
    }
    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.result || "";
      if (!text) {
        return makeError("claude", "Empty result field", stderr, durationMs);
      }
      const result = makeResult("claude", text, durationMs);
      result.model = Object.keys(parsed.modelUsage || {})[0] || undefined;
      return result;
    } catch (e: any) {
      return {
        agent: "claude",
        status: "error",
        structured: false,
        response: stdout,
        raw_response: stdout,
        error: `JSON parse failed: ${e.message}`,
        raw_stderr: stderr,
        duration_ms: durationMs,
        timestamp: new Date().toISOString(),
      };
    }
  },
};

// --- Codex Adapter ---
// Output: JSONL streaming. Look for item.completed events with item.text.

function codexEffortArg(level: EffortLevel): string[] {
  // Codex valid values: minimal | low | medium | high | xhigh.
  // Our portable "max" maps to xhigh (Codex's top tier).
  // "off" skips the override entirely, letting ~/.codex/config.toml win.
  if (level === "off") return [];
  const codexLevel = level === "max" ? "xhigh" : level;
  return ["-c", `model_reasoning_effort="${codexLevel}"`];
}

export const codexAdapter: AgentAdapter = {
  id: "codex",
  binary: "codex",

  detect: () => binaryExists("codex"),

  command(prompt: string, repoRoot: string, opts: DispatchOptions = DEFAULT_DISPATCH_OPTIONS): string[] {
    const argv = ["codex", "exec", prompt, "-C", repoRoot, "-s", "read-only", "--skip-git-repo-check"];
    argv.push(...codexEffortArg(opts.effort));
    if (opts.model) argv.push("-m", opts.model);
    argv.push("--json");
    return argv;
  },

  parseOutput(stdout, stderr, exitCode, durationMs) {
    if (exitCode !== 0 && !stdout.trim()) {
      return makeError("codex", `Exit code ${exitCode}`, stderr, durationMs);
    }
    try {
      const lines = stdout.trim().split("\n").filter(Boolean);
      let responseText = "";

      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "item.completed" && event.item?.text) {
            responseText += event.item.text;
          }
        } catch {
          // Skip unparseable lines (e.g., partial output on timeout)
        }
      }

      if (!responseText) {
        return makeError(
          "codex",
          "No item.completed events with text found in JSONL",
          stderr,
          durationMs
        );
      }

      return makeResult("codex", responseText, durationMs);
    } catch (e: any) {
      return {
        agent: "codex",
        status: "error",
        structured: false,
        response: stdout,
        raw_response: stdout,
        error: `JSONL parse failed: ${e.message}`,
        raw_stderr: stderr,
        duration_ms: durationMs,
        timestamp: new Date().toISOString(),
      };
    }
  },
};

// --- Gemini Adapter ---
// Output: single JSON object with .response field containing the text response

export const geminiAdapter: AgentAdapter = {
  id: "gemini",
  binary: "gemini",

  detect: () => binaryExists("gemini"),

  command(prompt: string, _repoRoot: string, opts: DispatchOptions = DEFAULT_DISPATCH_OPTIONS): string[] {
    // Gemini 3 thinks by default; no reasoning-effort flag exists in the CLI surface.
    // We honor opts.model if provided. opts.effort is intentionally ignored.
    //
    // --approval-mode plan: read-only mode. Prevents Gemini from attempting tool
    //   actions (file edits, shell commands) that would otherwise wait forever for
    //   approval prompts that never come in -p (non-interactive) mode. Without this,
    //   complex prompts can trigger Gemini's internal LocalAgentExecutor recursion
    //   loop (observed in council-20260501-151602: a 17-minute hang where Gemini
    //   tried to dispatch its own subagents — `codebase_investigator`, `generalist`,
    //   `cli_help` — hit recursion guards, looped, and produced empty output).
    //   Also disable the project's own agent-council skills at user scope for
    //   Gemini (`gemini skills disable council --scope user` plus the related
    //   council-*/ agent-council-nudge skills) — those skills match prompt
    //   keywords and trigger the same dispatch loop even with plan mode.
    const argv = ["gemini", "-p", prompt, "--approval-mode", "plan"];
    if (opts.model) argv.push("-m", opts.model);
    argv.push("-o", "json");
    return argv;
  },

  parseOutput(stdout, stderr, exitCode, durationMs) {
    if (exitCode !== 0) {
      return makeError("gemini", `Exit code ${exitCode}`, stderr, durationMs);
    }
    try {
      const parsed = JSON.parse(stdout);
      const text = parsed.response || "";
      if (!text) {
        return makeError("gemini", "Empty response field", stderr, durationMs);
      }
      return makeResult("gemini", text, durationMs);
    } catch (e: any) {
      return {
        agent: "gemini",
        status: "error",
        structured: false,
        response: stdout,
        raw_response: stdout,
        error: `JSON parse failed: ${e.message}`,
        raw_stderr: stderr,
        duration_ms: durationMs,
        timestamp: new Date().toISOString(),
      };
    }
  },
};

// --- Agent Registry ---

export const allAdapters: AgentAdapter[] = [
  claudeAdapter,
  codexAdapter,
  geminiAdapter,
];

export async function detectAgents(): Promise<AgentAdapter[]> {
  const results = await Promise.all(
    allAdapters.map(async (adapter) => ({
      adapter,
      available: await adapter.detect(),
    }))
  );

  return results.filter((r) => r.available).map((r) => r.adapter);
}
