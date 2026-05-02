/**
 * User-side control surface for a running autopilot.
 *
 * From council-20260502-205303 (Fork 5B + Codex's interruption spec):
 *
 *   "Handle interruption with both signals and a repo-local
 *    .autopilot/control.json: `pause` writes paused_reason:"user_pause"
 *    and exits 75, `stop` terminates the child, persists state, and
 *    exits 130; do NOT support `replan` in-band, because changing the
 *    goal means --reset."
 *
 * Two mechanisms work together:
 *
 *   1. .autopilot/control.json — the user (or another script) writes a
 *      `command` field, the orchestrator reads it before each spawn and
 *      acts. Atomic-write friendly. Survives shell death.
 *
 *   2. SIGINT / SIGTERM handlers — clean ctrl-C from the same shell that
 *      launched the orchestrator. Persists state before exit so --resume
 *      picks up cleanly.
 *
 * The replan command is REJECTED at parse-time. Goal changes require
 * --reset (which wipes state.json + uninstalls the pre-commit hook).
 */

import { existsSync, readFileSync, unlinkSync } from "fs";
import { resolve } from "path";

export type ControlCommand = "pause" | "stop";

export interface ControlSignal {
  command: ControlCommand;
  /** ISO timestamp when the user wrote control.json (informational; not authoritative) */
  requested_at?: string;
  /** Optional human-readable reason from the user. */
  reason?: string;
}

/**
 * Read .autopilot/control.json and return the command, or null if absent.
 * Returns null on parse errors (we don't want a malformed control file
 * to crash an in-flight run).
 *
 * The file is CONSUMED on read (deleted) so the same command doesn't fire
 * twice across iteration boundaries.
 */
export function readAndConsumeControl(autopilotDir: string): ControlSignal | null {
  const path = resolve(autopilotDir, "control.json");
  if (!existsSync(path)) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    // Malformed — ignore but consume so we don't keep tripping on it
    try { unlinkSync(path); } catch {}
    return null;
  }
  // Consume immediately
  try { unlinkSync(path); } catch {}

  if (parsed.command === "replan") {
    console.error(
      "[autopilot] control.json: 'replan' is NOT supported in-band. " +
      "Changing the goal mid-run requires --reset (which wipes state). " +
      "Ignoring the replan signal."
    );
    return null;
  }
  if (parsed.command !== "pause" && parsed.command !== "stop") {
    console.error(
      `[autopilot] control.json: unknown command "${parsed.command}". ` +
      `Valid commands: pause | stop. Ignoring.`
    );
    return null;
  }
  return {
    command: parsed.command,
    requested_at: parsed.requested_at,
    reason: parsed.reason,
  };
}

/**
 * Install SIGINT / SIGTERM handlers that mark the orchestrator for
 * clean shutdown. Returns a getter you can poll between iteration
 * boundaries — `signalReceived()` returns null when no signal has
 * fired, otherwise the signal name.
 *
 * We DON'T exit immediately on SIGINT — that would corrupt state.json
 * if a write was in flight. Instead, the next iteration boundary's
 * `signalReceived()` check returns the signal and the orchestrator
 * exits cleanly there.
 */
export function installSignalHandlers(): () => "SIGINT" | "SIGTERM" | null {
  let received: "SIGINT" | "SIGTERM" | null = null;
  const handler = (sig: "SIGINT" | "SIGTERM") => {
    if (received) {
      // User hit ctrl-C twice — escalate to immediate termination
      console.error(`\n[autopilot] received ${sig} (second time); forcing exit`);
      process.exit(130);
    }
    received = sig;
    console.error(`\n[autopilot] received ${sig}; will pause-and-persist at next safe point (ctrl-C again to force-exit)`);
  };
  process.on("SIGINT", () => handler("SIGINT"));
  process.on("SIGTERM", () => handler("SIGTERM"));
  return () => received;
}
