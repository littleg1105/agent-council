# Autopilot

Autonomous-loop orchestrator built on top of [agent-council](../README.md). Designed for runs that take **hours, not minutes** — give it a goal, walk away, come back to a finished (or honestly-failed) project.

## What it is

The autopilot decomposes a single user-supplied goal into a small number of testable leaf goals, generates **frozen test specs** for each, then (in live mode) spawns a fresh `claude -p` subprocess per leaf to implement against the spec. Verification is `bun test` / `pytest` / `cargo test` / etc. exit codes — **truth flows up from the test runner, not from LLM judgment**.

```
                         goal.md (you write this)
                                 │
                                 ▼
        ┌────────────────────────────────────────────────┐
        │  Bootstrap council (3 agents, max-effort)      │
        │  Decomposes → leaf goals + frozen test specs   │
        └────────────────┬───────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────────────────┐
        │  Synthesizer (claude -p)                        │
        │  Picks best decomposition VERBATIM             │
        └────────────────┬───────────────────────────────┘
                         │
                         ▼
              .autopilot/goals/g1.md ... gN.md           ←── you can review here
              .council/specs/g1.<ext>  ... gN.<ext>      ←── frozen test specs
              .autopilot/state.json
              .autopilot/AUTOPILOT.md
                         │
              (DRY-RUN exits here. You review.)
                         │
                         ▼  --live (PR9, not yet shipping)
              ┌──────────────────────────────────────┐
              │  Per-goal implementation loop:       │
              │   spawn claude -p with the contract  │
              │   verify with `bun test`/etc.        │
              │   green → commit → next goal         │
              │   stuck → rescue council → rollback  │
              │   rate-limited → pause-and-resume    │
              └──────────────────────────────────────┘
                         │
                         ▼
              Final-review council (VETO-only authority)
                         │
                         ▼
              Done OR honestly-failed
```

## Why "dry-run by default"

The autopilot can spend hours of subscription quota — it's a real autonomous agent, not a chatbot. Dry-run-by-default lets you see **what the council planned** (the test specs, the leaf decomposition, the project context doc) **before** you authorize a multi-hour run. If the specs miss your intent, `--reset` and rephrase the goal. Ship-cost: nothing.

`--live` flag overrides dry-run. Live mode is reserved for PR9 — not yet shipping. PR8+PR9 ship dry-run only.

## Architecture decisions (and why)

These are not opinions — they're committed-to architectural decisions captured in `council-20260502-185738`. If you want to change them, weigh the trade-offs there first.

### Strategy C — Test-as-brain

Every leaf goal has a frozen test spec. The done-signal is the test runner's exit code, not LLM judgment. Implementation Claude **cannot edit the spec**: a pre-commit hook (live mode) rejects diffs to `.council/specs/`, and the verifier runs in a clean git checkout with no API access.

Why: an LLM that writes the implementation AND judges its own success has every incentive to declare victory on plausible-looking nonsense. Truth-by-process beats truth-by-judgment. The test runner has no incentives.

### Council can VETO but never BLESS

The final-review council (PR9) reads the diff and can deny `done` (downgrade to `needs_review`) but cannot grant `done`. Only the test-runner exit code grants. Doubt flows up; blessings never originate from judgment alone.

Why: closes the "Claude convinced Claude that it works" attack vector. If the council and the test runner disagree, the tests win.

### One stuck-rescue council per goal

If a goal hits 5 same-failure cycles or 30 wall-minutes without progress, ONE rescue council fires. If the rescue produces 3 more iterations without a red→green transition, `git reset --hard last_green_commit`, mark the goal failed, append to `.autopilot/notes/g<N>-attempts.md`, advance.

Why: aggressive auto-kill (Codex's preference) loses transient stucks. Unlimited rescue (open loop) burns subscription quota for hours. One rescue is the brittle-but-bounded sweet spot.

### Goal decomposition: 1 level, max 8 leaves

Bootstrap council produces between 3 and 8 leaf goals. No runtime decomposition. No sub-sub-goals. Wrong decomposition = `--reset` and rephrase.

Why: prevents the autopilot from going infinite via recursive decomposition (a real failure mode in autonomous agents).

### Repo-local state

`.autopilot/state.json` lives in the target repo, not in `~/.council/`. Gitignored. Survives context compaction; every iteration re-reads from disk.

Why: branch switches and worktrees naturally scope the autopilot per repo. Multiple concurrent autopilots in different repos don't interfere. The conversation context is cache only.

### Quota-based pacing, not cost-based budgets

Under subscription mode (Claude Code Max + Codex Pro + Gemini Pro), there's no per-token billing. The autopilot detects rate-limit signals from each CLI's stderr and **auto-pauses-and-resumes** across quota windows. A run can naturally span days as it pauses for 5-hour Claude windows or daily Gemini quotas to refresh.

Why: a multi-hour autonomous run on subscriptions is constrained by rate limits, not dollars. The right primitive is window-aware pacing, not a cost ledger. (PR8 ships the rate-limit detector; PR9 wires it into the orchestrator.)

## How decomposition works

The bootstrap council is dispatched with a prompt that:

1. Includes the user's goal text **verbatim** (no LLM editing of the user's intent).
2. Embeds the **active project profile** — language, test framework, verify command, and a worked example of a spec in the project's native syntax.
3. Forces a strict structured output: a `===GOALS===` JSON block containing 3-8 goals with id/title/description/spec_content.
4. Demands behavior-focused specs (no Goodhart-prone implementation-detail tests).
5. Forbids depending-on-each-other-out-of-order leaves.

Each of the 3 agents produces an independent decomposition. A synthesizer (`claude -p`) reads the 3 opinion files and picks the best decomposition **verbatim** — no merging, no hybridizing — to avoid introducing inconsistencies that break the autopilot's parser.

The chosen decomposition's JSON is parsed strictly: any deviation (out-of-order ids, invalid JSON, > 8 goals, missing fields) returns null and the autopilot exits with a clear error rather than write broken specs.

## Spec freezing

Each spec gets a SHA hash recorded in `state.json` at decomposition time. When the live-mode pre-commit hook runs (PR9), it compares the current spec file's hash against the recorded hash and rejects any commit that changed it.

This is the **load-bearing fake-progress defense**. Implementation Claude can convince itself the spec is wrong. It can't change the spec.

## Project profiles

The autopilot supports multiple project architectures via the **profile system** ([docs/profiles.md](./profiles.md)). Auto-detected from manifest files in the repo root:

| Manifest | Profile | Spec format | Verify command |
|---|---|---|---|
| `pyproject.toml` + `[tool.poetry]` / `poetry.lock` | `python-poetry` | `test_*.py` (pytest) | `poetry run pytest <file>` |
| `pyproject.toml` / `setup.py` / `requirements.txt` | `python-pytest` | `test_*.py` (pytest) | `pytest <file>` |
| `package.json` + `bun test` / `bun.lock` | `typescript-bun` | `*.test.ts` (bun:test) | `bun test <file>` |
| `package.json` + `vitest` | `typescript-node` | `*.test.ts` (vitest) | `npx vitest run <file>` |
| `package.json` + `jest` | `typescript-jest` | `*.test.ts` (jest) | `npx jest <file>` |
| `go.mod` | `go` | `*_test.go` (testing) | `go test <file>` |
| `Cargo.toml` | `rust` | `*_test.rs` (cargo) | `cargo test --test <name>` |
| `Gemfile` + `rspec` | `ruby-rspec` | `*_spec.rb` (RSpec) | `bundle exec rspec <file>` |
| (none) | `generic` | `*.md` placeholder | none — user must configure |

Override with `--profile <id>`. Custom profiles via `--profile-file <path.json>` for stacks not in the table (e.g., Elixir+Mix, Erlang+EUnit, Crystal+Spec). See [docs/profiles.md](./profiles.md) for the JSON shape.

## State schema

`.autopilot/state.json` (gitignored, atomically written via `.tmp` + rename):

```jsonc
{
  "schema_version": 1,
  "started_at": "2026-05-02T22:30:00Z",
  "goal_file": "./goal.md",
  "plan_session": "council-20260502-185738",   // bootstrap council session id
  "current_goal_id": "g3",                      // null in dry-run
  "queue": ["g3", "g4", "g5"],
  "completed": ["g1", "g2"],
  "failed": [],
  "goals": [
    { "id": "g1", "status": "done", "spec_sha": "abc123…", "green_commit": "deadbeef", "iteration": 4, ... },
    { "id": "g3", "status": "in_progress", "spec_sha": "ef56…", "iteration": 7, "stuck_rescues_used": 0, ... }
  ],
  "last_green_commit": "deadbeef",
  "last_progress_at": "2026-05-02T22:45:00Z",  // for orchestrator-level stuck detection
  "paused_until": null,                          // ISO timestamp when rate-limited
  "paused_reason": null,                         // "rate_limit" | "user_pause" | null
  "dry_run": true,
  "live_mode": false
}
```

Every iteration in live mode (PR9) re-reads this file from disk before doing anything. Conversation context is cache only — losing it (compaction, restart, resume after pause) doesn't lose progress.

## Quick start (dry-run)

```bash
# 1. Write your goal
cp goal-template.md goal.md
$EDITOR goal.md

# 2. Bootstrap (auto-detects project type)
bun run bin/autopilot --goal goal.md

# 3. Inspect what the council planned
ls .autopilot/goals/        # human-readable per-goal descriptions
ls .council/specs/          # frozen test specs
cat .autopilot/AUTOPILOT.md # project context

# 4. If wrong: reset and rephrase
bun run bin/autopilot --goal goal.md --reset

# 5. (Future) When right: run for real
# bun run bin/autopilot --goal goal.md --live
```

## Frequently asked

**"Why does the autopilot shell out to the council instead of importing it?"**
Decoupling. The autopilot stays language/architecture-aware while the council stays language-agnostic. Subprocess overhead per dispatch is ~100ms — irrelevant compared to the 3-7 minute council think time. Bonus: council session output ends up in the standard `~/.council/<project>/` paths, so you can `/council-replay` autopilot bootstrap sessions like any other.

**"Why is dry-run the default?"**
Multi-hour autonomous runs on real code are dangerous if the planning is wrong. Dry-run lets you read what the council planned for ~10 minutes of council time, before authorizing the full run. The cost of being wrong without dry-run is hours of subscription quota and unexpected commits.

**"What if the autopilot gets stuck on a goal?"**
One rescue council fires (per goal). If rescue can't unstick it within 3 iterations, the goal is rolled back to `last_green_commit`, marked `failed`, appended to `FAILED_GOALS.md`, and the run advances to the next goal. **No paging.** You read the failure log when you wake up.

**"What if all 3 agents are rate-limited at once?"**
The autopilot writes `paused_until` into state.json with the soonest reset window across the 3 agents (Claude 5h, Codex 1h, Gemini 1m / 1d) and exits cleanly. Resume manually with `--resume` (PR9) or via `ScheduleWakeup` if running under Claude Code.

**"What does the implementing Claude actually see?"**
A self-contained prompt (built by `buildImplementationPrompt`) referencing three files: `AUTOPILOT.md` (project state + hard rules), `goals/g<N>.md` (the leaf), `specs/g<N>.<ext>` (the frozen contract). Plus the verify command and a 30-iteration cap. Each subprocess is a fresh contractor — no memory of prior goals.

**"What if my project type isn't supported?"**
Three options: (1) use `--profile <closest-builtin>` and live with imperfect prompts, (2) write a custom profile JSON and pass `--profile-file`, (3) extend `BUILTIN_PROFILES` in `src/autopilot-profile.ts` with a PR. See [docs/profiles.md](./profiles.md).

## Limits and known sharp edges

- **Live mode (`--live`) is not yet shipping.** PR8 (current) is dry-run only. PR9 will add the implementation loop, stuck detection, rate-limit auto-pause-and-resume, clean-checkout verifier, and final-review council.
- **Goal must be implementable as code.** The autopilot's whole architecture assumes "decompose → write specs → implement until tests pass." For evaluation tasks (review a thesis, audit a codebase), the right tool is a regular `/agent-council` session.
- **Go and Rust have package-aware test discovery.** The `go` profile assumes `.council/specs/` is a valid Go package; you may need to seed it manually. The `rust` profile uses `tests/` instead of `.council/specs/` since cargo only discovers tests there.
- **The bootstrap council can fail.** Sometimes all 3 agents produce decompositions that don't pass strict parsing (output the marker `===NO_VIABLE_DECOMPOSITION===`). In that case, the autopilot exits with a clear error and surfaces the synthesizer's reasoning. Reformulate the goal and try again.
- **The model field in `~/.council/config.json` is recommended for autopilot.** Empty defaults let the CLI pick whatever its current default is — fine for interactive use, bad for multi-hour reproducibility. Pin specific models for autopilot runs.

## See also

- [profiles.md](./profiles.md) — project profile reference, custom profile JSON shape
- [../README.md](../README.md) — project overview
- [../CLAUDE.md](../CLAUDE.md) — architecture notes for AI assistants
- `council-20260502-185738` (in your `~/.council/`) — the deliberation that shaped Strategy C
