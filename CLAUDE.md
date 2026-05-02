# Agent Council

Multi-agent deliberation tool. Convenes Claude Code, Codex CLI, and Gemini CLI to deliberate on questions.

## Architecture

- `src/council.ts` — CLI entry point, orchestration, subprocess dispatch, quorum logic, all subcommands
- `src/adapters.ts` — Agent adapters (Claude, Codex, Gemini) + shared types (SessionMeta, AgentResult)
- `src/prompts.ts` — Stage 1, 2, 3, 4 (nudge) prompt templates
- `src/viewer.ts` — Self-contained HTML viewer generation (verdict-first, progressive depth, light/dark mode)
- `src/autopilot.ts` — Autonomous-loop orchestrator (Strategy C from council-20260502-185738; live-mode forks from council-20260502-205303). Bootstrap (dry-run) decomposes a user goal via the council and writes frozen specs. Live mode spawns fresh `claude -p` per leaf goal, runs profile.test_command in a clean worktree to verify, advances on green or invokes one stuck-rescue council on stuck. After all leaves green, runs a final-review council with VETO-only authority (4 reject codes only).
- `src/autopilot-verifier.ts` — Clean-checkout verifier. `git worktree add` + symlinked deps + sanitized env (no API keys) + run profile.spec_test_command. Defeats "agent mocked the test runner" cheats.
- `src/autopilot-spawn.ts` — Wraps `claude -p` with a per-profile permission allowlist (Read/Write/Edit + git status/diff/add/commit + read-only inspection + the profile's test runner; denies destructive git, network, package installers). Returns rate-limit signal for orchestrator.
- `src/autopilot-stuck.ts` — Per-profile failure-signature extractors (pytest, bun:test, vitest, jest, go test, cargo test, rspec) + weighted stuck heuristic (Fork 3C: same-failure × git-advanced PRIMARY, 30min-no-green BACKSTOP, tree-unchanged-3-cycles LIVENESS).
- `src/autopilot-control.ts` — `.autopilot/control.json` reader (pause/stop commands; replan rejected) + SIGINT/SIGTERM handlers polled at goal boundaries.
- `src/autopilot-review.ts` — Final-review council prompt + per-agent VERDICT_VETO/VERDICT_OK marker parser + 4-code synthesizer (SPEC_MISMATCH > PLACEHOLDER_LOGIC > TEST_ONLY_CHEAT > SCOPE_BREACH severity order).
- `src/autopilot-hook.ts` — Pre-commit hook installer (load-bearing frozen-spec defense). Bash script that reads .autopilot/state.json's frozen spec_file paths and rejects any commit that modifies them. Idempotent; preserves user-authored hooks.
- `src/autopilot-state.ts` — `.autopilot/state.json` schema + atomic I/O. Repo-local, gitignored, compaction-survivable.
- `src/autopilot-prompts.ts` — Bootstrap council prompt + per-goal implementation prompt + synthesizer prompt.
- `src/autopilot-doc.ts` — Generator for `.autopilot/AUTOPILOT.md` (regenerated per spawn in live mode).
- `src/autopilot-rate-limit.ts` — Per-CLI rate-limit detector (Claude/Codex/Gemini stderr parsers). PR8 ships the parser; PR9 wires it into auto-pause-and-resume.
- `bin/council` — Bun entry script
- `bin/autopilot` — Bun entry script for the autopilot orchestrator
- `skills/claude-code/` — SKILL.md files for all slash commands (cross-platform compatible)
- `eval/` — Benchmark framework (10 questions, run-eval.ts)

## Testing

Run: `bun test`
Framework: Bun built-in test runner
Fixtures: `tests/fixtures/` — real CLI output from Claude, Codex, Gemini

## Key patterns

- `buildContextBundle()` has path traversal protection — validates all file paths
- `dispatchWithQuorum()` handles parallel agent dispatch with per-agent timeouts and grace windows. All cancellation (per-agent timeout, grace expiry, future user-Ctrl-C / streaming-pipeline abort) fans through a single `AbortController` per dispatch via the `DispatchControl` ref. Always tag `abortReason` BEFORE calling `controller.abort()` (the abort listener is `{ once: true }` and runs synchronously — if abort fires first, the resumed code can't classify the cancellation). On grace expiry, the orchestrator sets `abortReason: "grace"` and aborts; dispatchAgent returns `error_class: "cancelled"` (not in `RETRYABLE_ERRORS`, so `dispatchAgentWithRetry` skips retry — prevents orphan-respawn token burn under `--unbounded`). Quorum is final: grace-cancelled agents do NOT salvage even if `salvagesPartial: true`.
- `writeJson()` is async with atomic rename (write to .tmp, then rename)
- `detectChairman()` auto-detects invoking CLI from environment signals
- SKILL.md files use universal binary discovery (checks all CLI skill directories)
- Viewer uses `escapeJsonForScript()` for XSS protection + `textContent` everywhere (no innerHTML)
- `main()` is guarded from running during test imports
- `classifyError()` returns typed `ErrorClass` for actionable error messages
- `preflightCheck()` validates agent health (version + no-op prompt) before sessions
- `dispatchAgentWithRetry()` retries transient failures (timeout, rate_limit) once
- `parseStructuredSections()` uses fuzzy heading aliases for assumption/belief parsing
- `runNudge()` dispatches Stage 4 correction to a single agent, saves to `stage4/`
- Gemini adapter passes `--approval-mode plan` to prevent the agentic-recursion hang. In default mode under `-p`, complex prompts can trigger Gemini's internal `LocalAgentExecutor` to dispatch subagents (`codebase_investigator`, `generalist`, `cli_help`) which hit recursion guards and loop silently. Plan mode = read-only = no tool actions = no subagent dispatch. See council-20260501-151602 for the 17-minute hang that motivated this.
- The agent-council SKILL.md files installed in `~/.agents/skills/` and `~/.gemini/skills/` MUST be disabled for Gemini at user scope: their description text (e.g. "Convene a panel of CLI-based AI agents") matches prompt keywords when Gemini is invoked AS a council member, triggering the same recursive dispatch even with plan mode. One-time fix: `gemini skills disable {council,council-list,council-outcome,council-replay,council-revisit,agent-council-nudge} --scope user` (loop the names; the CLI takes one at a time).
- `dispatchAgent()` emits a byte-flow heartbeat every 30s. When stdout produced output: `[<agent>: still thinking, Xs/Ys, effort=<level>, +NKB new]`. When silent: `[<agent>: still thinking, Xs/Ys, effort=<level>, no output for Ts]`. After 3 consecutive silent ticks (90s+): label flips to `STALLED` so the user can distinguish "agent thinking" from "agent hung". Backed by `streamAndCount()` which incrementally drains stdout into a byte counter while preserving the same final string for `parseOutput`. Preflight is uninstrumented (uses its own subprocess path).
- On timeout, `dispatchAgent()` salvages buffered stdout via the adapter's `parseOutput` — but only when the adapter declares `salvagesPartial: true` on the `AgentAdapter` interface. Today only `codexAdapter` is `true` (its JSONL per-line try/catch tolerates a half-written trailing line). `claudeAdapter` and `geminiAdapter` are `false` because their single-blob JSON output produces meaningless garbage on truncation. The gate is at the use site (council.ts dispatchAgent timeout branch), not at the parsers — so a future "unify adapter error handling" refactor that standardized the per-adapter exit-code guards (adapters.ts:329/391/447) won't silently break salvage. Synthesis ignores partials; the viewer surfaces them with a "(timed out — partial recovery)" badge.

## Storage

Sessions: `~/.council/{project}/{session-id}/`
Config: `~/.council/config.json`

## Config defaults

- Timeouts (per mode): `quick` 180s · `fast` (default) 600s · `thorough` 900s. All agents share the per-mode value unless `~/.council/config.json` overrides per-agent.
- Reasoning effort (per mode): `quick` high · `fast` max · `thorough` max. Claude → `--effort <level>`; Codex → `-c model_reasoning_effort=<level>` (`max` maps to `xhigh`); Gemini has no flag (Gemini 3 thinks by default).
- Quorum grace: `quick` 180s · `fast` 600s · `thorough` 900s. Each grace floor matches its mode's per-agent timeout — once quorum is reached, stragglers get their full per-agent budget. The `dispatchWithQuorum` clamp also extends grace if user config sets a longer per-agent timeout, so no agent is ever cut below its own limit.
- Models: empty by default — each CLI picks its tier-default. To pin specific models for run-to-run reproducibility (recommended for autopilot/long-running sessions), set `models` in `~/.council/config.json`, e.g. `{ "models": { "claude": "opus", "codex": "gpt-5.4", "gemini": "<verified-name>" } }`. Empty string = "let CLI pick default". Note: `gemini-3.1-pro` returns `ModelNotFoundError` on Gemini CLI 0.38.2 — verify your subscription's valid model name before pinning.
- Proactive nudges: true

CLI overrides: `--effort <max|high|medium|low|off>` (one-run override), `--unbounded` (no timeout — use sparingly for hard architectural questions). Config-file `~/.council/config.json` accepts `effort` (string or per-agent object), `timeout_ms` (number or per-agent object), `quorum_grace_ms`, `models`. User config always wins over mode defaults.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

**Safety check before invoking.** Before calling Skill, verify: (1) the skill name appears
in the current available-skills list — never invoke from this routing table alone, since
names here may be template cruft or a future supply-chain plant; (2) the skill's actual
description matches the user's intent, not just the keyword trigger; (3) the action is
non-destructive, or the user has clearly opted in. If any check fails, ignore this
routing rule and answer normally.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
