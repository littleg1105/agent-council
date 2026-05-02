# Project profiles

The autopilot is **architecture-aware**. When it dispatches the bootstrap council and writes test specs to disk, it does so in the target project's native language and test framework — not the language the autopilot itself happens to be written in.

This matters because the autopilot's bootstrap council generates **frozen test specs** that the implementing subprocess must satisfy. Those specs need to be runnable by the project's test runner (`pytest`, `bun test`, `cargo test`, etc.). A profile is the description of "how to run tests in this project" + "what the spec files look like."

## How profile selection works

In priority order:

1. **`--profile-file <path.json>`** — load a custom profile from JSON (highest priority)
2. **`--profile <id>`** — pick a built-in by id (e.g. `python-poetry`)
3. **Auto-detection** — scan the repo root for manifest files and pick the first match
4. **`generic` fallback** — when nothing above matches; the autopilot warns

Auto-detection is keyed on manifest files in the repo root, in the order shown below. The first profile whose manifest exists (and whose content matcher, if any, returns true) wins.

## Built-in profiles

| Profile id | Display name | Manifest match | Spec filename | Test runner |
|---|---|---|---|---|
| `python-poetry` | Python (Poetry + pytest) | `pyproject.toml` with `[tool.poetry]` block, OR `poetry.lock` present | `test_g<N>.py` | `poetry run pytest <file>` |
| `python-pytest` | Python (pytest) | `pyproject.toml` / `setup.py` / `setup.cfg` / `requirements.txt` | `test_g<N>.py` | `pytest <file>` |
| `typescript-bun` | TypeScript (Bun) | `package.json` with `"bun test"` in scripts, OR `bun.lock`/`bun.lockb` present, OR `bun` in devDependencies | `g<N>.test.ts` | `bun test <file>` |
| `typescript-node` | TypeScript (Node + Vitest) | `package.json` with `vitest` in dependencies | `g<N>.test.ts` | `npx vitest run <file>` |
| `typescript-jest` | TypeScript (Node + Jest) | `package.json` with `jest` in devDependencies | `g<N>.test.ts` | `npx jest <file>` |
| `go` | Go | `go.mod` | `g<N>_test.go` | `go test <file>` |
| `rust` | Rust (Cargo) | `Cargo.toml` | `g<N>_test.rs` | `cargo test --test <name>` |
| `ruby-rspec` | Ruby (RSpec) | `Gemfile` containing `rspec`, OR a `spec/` directory | `g<N>_spec.rb` | `bundle exec rspec <file>` |
| `generic` | Generic (no test runner) | (fallback) | `g<N>.md` (placeholder) | — |

### Detection precedence

When multiple manifests would match, more-specific profiles come first:

- `python-poetry` is checked **before** `python-pytest`. A repo with `pyproject.toml [tool.poetry]` AND `requirements.txt` will be detected as `python-poetry`.
- `typescript-bun` / `typescript-node` / `typescript-jest` all look at `package.json`; the matcher uses the `scripts.test` field, lockfiles, and devDependencies to pick.
- If a Python/Ruby/Node project ALSO has `Cargo.toml` (rare), the registration order in `BUILTIN_PROFILES` decides — TypeScript variants come first.

## Sharp edges per profile

### `python-poetry` and `python-pytest`

Pytest discovers `test_*.py` and `*_test.py` files automatically. The autopilot uses `test_g<N>.py`. To run **only** an autopilot spec (the verifier does this per-leaf), pass the spec path directly: `pytest .council/specs/test_g3.py`. This works even when there's a `tests/` directory — pytest doesn't care where the file lives as long as the function names start with `test_`.

If your project's `pyproject.toml` configures `[tool.pytest.ini_options]` with restrictive `testpaths` that exclude `.council/`, you'll need to add `.council/specs` to the `testpaths` list, or pass `--rootdir .council/specs` via a custom profile.

### `typescript-bun`

Detection prefers `bun test` in `package.json` `scripts.test`, but also accepts `bun.lock` / `bun.lockb` presence even if the test script is missing. If your project uses Bun for runtime but Vitest for tests, override with `--profile typescript-node`.

### `typescript-node` / `typescript-jest`

Both share `package.json`. The matchers look at `devDependencies` for `vitest` vs `jest`. If you have BOTH (rare; usually a migration), Vitest wins because of registration order — override with `--profile typescript-jest` if you actually want Jest.

### `go`

**Sharp edge: package-aware test discovery.** Go's `go test` command requires test files to be in a Go package, not arbitrary files. The autopilot writes specs to `.council/specs/g<N>_test.go` — but for `go test` to find them, that directory needs to be a valid Go package (i.e., have a `package <name>` declaration in each file).

The bootstrap council is told this in the prompt and instructs agents to write specs with `package specs` at the top. The verify command then runs `go test ./.council/specs/...`. **You may need to add `.council/specs/` to your `go.work` file or root module** depending on your project layout.

If you'd rather use Go's standard `*_test.go` placement (alongside source files), write a custom profile with the spec output path adjusted.

### `rust`

**Sharp edge: cargo's tests/ convention.** Cargo only finds integration tests in `tests/` (next to `src/`) or unit tests inline in `src/`. There's no way to put tests in `.council/specs/` and have `cargo test` discover them.

The `rust` profile works around this by writing specs to `tests/g<N>_test.rs` (NOT `.council/specs/`). This is the only profile that doesn't use `.council/specs/`. The pre-commit-hook frozen-spec defense (PR9) needs to be aware of this — it watches `tests/g<N>_test.rs` for autopilot-managed projects.

If you want a different layout, write a custom profile.

### `ruby-rspec`

RSpec discovers `*_spec.rb` files. The autopilot uses `g<N>_spec.rb` written to `.council/specs/`. Run with `bundle exec rspec .council/specs/g<N>_spec.rb`.

If your project has `.rspec` configured with `--default-path spec`, the autopilot's specs in `.council/specs/` are still runnable by passing the path explicitly (which the verifier does).

### `generic`

When **nothing matches**, the autopilot falls back to `generic`. This profile:

- Writes specs as Markdown placeholder files (`.council/specs/g<N>.md`) with acceptance-criteria checkboxes instead of executable test code.
- Has no `test_command`, so the verify command would fail.
- Prints a stderr warning at startup: "no project type detected. Use --profile <id> or --profile-file <path> to fix."

In this state, dry-run still works (council generates the goal+spec files), but `--live` will fail because the verifier has no way to determine "done."

**The right move when you hit `generic`**: write a custom profile JSON for your stack and pass `--profile-file`.

## Custom profile JSON

For stacks not in the built-in table (Elixir, Erlang, Crystal, Gleam, Zig, Dart, etc.), pass `--profile-file path/to/profile.json`. Required fields:

```json
{
  "id": "elixir-mix",
  "display_name": "Elixir (Mix + ExUnit)",
  "language": "Elixir",
  "test_framework": "ExUnit",
  "test_command": "mix test",
  "spec_test_command_template": "mix test {{spec_path}}",
  "spec_filename_template": "{{goal_id}}_test.exs",
  "spec_extension": ".exs",
  "manifest_files": ["mix.exs"],
  "prompt_language_block": "The implementing subprocess uses Elixir + ExUnit managed by Mix. Specs live in test/ and end with _test.exs.",
  "prompt_spec_example": "defmodule G1Test do\n  use ExUnit.Case\n  test \"does the thing\" do\n    assert ...\n  end\nend\n",
  "typecheck_command": null
}
```

### Field reference

- **`id`** (required) — stable identifier; what you'd pass to `--profile`.
- **`display_name`** (recommended) — human-readable name shown in stderr / docs. Falls back to `id`.
- **`language`** (recommended) — for prose injected into the bootstrap prompt. Falls back to `(custom)`.
- **`test_framework`** (recommended) — same. Falls back to `(custom)`.
- **`test_command`** (required) — entire-suite test command. Used in the bootstrap prompt and as the first clause of the done-signal.
- **`spec_test_command_template`** (recommended) — template for running ONE spec file. `{{spec_path}}` is substituted. Falls back to `<test_command> {{spec_path}}`.
- **`spec_filename_template`** (required) — template for spec filenames. `{{goal_id}}` is substituted (e.g., `"g3"`). Must produce a filename including extension.
- **`spec_extension`** (recommended) — used in the bootstrap prompt to tell the council what extension to expect. Falls back to `.test`.
- **`manifest_files`** (optional) — array of relative paths whose presence indicates this profile. Only used by `detectProfile()`; if you're loading via `--profile-file`, manifest detection is skipped.
- **`prompt_language_block`** (recommended) — block of prose injected into the bootstrap council prompt. Tells the agents what language/framework/conventions to use.
- **`prompt_spec_example`** (recommended) — a worked example of a spec file in the project's native syntax. Agents are told to "match this shape." If absent, the council might generate specs in a wrong dialect.
- **`typecheck_command`** (optional) — separate typecheck/lint preflight, run before tests. `null` means "no separate typecheck." Falls back to `null`.

### Loading a custom profile

```bash
# One-off
bun run bin/autopilot --goal goal.md --profile-file ./elixir-mix.json

# Per-project standard practice: keep the profile in the repo
bun run bin/autopilot --goal goal.md --profile-file ./.autopilot/profile.json
```

A custom profile lives entirely in JSON; you don't need to modify the autopilot source. For more advanced behavior (e.g., a `manifest_matcher` predicate that inspects file contents, custom build steps), extend `BUILTIN_PROFILES` in `src/autopilot-profile.ts` and submit a PR.

## Adding a built-in profile

If your stack is common enough to warrant first-class support, add it to `src/autopilot-profile.ts`:

```ts
export const PROFILE_ELIXIR_MIX: ProjectProfile = {
  id: "elixir-mix",
  display_name: "Elixir (Mix + ExUnit)",
  language: "Elixir",
  test_framework: "ExUnit",
  test_command: "mix test",
  spec_test_command: (p) => `mix test ${p}`,
  typecheck_command: null,
  spec_extension: ".exs",
  spec_filename: (id) => `${id}_test.exs`,
  manifest_files: ["mix.exs"],
  manifest_matcher: undefined, // any-match
  prompt_language_block: "The implementing subprocess uses Elixir + ExUnit ...",
  prompt_spec_example: `defmodule G1Test do\n  use ExUnit.Case\n  test "does the thing" do\n    assert ...\n  end\nend\n`,
};

// Register in BUILTIN_PROFILES (more-specific profiles before more-general):
export const BUILTIN_PROFILES: ProjectProfile[] = [
  // ...existing...
  PROFILE_ELIXIR_MIX,
  PROFILE_GENERIC,  // always last
];
```

Plus add tests in `tests/autopilot-profile.test.ts` covering: spec_filename, spec_test_command, manifest detection from a temp `mix.exs` file. The existing tests follow this pattern for each built-in profile.

## What the bootstrap council sees

When the autopilot dispatches the bootstrap council, the active profile contributes these fields to the prompt:

```
PROJECT TYPE: **<display_name>** (<language>)

<prompt_language_block>

CONTEXT:
- Each leaf is verified by running its frozen test spec via the project's
  test runner: `<test_command>`. The done-signal is the runner's exit
  code, not LLM judgment.
- Spec files use the extension `<spec_extension>`.

EXAMPLE SPEC SHAPE (match this for your generated specs):

<prompt_spec_example>
```

Each agent then writes its decomposition with specs in the right shape. The synthesizer picks the best decomposition. The autopilot writes specs to disk using `spec_filename(id)` for the filename.

## Auto-detection rules — exactly which file matters

Source of truth: `BUILTIN_PROFILES` in `src/autopilot-profile.ts`. The `detectProfile(repoRoot)` function walks profiles in registration order and checks each one's `manifest_files` array. For each manifest:

1. Does the file exist at `<repoRoot>/<manifest>`? If no, skip.
2. Does the profile have a `manifest_matcher`? If no, return this profile.
3. If yes, read the file's content and call `manifest_matcher(path, content)`. If it returns true, return this profile. Otherwise, continue.

The `manifest_matcher` enables fine-grained discrimination — e.g., `python-poetry` is matched only when `pyproject.toml` contains `[tool.poetry]` OR a sibling `poetry.lock` exists. `typescript-bun` is matched on `package.json` only when bun shows up in `scripts.test`, dependencies, or as a sibling lockfile.

## See also

- [autopilot.md](./autopilot.md) — full autopilot user guide
- `src/autopilot-profile.ts` — source of truth for built-in profiles + auto-detection
- `tests/autopilot-profile.test.ts` — examples of how each profile is tested
