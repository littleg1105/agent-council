/**
 * Project-local PATH augmentation for spawned subprocesses.
 *
 * The autopilot spawns implementing `claude -p` and verifier subprocesses
 * with cwd set to the target repo. Subprocesses inherit PATH from the
 * autopilot's parent shell, which often does NOT include project-local
 * tooling:
 *
 *   - Python/Poetry projects keep `poetry`, `pytest`, `mypy`, `black`,
 *     `ruff`, etc. in `.venv/bin/`. Activating a venv adds this to PATH;
 *     running from outside the venv (or a different conda env) doesn't.
 *
 *   - Node/TypeScript projects often have `vitest`, `eslint`, `prettier`,
 *     and locally-installed `bun` in `node_modules/.bin/`. `npm run` adds
 *     this implicitly; raw subprocess spawn doesn't.
 *
 * Real bug from the first live run on a Python+Poetry thesis project:
 * spawnImplementingClaude(...) → claude tries `poetry run pytest` →
 * fails because the autopilot was launched from a `base` conda env
 * that didn't include poetry. The verifier then crashed at
 * `Bun.spawn(["poetry", ...])` with "Executable not found in $PATH".
 *
 * Fix: prepend the conventional project-local bin dirs to PATH for any
 * subprocess we spawn into the target repo (claude -p AND the verifier).
 * No per-profile branches; works for all stacks that follow the
 * convention.
 */

import { existsSync } from "fs";
import { resolve } from "path";

/**
 * Conventional project-local bin directories, relative to the repo root.
 * Order matters: more-specific (.venv/bin) first.
 */
const PROJECT_BIN_DIRS = [
  ".venv/bin",
  "venv/bin",
  ".venv/Scripts",        // Windows-style, just in case
  "node_modules/.bin",
  "vendor/bin",            // Ruby+Bundler
  "bin",                   // generic project-local bin
];

/**
 * Build an env object suitable for `Bun.spawn`'s `env:` field that
 * augments the inherited environment with the project's local bin
 * directories prepended to PATH.
 *
 * If `baseEnv` is omitted, uses `process.env`. If `repoRoot/.venv/bin`
 * etc. don't exist, they're skipped silently (no harm in a missing
 * project-local bin dir).
 *
 * Always preserves the inherited PATH at the END so system tools still
 * resolve.
 */
export function augmentEnvWithProjectBins(repoRoot: string, baseEnv?: NodeJS.ProcessEnv): Record<string, string> {
  const env = baseEnv ?? process.env;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined) out[k] = v;
  }

  const augments: string[] = [];
  for (const rel of PROJECT_BIN_DIRS) {
    const abs = resolve(repoRoot, rel);
    if (existsSync(abs)) augments.push(abs);
  }

  if (augments.length > 0) {
    const existing = out.PATH ?? out.Path ?? out.path ?? "";
    out.PATH = augments.join(":") + (existing ? ":" + existing : "");
  }

  return out;
}

/**
 * Same as augmentEnvWithProjectBins but ALSO strips API key env vars
 * (for the verifier — we never want test code to be able to call out
 * to LLMs to fake a pass).
 */
export function augmentEnvForVerifier(repoRoot: string, baseEnv?: NodeJS.ProcessEnv): Record<string, string> {
  const augmented = augmentEnvWithProjectBins(repoRoot, baseEnv);
  const REDACTED_PREFIXES = ["ANTHROPIC", "OPENAI", "OPENAI_API", "GEMINI", "GOOGLE_API", "CODEX", "CLAUDE"];
  const REDACTED_EXACT = new Set([
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "CODEX_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
  ]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(augmented)) {
    if (REDACTED_EXACT.has(k)) continue;
    if (REDACTED_PREFIXES.some((p) => k.startsWith(p) && (k.endsWith("_KEY") || k.endsWith("_TOKEN") || k.endsWith("_API_KEY")))) continue;
    out[k] = v;
  }
  return out;
}
