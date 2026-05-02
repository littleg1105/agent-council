# Configuration reference

Agent Council reads a single config file at `~/.council/config.json` (or `<project>/.council/config.json` if the home dir is sandboxed). All fields are optional — missing fields use their built-in defaults.

```jsonc
{
  // Per-agent model pinning. Empty string ("") = let the CLI pick its
  // tier-default. Recommended to pin specific models for autopilot/long-running
  // sessions where vendor model rolls between calls would break reproducibility.
  // For interactive use, defaults are usually fine.
  "models": {
    "claude": "opus",        // alias resolves to latest Opus on your subscription
    "codex":  "gpt-5.4",     // exact name; consult Codex docs for valid values
    "gemini": ""             // empty: let Gemini CLI pick. (gemini-3.1-pro returns
                              //  ModelNotFoundError; verify a valid name before pinning.)
  },

  // Per-agent timeout in milliseconds. Number (applied to all) OR per-agent object.
  // Mode-driven defaults: quick = 180000, fast (default) = 600000, thorough = 900000.
  // CLI flag --unbounded sets this to ~24 days for long architectural questions.
  "timeout_ms": {
    "claude": 600000,
    "codex":  600000,
    "gemini": 600000
  },

  // Quorum-grace window in milliseconds. Once N-1 agents respond, stragglers
  // get this much additional time before the council proceeds without them.
  // Capped at runtime to never expire before any pending agent's own timeout
  // (PR1's grace-floor fix — prevents orphaning slow-but-still-thinking agents).
  "quorum_grace_ms": 600000,

  // Reasoning effort. String (applied to all) OR per-agent object.
  // Valid: max | high | medium | low | off. Maps per-CLI:
  //   Claude: --effort <value> (off = no flag)
  //   Codex:  -c model_reasoning_effort=<value> (max → xhigh; off = no flag)
  //   Gemini: ignored (Gemini 3 thinks by default)
  // Mode-driven defaults: quick = high, fast = max, thorough = max.
  "effort": "max",

  // Show the proactive nudge skill. When true (default), a tiny ambient
  // skill watches for "should we use X or Y" patterns in conversations and
  // suggests /council. Set false if you don't want suggestions.
  "proactive": true
}
```

## Field details

### `models`

Per-agent model identifier passed to each CLI's `--model` / `-m` flag.

- **Empty string** = "let the CLI pick its tier-default" — the autopilot will skip the model flag entirely. Fine for interactive use.
- **Recommended for autopilot**: pin specific models so a vendor model roll between runs doesn't silently change behavior. E.g., `{ "claude": "opus", "codex": "gpt-5.4", "gemini": "<verified-name>" }`.
- **Per-CLI valid names**:
  - **Claude**: aliases (`opus`, `sonnet`, `haiku`) or full names (`claude-opus-4-7`).
  - **Codex**: full names (`gpt-5.4`, `o3`, etc.). Tier-dependent.
  - **Gemini**: full names; `gemini-3.1-pro` was rejected on Gemini CLI 0.38.2 — verify what your subscription accepts before pinning.

### `timeout_ms`

Per-agent dispatch timeout. Two shapes:

```jsonc
// Single number — applied to all agents
{ "timeout_ms": 600000 }

// Per-agent object
{ "timeout_ms": { "claude": 600000, "codex": 300000, "gemini": 600000 } }
```

The CLI flag `--unbounded` overrides this with `2_147_483_647` (~24 days, effectively no timeout). Use sparingly.

### `quorum_grace_ms`

After N-1 of N agents respond, this much wall-clock time is given for stragglers before the council resolves. **Critical**: the runtime clamps this to `max(grace_ms, max(timeout_ms))` — i.e., grace can never expire before the slowest pending agent's own timeout. This was PR1's grace-floor fix; without it, a 60s grace would orphan a 240s codex run mid-thinking.

Mode defaults match per-mode timeouts:
- `quick`: 180000 (= 180s timeout)
- `fast`: 600000 (= 600s timeout)
- `thorough`: 900000 (= 900s timeout)

### `effort`

Reasoning effort knob. Two shapes:

```jsonc
// String — applied to all agents
{ "effort": "max" }

// Per-agent object
{ "effort": { "claude": "max", "codex": "high", "gemini": "max" } }
```

Valid values: `max | high | medium | low | off`. Maps per-CLI:

| Effort | Claude | Codex | Gemini |
|---|---|---|---|
| `max` | `--effort max` | `-c model_reasoning_effort=xhigh` | (no flag — Gemini 3 thinks by default) |
| `high` | `--effort high` | `-c model_reasoning_effort=high` | (ignored) |
| `medium` | `--effort medium` | `-c model_reasoning_effort=medium` | (ignored) |
| `low` | `--effort low` | `-c model_reasoning_effort=low` | (ignored) |
| `off` | (no flag) | (no flag — uses Codex config.toml default) | (ignored) |

CLI flag `--effort <value>` overrides for one run.

### `proactive`

Whether the proactive ambient skill suggests `/council` when it detects decision patterns in conversation. Boolean.

```jsonc
{ "proactive": false }   // disable suggestions
```

The skill is otherwise quiet (max 2 suggestions per session, single line, never interrupts).

## Layered defaults

In order of precedence (later wins):

1. **Built-in `DEFAULT_CONFIG`** — `src/council.ts` constants
2. **Per-mode preset** — `modeDefaults(mode)` in `src/council.ts`. The mode is determined by CLI flags: `--quick` = quick, `--with-review` = thorough, otherwise = fast.
3. **User config** — `~/.council/config.json`
4. **CLI flags** — `--effort`, `--unbounded`, `--chairman`, etc.

So a user with `~/.council/config.json` setting `timeout_ms.claude = 360000` will get **360000s** even when running with `--quick` (whose preset is 180000). To inherit per-mode defaults, omit the field from your config.

## Rate-limit handling (autopilot only)

The autopilot detects rate-limit signals from each CLI's stderr (Claude `usage limit reached`, Codex `rate_limit_exceeded`, Gemini `RESOURCE_EXHAUSTED`) and (in PR9 live mode) auto-pauses-and-resumes across quota windows. There's no config-file knob for this — the rate-limit detector is per-CLI hardcoded with sensible reset windows (Claude 5h, Codex 1h, Gemini 1m for RPM / 1d for daily). See [autopilot.md](./autopilot.md) and `src/autopilot-rate-limit.ts`.

## Storage

Council session data lives at `~/.council/<project>/<session-id>/`:

- `meta.json` — question, agents, mode, timestamp
- `stage1/opinion_*.json` — individual agent opinions
- `stage2/review_*.json` — peer reviews (when `--with-review`)
- `stage4/nudge_*.json` — nudge results (when nudge subcommand was used)
- `synthesis.json` — chairman's final verdict
- `viewer.html` — interactive viewer (open in browser)

Autopilot session data (when running) lives at `<repo>/.autopilot/`:

- `state.json` — orchestrator state
- `goals/g<N>.md` — per-leaf goal files
- `notes/g<N>-attempts.md` — failure notes (live mode)
- `AUTOPILOT.md` — project context (regenerated per spawn)

Plus `<repo>/.council/specs/g<N>.<ext>` — frozen test specs in the project's native test format.

## See also

- [autopilot.md](./autopilot.md) — autopilot user guide
- [profiles.md](./profiles.md) — multi-architecture project profiles
- [../README.md](../README.md) — project overview
- [../CLAUDE.md](../CLAUDE.md) — architecture notes for AI assistants
