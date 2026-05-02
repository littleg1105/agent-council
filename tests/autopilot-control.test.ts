import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "fs";
import { resolve } from "path";
import { readAndConsumeControl } from "../src/autopilot-control";

const tmpDir = resolve(import.meta.dir, ".tmp-control-test");

afterAll(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function freshAutopilotDir(name: string): string {
  const dir = resolve(tmpDir, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("readAndConsumeControl", () => {
  test("returns null when control.json doesn't exist", () => {
    const dir = freshAutopilotDir("none");
    expect(readAndConsumeControl(dir)).toBeNull();
  });

  test("reads and parses a 'pause' command", () => {
    const dir = freshAutopilotDir("pause");
    writeFileSync(
      resolve(dir, "control.json"),
      JSON.stringify({ command: "pause", reason: "going to bed" }),
      "utf-8"
    );
    const r = readAndConsumeControl(dir);
    expect(r).not.toBeNull();
    expect(r!.command).toBe("pause");
    expect(r!.reason).toBe("going to bed");
  });

  test("reads and parses a 'stop' command", () => {
    const dir = freshAutopilotDir("stop");
    writeFileSync(resolve(dir, "control.json"), JSON.stringify({ command: "stop" }), "utf-8");
    const r = readAndConsumeControl(dir);
    expect(r).not.toBeNull();
    expect(r!.command).toBe("stop");
  });

  test("CONSUMES the file on read (deletes it)", () => {
    const dir = freshAutopilotDir("consume");
    writeFileSync(resolve(dir, "control.json"), JSON.stringify({ command: "pause" }), "utf-8");
    expect(existsSync(resolve(dir, "control.json"))).toBe(true);
    readAndConsumeControl(dir);
    expect(existsSync(resolve(dir, "control.json"))).toBe(false);
  });

  test("rejects 'replan' command (per Codex's spec — goal changes need --reset)", () => {
    const dir = freshAutopilotDir("replan");
    writeFileSync(resolve(dir, "control.json"), JSON.stringify({ command: "replan" }), "utf-8");
    const r = readAndConsumeControl(dir);
    expect(r).toBeNull();
    // File still consumed even though we didn't act on it
    expect(existsSync(resolve(dir, "control.json"))).toBe(false);
  });

  test("rejects unknown commands but consumes the file", () => {
    const dir = freshAutopilotDir("unknown");
    writeFileSync(resolve(dir, "control.json"), JSON.stringify({ command: "foo" }), "utf-8");
    const r = readAndConsumeControl(dir);
    expect(r).toBeNull();
    expect(existsSync(resolve(dir, "control.json"))).toBe(false);
  });

  test("malformed JSON is consumed silently (doesn't crash the orchestrator)", () => {
    const dir = freshAutopilotDir("malformed");
    writeFileSync(resolve(dir, "control.json"), "{not valid json", "utf-8");
    const r = readAndConsumeControl(dir);
    expect(r).toBeNull();
    expect(existsSync(resolve(dir, "control.json"))).toBe(false);
  });

  test("preserves optional fields (requested_at, reason)", () => {
    const dir = freshAutopilotDir("optional");
    writeFileSync(
      resolve(dir, "control.json"),
      JSON.stringify({
        command: "pause",
        requested_at: "2026-05-03T01:00:00Z",
        reason: "rate-limit conservation",
      }),
      "utf-8"
    );
    const r = readAndConsumeControl(dir);
    expect(r!.command).toBe("pause");
    expect(r!.requested_at).toBe("2026-05-03T01:00:00Z");
    expect(r!.reason).toBe("rate-limit conservation");
  });
});
