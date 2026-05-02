import { describe, test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  claudeAdapter,
  codexAdapter,
  geminiAdapter,
  detectAgents,
} from "../src/adapters";

const fixturesDir = resolve(import.meta.dir, "fixtures");

// --- Claude Adapter ---

describe("claudeAdapter", () => {
  test("parseOutput: valid JSON extracts result text", () => {
    const stdout = readFileSync(resolve(fixturesDir, "claude-output.json"), "utf-8");
    const result = claudeAdapter.parseOutput(stdout, "", 0, 2500);

    expect(result.status).toBe("ok");
    expect(result.agent).toBe("claude");
    expect(result.response).toContain("Hello");
    expect(result.duration_ms).toBe(2500);
    expect(result.model).toBeDefined();
  });

  test("parseOutput: malformed JSON returns error envelope", () => {
    const result = claudeAdapter.parseOutput("{broken json", "", 0, 100);

    expect(result.status).toBe("error");
    expect(result.error).toContain("JSON parse failed");
    expect(result.raw_response).toBe("{broken json");
  });

  test("parseOutput: truncated JSON (mid-string) returns error — salvage path will skip", () => {
    // Verifies that a SIGTERMed Claude returning '{"result":"hello' produces
    // status:"error", which the dispatchAgent timeout salvage gates on to AVOID
    // attaching garbage as partial_response. Codex tolerates truncation; Claude
    // and Gemini do not — this asymmetry is intentional.
    const result = claudeAdapter.parseOutput('{"result":"hello', "", -1, 30000);

    expect(result.status).toBe("error");
    expect(result.response).toBe("");
  });

  test("parseOutput: empty stdout returns error envelope", () => {
    const result = claudeAdapter.parseOutput("", "", 0, 100);

    expect(result.status).toBe("error");
    expect(result.error).toContain("JSON parse failed");
  });

  test("parseOutput: non-zero exit code returns error", () => {
    const result = claudeAdapter.parseOutput("", "auth failed", 1, 100);

    expect(result.status).toBe("error");
    expect(result.error).toContain("Exit code 1");
    expect(result.raw_stderr).toBe("auth failed");
  });

  test("command: default opts (effort:off) produces base argv with no --effort flag", () => {
    const cmd = claudeAdapter.command("test question", "/repo");
    expect(cmd).toEqual(["claude", "-p", "test question", "--output-format", "json"]);
  });

  test("command: effort:max appends --effort max", () => {
    const cmd = claudeAdapter.command("test question", "/repo", { effort: "max", stream: false });
    expect(cmd).toEqual(["claude", "-p", "test question", "--output-format", "json", "--effort", "max"]);
  });

  test("command: effort:high appends --effort high", () => {
    const cmd = claudeAdapter.command("test question", "/repo", { effort: "high", stream: false });
    expect(cmd).toEqual(["claude", "-p", "test question", "--output-format", "json", "--effort", "high"]);
  });

  test("command: effort:off omits --effort entirely", () => {
    const cmd = claudeAdapter.command("test question", "/repo", { effort: "off", stream: false });
    expect(cmd).not.toContain("--effort");
  });

  test("command: model option appends --model", () => {
    const cmd = claudeAdapter.command("test question", "/repo", { effort: "off", stream: false, model: "claude-opus-4-7" });
    expect(cmd).toContain("--model");
    expect(cmd).toContain("claude-opus-4-7");
  });
});

// --- Codex Adapter ---

describe("codexAdapter", () => {
  test("parseOutput: valid JSONL extracts item.completed text", () => {
    const stdout = readFileSync(resolve(fixturesDir, "codex-output.jsonl"), "utf-8");
    const result = codexAdapter.parseOutput(stdout, "", 0, 5000);

    expect(result.status).toBe("ok");
    expect(result.agent).toBe("codex");
    expect(result.response).toContain("Hello");
    expect(result.duration_ms).toBe(5000);
  });

  test("parseOutput: malformed JSONL skips bad lines", () => {
    const stdout = '{"type":"thread.started"}\n{broken}\n{"type":"item.completed","item":{"text":"Result"}}\n';
    const result = codexAdapter.parseOutput(stdout, "", 0, 100);

    expect(result.status).toBe("ok");
    expect(result.response).toBe("Result");
  });

  test("parseOutput: truncated JSONL (mid-line at end) salvages prior complete events", () => {
    // Simulates SIGTERM mid-stream: the trailing line is half-written.
    // The Codex partial-on-timeout salvage path depends on this behavior.
    const stdout = [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"text":"First chunk."}}',
      '{"type":"item.completed","item":{"text":"Second chunk."}}',
      '{"type":"item.completed","item":{"text"',  // truncated trailing line
    ].join("\n");
    const result = codexAdapter.parseOutput(stdout, "", -1, 30000);

    expect(result.status).toBe("ok");
    expect(result.response).toBe("First chunk.Second chunk.");
  });

  test("parseOutput: empty stdout returns error", () => {
    const result = codexAdapter.parseOutput("", "", 0, 100);

    expect(result.status).toBe("error");
    expect(result.error).toContain("No item.completed events");
  });

  test("parseOutput: JSONL with no item.completed returns error", () => {
    const stdout = '{"type":"thread.started"}\n{"type":"turn.started"}\n';
    const result = codexAdapter.parseOutput(stdout, "", 0, 100);

    expect(result.status).toBe("error");
  });

  test("command: default opts (effort:off) produces base argv with no -c override", () => {
    const cmd = codexAdapter.command("test question", "/repo");
    expect(cmd).toEqual(["codex", "exec", "test question", "-C", "/repo", "-s", "read-only", "--skip-git-repo-check", "--json"]);
  });

  test("command: effort:max maps to xhigh via -c model_reasoning_effort", () => {
    const cmd = codexAdapter.command("test question", "/repo", { effort: "max", stream: false });
    expect(cmd).toEqual([
      "codex", "exec", "test question",
      "-C", "/repo",
      "-s", "read-only",
      "--skip-git-repo-check",
      "-c", `model_reasoning_effort="xhigh"`,
      "--json",
    ]);
  });

  test("command: effort:high passes through verbatim", () => {
    const cmd = codexAdapter.command("test question", "/repo", { effort: "high", stream: false });
    expect(cmd).toContain("-c");
    expect(cmd).toContain(`model_reasoning_effort="high"`);
  });

  test("command: effort:off omits -c override entirely", () => {
    const cmd = codexAdapter.command("test question", "/repo", { effort: "off", stream: false });
    expect(cmd).not.toContain("-c");
  });
});

// --- Gemini Adapter ---

describe("geminiAdapter", () => {
  test("parseOutput: valid JSON extracts response text", () => {
    const stdout = readFileSync(resolve(fixturesDir, "gemini-output.json"), "utf-8");
    const result = geminiAdapter.parseOutput(stdout, "", 0, 3000);

    expect(result.status).toBe("ok");
    expect(result.agent).toBe("gemini");
    expect(result.response).toContain("Hello");
    expect(result.duration_ms).toBe(3000);
  });

  test("parseOutput: malformed JSON returns error envelope", () => {
    const result = geminiAdapter.parseOutput("not json", "", 0, 100);

    expect(result.status).toBe("error");
    expect(result.error).toContain("JSON parse failed");
  });

  test("parseOutput: empty stdout returns error", () => {
    const result = geminiAdapter.parseOutput("", "", 0, 100);

    expect(result.status).toBe("error");
  });

  test("command: default opts produces base argv with --approval-mode plan", () => {
    const cmd = geminiAdapter.command("test question", "/repo");
    expect(cmd).toEqual(["gemini", "-p", "test question", "--approval-mode", "plan", "-o", "json"]);
  });

  test("command: effort is silently ignored (no flag exists)", () => {
    const cmd = geminiAdapter.command("test question", "/repo", { effort: "max", stream: false });
    expect(cmd).toEqual(["gemini", "-p", "test question", "--approval-mode", "plan", "-o", "json"]);
  });

  test("command: model option inserts -m before -o, after --approval-mode", () => {
    const cmd = geminiAdapter.command("test question", "/repo", { effort: "off", stream: false, model: "gemini-3-pro" });
    expect(cmd).toContain("-m");
    expect(cmd).toContain("gemini-3-pro");
    expect(cmd).toContain("--approval-mode");
    expect(cmd).toContain("plan");
    expect(cmd[cmd.length - 2]).toBe("-o");
    expect(cmd[cmd.length - 1]).toBe("json");
  });

  test("command: --approval-mode plan is always set (prevents agentic recursion in -p mode)", () => {
    const cmd1 = geminiAdapter.command("q", "/r");
    const cmd2 = geminiAdapter.command("q", "/r", { effort: "max", stream: false });
    const cmd3 = geminiAdapter.command("q", "/r", { effort: "off", stream: false, model: "x" });
    for (const cmd of [cmd1, cmd2, cmd3]) {
      const idx = cmd.indexOf("--approval-mode");
      expect(idx).toBeGreaterThan(-1);
      expect(cmd[idx + 1]).toBe("plan");
    }
  });
});

// --- Structured Section Parsing ---

describe("structured section parsing", () => {
  test("parses all structured sections", () => {
    const structuredResponse = `### Recommendation
Use Postgres for strong consistency.

### Reasoning
- Team has SQL experience
- Strong ACID guarantees
- Better tooling ecosystem

### Trade-offs
Scaling ceiling around 10TB without sharding.

### Confidence
High — clear fit for the requirements.

### Dissent Points
DynamoDB would scale more easily if write volume triples.`;

    const result = claudeAdapter.parseOutput(
      JSON.stringify({ result: structuredResponse, modelUsage: { "claude-opus-4-6": {} } }),
      "",
      0,
      1000
    );

    expect(result.structured).toBe(true);
    expect(result.recommendation).toContain("Postgres");
    expect(result.reasoning).toHaveLength(3);
    expect(result.tradeoffs).toContain("10TB");
    expect(result.confidence).toContain("High");
    expect(result.dissent_points).toContain("DynamoDB");
  });

  test("handles unstructured response", () => {
    const result = claudeAdapter.parseOutput(
      JSON.stringify({ result: "Just use Postgres, it's fine.", modelUsage: {} }),
      "",
      0,
      1000
    );

    expect(result.structured).toBe(false);
    expect(result.response).toBe("Just use Postgres, it's fine.");
  });

  test("parses assumptions as bullet list", () => {
    const response = `### Recommendation
Use Postgres.

### Reasoning
- Good fit

### Assumptions
- Team will not exceed 10TB
- No need for global distribution
- Budget allows managed hosting

### What Would Change My Mind
If write volume exceeds 50k/sec sustained, DynamoDB becomes necessary.`;

    const result = claudeAdapter.parseOutput(
      JSON.stringify({ result: response, modelUsage: {} }),
      "",
      0,
      1000
    );

    expect(result.structured).toBe(true);
    expect(result.assumptions).toHaveLength(3);
    expect(result.assumptions![0]).toContain("10TB");
    expect(result.assumptions![2]).toContain("managed hosting");
    expect(result.belief_update_trigger).toContain("50k/sec");
  });

  test("parses assumptions as prose (fallback to single element)", () => {
    const response = `### Recommendation
Use Postgres.

### Reasoning
- Good fit

### Assumptions
The team has existing SQL expertise and the data model is relational.`;

    const result = claudeAdapter.parseOutput(
      JSON.stringify({ result: response, modelUsage: {} }),
      "",
      0,
      1000
    );

    expect(result.assumptions).toHaveLength(1);
    expect(result.assumptions![0]).toContain("SQL expertise");
  });

  test("fuzzy matches variant headings", () => {
    const response = `### Recommendation
Use Postgres.

### Reasoning
- Good fit

### Key Assumptions
- Team knows SQL
- Data is relational

### Trade-Offs
No auto-scaling.

### Strongest Counter-argument
MongoDB is more flexible.`;

    const result = claudeAdapter.parseOutput(
      JSON.stringify({ result: response, modelUsage: {} }),
      "",
      0,
      1000
    );

    expect(result.assumptions).toHaveLength(2);
    expect(result.tradeoffs).toContain("auto-scaling");
    expect(result.dissent_points).toContain("MongoDB");
  });

  test("missing assumptions returns undefined", () => {
    const response = `### Recommendation
Use Postgres.

### Reasoning
- Good fit`;

    const result = claudeAdapter.parseOutput(
      JSON.stringify({ result: response, modelUsage: {} }),
      "",
      0,
      1000
    );

    expect(result.assumptions).toBeUndefined();
    expect(result.belief_update_trigger).toBeUndefined();
  });
});

// --- Agent Detection ---

describe("detectAgents", () => {
  test("returns at least some agents on this machine", async () => {
    const agents = await detectAgents();
    // We know all 3 are installed on this machine from preflight
    expect(agents.length).toBeGreaterThanOrEqual(2);
  });
});

// --- Partial-on-timeout schema ---

describe("AgentResult partial fields", () => {
  test("partial_response and partial_recommendation are optional and accepted by the schema", () => {
    // Type-level assertion that the fields exist and are optional. If this compiles
    // and runs, the schema contract is intact for the dispatchAgent timeout salvage.
    const partial: import("../src/adapters").AgentResult = {
      agent: "codex",
      status: "timeout",
      structured: false,
      response: "",
      partial_response: "salvaged content",
      partial_recommendation: "use Postgres",
      error: "Agent did not respond within 30 seconds",
      error_class: "timeout",
      duration_ms: 30000,
      timestamp: new Date().toISOString(),
    };

    expect(partial.partial_response).toBe("salvaged content");
    expect(partial.partial_recommendation).toBe("use Postgres");
    expect(partial.status).toBe("timeout");
    expect(partial.response).toBe("");
  });

  test("AgentResult without partial fields is still valid (backward compat)", () => {
    const noPartial: import("../src/adapters").AgentResult = {
      agent: "claude",
      status: "ok",
      structured: false,
      response: "hi",
      duration_ms: 100,
      timestamp: new Date().toISOString(),
    };

    expect(noPartial.partial_response).toBeUndefined();
    expect(noPartial.partial_recommendation).toBeUndefined();
  });
});
