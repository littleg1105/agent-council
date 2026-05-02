import { describe, test, expect } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import {
  buildContextBundle,
  streamAndCount,
  formatByteSize,
  dispatchAgent,
  type DispatchControl,
  type AbortReason,
} from "../src/council";
import type { AgentAdapter, AgentId, AgentResult } from "../src/adapters";
import { errorClassMessage } from "../src/adapters";

const tmpDir = resolve(import.meta.dir, ".tmp-council-test");

describe("buildContextBundle security", () => {
  // Create a temp repo-like directory with a test file
  const repoRoot = resolve(tmpDir, "repo");
  const safeFile = "src/hello.ts";

  test("setup", () => {
    mkdirSync(resolve(repoRoot, "src"), { recursive: true });
    writeFileSync(resolve(repoRoot, safeFile), "console.log('hello');");
  });

  test("accepts safe relative paths", () => {
    const result = buildContextBundle([safeFile], repoRoot);
    expect(result).toContain("console.log");
    expect(result).not.toContain("rejected");
  });

  test("rejects absolute paths", () => {
    const result = buildContextBundle(["/etc/passwd"], repoRoot);
    expect(result).toContain("rejected: absolute paths not allowed");
  });

  test("rejects directory traversal with ..", () => {
    const result = buildContextBundle(["../../etc/passwd"], repoRoot);
    expect(result).toContain("rejected: directory traversal not allowed");
  });

  test("rejects hidden traversal in middle of path", () => {
    const result = buildContextBundle(["src/../../../etc/passwd"], repoRoot);
    expect(result).toContain("rejected: directory traversal not allowed");
  });

  test("rejects sensitive file extensions", () => {
    const exts = [".key", ".pem", ".env", ".secret", ".token"];
    for (const ext of exts) {
      const result = buildContextBundle([`config${ext}`], repoRoot);
      expect(result).toContain("rejected: sensitive file type");
    }
  });

  test("handles missing files gracefully", () => {
    const result = buildContextBundle(["nonexistent.ts"], repoRoot);
    expect(result).toContain("file not found");
  });

  test("handles empty file list", () => {
    const result = buildContextBundle([], repoRoot);
    expect(result).toBe("");
  });

  test("cleanup", () => {
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// --- Byte-flow heartbeat helpers ---

describe("streamAndCount", () => {
  test("returns full UTF-8 decoded content matching new Response().text()", async () => {
    const text = "hello\n世界\n{\"type\":\"item.completed\"}\n";
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });

    const counter = { count: 0 };
    const out = await streamAndCount(stream, counter);
    expect(out).toBe(text);
    expect(counter.count).toBe(bytes.byteLength);
  });

  test("counter increments per chunk as bytes arrive", async () => {
    // Three separate chunks; the counter should increment each time so a
    // setInterval-based watchdog can sample it incrementally.
    const chunks = ["alpha\n", "beta\n", "gamma\n"];
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const c of chunks) {
          controller.enqueue(enc.encode(c));
          await new Promise((r) => setTimeout(r, 5));
        }
        controller.close();
      },
    });

    const counter = { count: 0 };
    const out = await streamAndCount(stream, counter);
    expect(out).toBe("alpha\nbeta\ngamma\n");
    expect(counter.count).toBe(enc.encode("alpha\nbeta\ngamma\n").byteLength);
  });

  test("handles UTF-8 split across chunk boundaries", async () => {
    // The 4-byte emoji U+1F600 (😀) split across two chunks. TextDecoder({stream:true})
    // must reassemble it; the final decoder.decode() flush ensures no replacement char.
    const enc = new TextEncoder();
    const fullBytes = enc.encode("a😀b");
    const split = 2; // splits inside the emoji bytes
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(fullBytes.slice(0, split));
        controller.enqueue(fullBytes.slice(split));
        controller.close();
      },
    });

    const counter = { count: 0 };
    const out = await streamAndCount(stream, counter);
    expect(out).toBe("a😀b");
    expect(counter.count).toBe(fullBytes.byteLength);
  });

  test("empty stream produces empty string and zero count", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const counter = { count: 0 };
    const out = await streamAndCount(stream, counter);
    expect(out).toBe("");
    expect(counter.count).toBe(0);
  });
});

describe("formatByteSize", () => {
  test("bytes under 1KB display as B", () => {
    expect(formatByteSize(0)).toBe("0B");
    expect(formatByteSize(512)).toBe("512B");
    expect(formatByteSize(1023)).toBe("1023B");
  });

  test("KB range with one decimal", () => {
    expect(formatByteSize(1024)).toBe("1.0KB");
    expect(formatByteSize(2560)).toBe("2.5KB");
    expect(formatByteSize(1024 * 1024 - 1)).toBe("1024.0KB");
  });

  test("MB range with two decimals", () => {
    expect(formatByteSize(1024 * 1024)).toBe("1.00MB");
    expect(formatByteSize(5 * 1024 * 1024)).toBe("5.00MB");
  });
});

// --- AbortController dispatch flow (PR6) ---

// Test fake-adapter helper: spawns `bash -c <script>` and returns the AgentResult
// shape from parseOutput. Lets us exercise dispatchAgent end-to-end against a
// controllable subprocess (sleep, echo, exit codes) without invoking real CLIs.
function makeFakeAdapter(opts: { script: string; salvagesPartial: boolean; id?: AgentId }): AgentAdapter {
  return {
    id: (opts.id || "codex") as AgentId,
    binary: "bash",
    salvagesPartial: opts.salvagesPartial,
    detect: async () => true,
    command: () => ["bash", "-c", opts.script],
    parseOutput: (stdout, _stderr, exitCode, durationMs): AgentResult => ({
      agent: (opts.id || "codex") as AgentId,
      status: exitCode === 0 && stdout.length > 0 ? "ok" : "error",
      structured: false,
      response: exitCode === 0 ? stdout.trim() : "",
      duration_ms: durationMs,
      timestamp: new Date().toISOString(),
    }),
  };
}

describe("AbortReason / DispatchControl exports", () => {
  test("DispatchControl is constructable with null fields", () => {
    const ctl: DispatchControl = { proc: null, controller: null, abortReason: null };
    expect(ctl.controller).toBeNull();
    expect(ctl.abortReason).toBeNull();
  });

  test("AbortReason union covers timeout, grace, external", () => {
    const reasons: AbortReason[] = ["timeout", "grace", "external"];
    expect(reasons).toContain("timeout");
    expect(reasons).toContain("grace");
    expect(reasons).toContain("external");
  });

  test("errorClassMessage handles 'cancelled' (PR6 ErrorClass extension)", () => {
    const msg = errorClassMessage("cancelled", "codex");
    expect(msg.toLowerCase()).toContain("cancel");
  });
});

describe("dispatchAgent abort handling", () => {
  test("external grace abort: returns error_class:'cancelled', no salvage even if salvagesPartial:true", async () => {
    // A subprocess that sleeps forever — would never finish on its own
    const adapter = makeFakeAdapter({ script: "sleep 30", salvagesPartial: true });
    const ctl: DispatchControl = { proc: null, controller: null, abortReason: null };

    // Kick off the dispatch with a long timeout (so internal timer doesn't fire)
    const promise = dispatchAgent(adapter, "test prompt", "/tmp", 60_000, undefined, ctl);

    // Simulate dispatchWithQuorum's tryResolve: tag-before-abort
    setTimeout(() => {
      ctl.abortReason = "grace";
      ctl.controller!.abort();
    }, 100);

    const result = await promise;

    expect(result.status).toBe("timeout");
    expect(result.error_class).toBe("cancelled");
    expect(result.error).toContain("quorum grace");
    // Critical: NO salvage even though salvagesPartial:true. Quorum is final.
    expect(result.partial_response).toBeUndefined();
    expect(result.partial_recommendation).toBeUndefined();
  }, 10_000);

  test("internal timeout (abortReason='timeout'): produces status:'timeout' with error_class:'timeout' (not cancelled)", async () => {
    // Sleep longer than the dispatch timeout so the internal timer fires
    const adapter = makeFakeAdapter({ script: "sleep 30", salvagesPartial: false });

    const result = await dispatchAgent(adapter, "test prompt", "/tmp", 500);

    expect(result.status).toBe("timeout");
    expect(result.error_class).toBe("timeout");
    expect(result.error_class).not.toBe("cancelled");
  }, 10_000);

  test("normal-exit success path: AbortController machinery is transparent (no abortReason set)", async () => {
    const adapter = makeFakeAdapter({ script: "echo hello && exit 0", salvagesPartial: false });

    const result = await dispatchAgent(adapter, "test prompt", "/tmp", 5_000);

    expect(result.status).toBe("ok");
    expect(result.response).toBe("hello");
    expect(result.error_class).toBeUndefined();
  }, 10_000);

  test("tag-before-abort race-safety: abortReason set BEFORE abort() classifies correctly", async () => {
    // If we abort BEFORE setting abortReason, the listener fires, the dispatch
    // resumes, and abortReason is null — it falls through to the "normal exit"
    // path. This test pins the contract by demonstrating the correct ordering.
    const adapter = makeFakeAdapter({ script: "sleep 30", salvagesPartial: true });
    const ctl: DispatchControl = { proc: null, controller: null, abortReason: null };

    const promise = dispatchAgent(adapter, "test prompt", "/tmp", 60_000, undefined, ctl);

    setTimeout(() => {
      // CORRECT ordering — set the reason first, then abort. dispatchWithQuorum
      // does this. Anyone refactoring should preserve it.
      ctl.abortReason = "grace";
      ctl.controller!.abort();
    }, 100);

    const result = await promise;
    expect(result.error_class).toBe("cancelled");
  }, 10_000);
});
