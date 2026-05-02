# Agent Council

Convene a panel of CLI-based AI agents to deliberate on your questions. Three models answer independently, review each other's work, and the invoking agent synthesizes the verdict as chairman.

Works with **Claude Code**, **Codex CLI**, and **Gemini CLI**. Whichever tool you invoke from becomes the chairman. The others are council members.

Inspired by [Karpathy's LLM Council](https://github.com/karpathy/llm-council), adapted for the CLI agent ecosystem.

```
/council "Should we use Postgres or DynamoDB for our event sourcing system?"
```

```
Dispatching Stage 1 to 3 agents in parallel...
  - claude (timeout: 120s)
  - codex (timeout: 120s)
  - gemini (timeout: 180s)
  claude responded (38.2s)
  codex responded (52.1s)
  Quorum reached (2/3). Giving stragglers 30s grace...
  gemini responded (64.7s)
  All 3 agents responded.

Stage 1 complete: 3/3 successful opinions

--- CHAIRMAN SYNTHESIS (claude) ---

### Consensus
All agents agree: Postgres is the right choice given strong consistency
requirements and team SQL experience.

### Divergence
Claude emphasizes ACID guarantees as non-negotiable for account balances.
Codex flags a scaling ceiling at ~10TB without sharding.
Gemini suggests read replicas as a scaling bridge.

### Confidence
HIGH — Strong consensus across models.
```

## Why Agent Council?

**Every existing LLM council is API-call-based.** Karpathy's LLM Council, Perplexity Model Council, Council AI... they all pass text through API endpoints. Agent Council is different:

1. **Grounded deliberation.** Council members are CLI agents with tool access. They can `grep` your codebase, read migration files, run `git log`. Opinions are grounded in your actual project, not abstract text generation.

2. **Zero marginal cost.** You're tapping into subscriptions you already have (Claude Code, Codex, Gemini CLI). No new API tokens to buy.

3. **Living decisions.** Every deliberation is a hypothesis that can be re-evaluated. "We chose Postgres 3 months ago... re-run with what we know now." Use `/council-revisit` to compare then vs now.

## Quick Start

### Install via npm

```bash
npx cliagent-council
```

This clones the repo, installs skills for all detected CLI agents, and you're ready to go.

### Or install manually

```bash
git clone https://github.com/yogirk/agent-council.git
cd agent-council
./setup
```

**Platform:** macOS and Linux. Windows users: use [WSL](https://learn.microsoft.com/en-us/windows/wsl/).

**Requirements:** [Bun](https://bun.sh) + at least 2 of these CLI agents:
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`) — skills install to `~/.claude/skills/`
- [OpenAI Codex](https://github.com/openai/codex) (`codex`) — skills install to `~/.agents/skills/`
- [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`) — skills install to `~/.gemini/skills/`

## Usage

### As a skill (Claude Code, Codex CLI, Gemini CLI)

The same slash commands work in all three CLIs. The invoking agent automatically becomes the chairman.

```
/council "Should we use WebSockets or SSE for real-time updates?"
/council --with-review "Review auth middleware for security issues"
/council --quick "What's the best job queue for Node.js?"

/council-list                              # List all past sessions
/council-replay council-20260329-143000    # Replay a session in terminal
/council-revisit council-20260329-143000   # Re-run with current context (living decisions)
/council-outcome council-20260329-143000 "It worked great"  # Record outcome
/council-nudge council-20260329-143000 --agent codex --correction "Our data will never exceed 100GB"
```

When invoked from Claude Code, Claude is chairman. From Codex, Codex is chairman. From Gemini, Gemini is chairman. The chairman gives its own independent opinion in Stage 1, then synthesizes all opinions in Stage 3.

### From the command line
```bash
# Fast mode (default): opinions + synthesis
bin/council --question-file question.txt --project myapp

# Specify chairman explicitly (auto-detected if omitted)
bin/council --question-file question.txt --chairman codex --project myapp

# With peer review
bin/council --question-file question.txt --project myapp --with-review

# Browse past sessions
bin/council list --project myapp
bin/council replay council-20260329-143000 --project myapp

# Nudge: challenge an agent's assumptions after a session
bin/council nudge council-20260329-143000 --agent codex --correction "Budget is not a constraint" --project myapp

# Skip preflight health checks (faster startup)
bin/council --question-file question.txt --project myapp --skip-preflight
```

## How It Works

```
                    +------------------+
                    |   Your Question  |
                    +--------+---------+
                             |
              Stage 1: Independent Opinions
                             |
            +----------------+----------------+
            |                |                |
      +-----------+    +-----------+    +-----------+
      | Claude    |    | Codex     |    | Gemini    |
      | Code      |    | CLI       |    | CLI       |
      +-----------+    +-----------+    +-----------+
            |                |                |
            v                v                v
      [Opinion A]      [Opinion B]      [Opinion C]
            |                |                |
            +----------------+----------------+
                             |
               Stage 2: Anonymized Peer Review
                        (optional: --with-review)
                             |
                Stage 3: Chairman Synthesis
                             |
                    +------------------+
                    |  Final Verdict   |
                    |  with consensus  |
                    |  and dissent     |
                    +------------------+
                             |
               Stage 4: Targeted Nudge (optional)
                    "Your assumption about X is wrong"
                             |
                    +------------------+
                    | Updated Opinion  |
                    | with what changed|
                    +------------------+
```

**Stage 1:** ALL agents (including the chairman) answer independently, in parallel. Each gets your question + codebase context. No visibility into what others are producing. Once a quorum of opinions arrives, a grace window starts for slower agents.

**Stage 2** (optional): Each agent reviews the others' anonymized opinions. Scores them on correctness, completeness, and feasibility. Produces a ranking.

**Stage 3:** The chairman (whichever CLI you invoked from) reads all opinions (including its own from Stage 1) and synthesizes: where they agree, where they diverge, and a final recommendation with confidence level. When agents fundamentally disagree, the synthesis flags it explicitly with per-agent confidence so you can decide.

**Stage 4** (optional): After reading the verdict, you can nudge a specific agent: "Your assumption about X is wrong." The agent reconsiders with your correction and produces an updated recommendation explaining what changed and what stayed the same.

## Configuration

Create `~/.council/config.json` to customize models, timeouts, effort, and quorum behavior. **All fields are optional.**

```jsonc
{
  // Per-agent CLI model. Empty string ("") = let the CLI pick its tier-default.
  // Recommended for autopilot/long-running sessions; optional for interactive use.
  "models": {
    "claude": "opus",        // alias resolves to latest Opus on your subscription
    "codex":  "gpt-5.4",     // exact name; tier-dependent
    "gemini": ""             // empty: let Gemini CLI pick (verify before pinning)
  },

  // Per-agent timeout in ms. Number (applied to all) OR per-agent object.
  "timeout_ms": {
    "claude": 600000,
    "codex":  600000,
    "gemini": 600000
  },

  // Once enough agents respond (quorum), stragglers get this grace window. The
  // runtime clamps grace to never expire before any pending agent's own timeout.
  "quorum_grace_ms": 600000,

  // Reasoning effort. String OR per-agent object. Valid: max|high|medium|low|off.
  // Mode defaults: quick=high, fast=max, thorough=max.
  "effort": "max",

  // Set false to disable proactive /council suggestions in interactive sessions.
  "proactive": true
}
```

Mode defaults (no config file needed):

| Mode | Effort | Timeout | Grace |
|---|---|---|---|
| `quick` | high | 180s | 180s |
| `fast` (default) | max | 600s | 600s |
| `thorough` (`--with-review`) | max | 900s | 900s |

CLI flags `--effort <max|high|medium|low|off>` and `--unbounded` (no time cap) override per-run.

**Full config reference:** [`docs/configuration.md`](./docs/configuration.md).

## Storage

Council sessions are stored in `~/.council/{project}/`. Each session contains:
- `meta.json` — question, agents, mode, timestamp
- `stage1/opinion_*.json` — individual agent opinions
- `stage2/review_*.json` — peer reviews (if `--with-review`)
- `stage4/nudge_*.json` — nudge results (if nudge was used)
- `synthesis.json` — chairman's final verdict
- `viewer.html` — interactive viewer (open in browser)

## Viewer

Every council session generates a self-contained HTML viewer. Open it in your browser to explore:

- **Editorial monograph layout** with tonal surface layering (no borders)
- **Tabbed agent opinions** with full-width reading area showing recommendation, reasoning, assumptions, tradeoffs, belief triggers, and dissent
- **Verdict section** with consensus/divergence cards and horizontal metadata strip
- **Peer review matrix** with color-coded score pips and hover tooltips
- **Nudge timeline** with before/after diffs and "what changed" explanations
- **Light and dark mode** with toggle (respects system preference)
- **Agent identity** via colored geometric icons
- **Outcome banners** when a decision outcome has been recorded
- **Revisit comparison** side-by-side when viewing a revisited session
- Self-contained HTML, zero external dependencies, responsive, XSS-safe

## Does It Work?

We ran 3 benchmark questions through the council and compared against a single agent (Claude Opus 4.6). The council consistently found more considerations:

| Benchmark | Single Agent | Council | Delta |
|-----------|-------------|---------|-------|
| Database choice (Postgres vs DynamoDB) | 1/5 (20%) | 3/5 (60%) | +2 |
| Error handling (exceptions vs Result types) | 0/5 (0%) | 1/5 (20%) | +1 |
| Deployment (Kubernetes vs Docker Compose vs PaaS) | 3/5 (60%) | 4/5 (80%) | +1 |
| **Average** | **27%** | **53%** | **+1.3** |

The council found nearly 2x as many expected considerations. This measures consideration coverage (did the response mention scaling? cost? team experience?), not answer quality. Run your own eval: `bun run eval/run-eval.ts --dry-run` to see all 10 benchmarks. The test suite has 59 tests with 133 assertions covering adapters, parsing, prompts, preflight, nudge, and viewer generation.

## Proactive Suggestions

Agent Council can suggest `/council` when it detects you're making a decision with trade-offs. After setup, an ambient skill watches for patterns like:

- "should we use X or Y" → suggests `/council`
- Referencing past decisions → suggests `/council-revisit`
- Old council sessions without outcomes → suggests `/council-outcome`

Suggestions are quiet (a single line after the response), max 2 per session, and never interrupt your flow. Disable in `~/.council/config.json`:

```json
{ "proactive": false }
```

## Autopilot — autonomous loops on top of the council

For multi-hour autonomous work, agent-council ships an **autopilot** that decomposes a user goal into testable leaf goals (via the council), then (in live mode, future PR) spawns fresh `claude -p` subprocesses per leaf to implement against frozen test specs.

```bash
# 1. Write a goal
cp goal-template.md goal.md
$EDITOR goal.md

# 2. Bootstrap (auto-detects project type from manifest files)
bun run bin/autopilot --goal goal.md

# 3. Inspect what the council planned
ls .autopilot/goals/        # human-readable leaf goal descriptions
ls .council/specs/          # frozen test specs in your project's native test format
cat .autopilot/AUTOPILOT.md # project context for spawned subprocesses

# 4. If wrong: --reset and rephrase. If right: --live (future PR) runs implementation.
```

**Architecture:**
- **Strategy C** (test-as-brain): done-signal is the test runner's exit code, not LLM judgment. Implementation Claude can't edit the spec — pre-commit hook + clean-checkout verifier defend against fake progress.
- **Council can VETO but never BLESS**: final-review council (PR9) can deny `done` but can't grant it. Truth flows from `bun test`, not consensus.
- **One stuck-rescue council per goal**, then rollback to last green and advance. No paging; failures land in `FAILED_GOALS.md`.
- **Repo-local state** at `<repo>/.autopilot/state.json` (gitignored, atomic writes, compaction-survivable).
- **Auto-pause-and-resume across rate-limit windows** (no per-token cost; bounded by subscription quotas).

**Multi-architecture support.** The autopilot detects your project's language/test framework from manifest files and writes specs in the right format. Built-in profiles for **TypeScript+Bun**, **TypeScript+Node (Vitest/Jest)**, **Python+Poetry**, **Python+pytest**, **Go**, **Rust**, **Ruby+RSpec**, with a generic fallback. Custom profiles via `--profile-file <json>` for stacks like Elixir+Mix.

```
pyproject.toml + poetry.lock  → python-poetry
package.json + bun.lock       → typescript-bun
Cargo.toml                    → rust
... (full list: docs/profiles.md)
```

Override auto-detection: `--profile <id>` or `--profile-file <path>`.

**Detailed docs:**
- [`docs/autopilot.md`](./docs/autopilot.md) — full guide, architecture, fake-progress defenses
- [`docs/profiles.md`](./docs/profiles.md) — profile reference, custom profile JSON
- [`docs/configuration.md`](./docs/configuration.md) — `~/.council/config.json` field reference

## Use Cases

- **Architecture decisions:** "Postgres vs DynamoDB for event sourcing at 10k events/sec?"
- **Code review:** "Review this auth middleware for security issues"
- **Debugging:** "Our API latency spiked 3x after commit abc123. Most likely cause?"
- **Technology selection:** "Compare BullMQ, Agenda, and bee-queue for our Node.js job queue"
- **Long-running implementation work** (autopilot): "Build a CSV→Parquet converter with property tests"
- **General questions:** Works for any question, not just engineering

## What This Is Not

- **Not a replacement for single-agent work.** Most tasks don't need a council. Use for decisions with meaningful trade-offs.
- **Not a code generation tool.** The council deliberates and recommends. It doesn't write code collaboratively.
- **Not cheap in time.** Expect 60-120 seconds for fast mode. This is a "stop and think" tool.
- **Not real-time.** Parallel dispatch helps, but CLI agents take time.

## Roadmap

- **v0.1.0** (done): Three-stage deliberation, 3 adapters, cross-platform skills (Claude Code + Codex + Gemini), living decisions, outcome tracking, security hardening, progressive output, proactive nudge system, evaluation benchmarks
- **v0.2.0** (done): Editorial monograph viewer redesign, consensus KPI fix, contextual nudges in skill flow
- **v0.3.0** (done): Preflight health checks, error classification, retry wrapper, nudge subcommand (challenge agent assumptions), assumptions/belief trigger parsing, 59 tests
- **Next:** Shareable deliberation exports, calibration profiles (which model is best at what), input snapshotting for reproducible sessions

## License

MIT
