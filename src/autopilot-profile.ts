/**
 * Project profiles for the autopilot.
 *
 * The autopilot needs to know the target project's language, test framework,
 * and verify commands so the bootstrap council can produce specs in the right
 * format and the implementing subprocess can verify against the right tools.
 *
 * Built-in profiles cover the common cases (TypeScript+Bun, TypeScript+Node,
 * Python+pytest, Go, Rust+cargo, Ruby+RSpec). Auto-detection inspects the
 * repo root for manifest files (package.json, pyproject.toml, Cargo.toml, ...)
 * and picks the best match. `--profile <id>` on the CLI overrides detection.
 * `--profile-file <path>` loads a custom profile from JSON for exotic stacks.
 *
 * Profiles are pure data — no I/O, no globals — so they're trivially testable
 * and composable. The autopilot's prompt builders take a profile parameter
 * and produce architecture-appropriate output.
 */

import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

export interface ProjectProfile {
  /** Stable identifier, e.g. "typescript-bun", "python-pytest". Used in --profile flag. */
  id: string;
  /** Human-readable name for log/doc output. */
  display_name: string;
  /** Programming language. */
  language: string;
  /** Test framework name (used in prompts). */
  test_framework: string;
  /**
   * Command to run the entire test suite (relative to repo root). Used as
   * the first clause of the done-signal command.
   */
  test_command: string;
  /**
   * Build a command that runs ONLY the test file at the given path.
   * Used by the per-goal verify command and the clean-checkout replay.
   */
  spec_test_command: (specPath: string) => string;
  /**
   * Optional typecheck/lint pre-flight. null means "no separate typecheck step".
   * The done-signal includes this when set.
   */
  typecheck_command: string | null;
  /** File extension for spec files, e.g. ".test.ts", "_test.py". */
  spec_extension: string;
  /**
   * Build the spec filename for a given goal id, e.g. ("g3") => "g3.test.ts"
   * or ("g3") => "test_g3.py" (pytest convention).
   */
  spec_filename: (goalId: string) => string;
  /**
   * Manifest files (relative to repo root) whose presence indicates this profile.
   * Auto-detection walks profiles in registration order; first match wins.
   */
  manifest_files: string[];
  /**
   * Optional content matcher applied to a manifest file. If set, the manifest must
   * exist AND its content must match the predicate to pick this profile. Lets us
   * distinguish e.g. Bun-with-package.json from Node-with-package.json.
   */
  manifest_matcher?: (manifestPath: string, content: string) => boolean;
  /**
   * Block of prose injected into the bootstrap prompt. Tells the council what
   * language/framework/conventions the implementing subprocess will use.
   */
  prompt_language_block: string;
  /**
   * Example spec snippet shown to the council in the bootstrap prompt. Used as
   * the spec_content example so agents produce specs in the right shape.
   */
  prompt_spec_example: string;
}

/* --- Built-in profiles --- */

export const PROFILE_TYPESCRIPT_BUN: ProjectProfile = {
  id: "typescript-bun",
  display_name: "TypeScript (Bun)",
  language: "TypeScript",
  test_framework: "bun:test",
  test_command: "bun test",
  spec_test_command: (p) => `bun test ${p}`,
  typecheck_command: "bun run typecheck",
  spec_extension: ".test.ts",
  spec_filename: (id) => `${id}.test.ts`,
  manifest_files: ["package.json"],
  manifest_matcher: (_path, content) => {
    try {
      const pkg = JSON.parse(content);
      const test = pkg.scripts?.test || "";
      const dev = JSON.stringify(pkg.devDependencies || {});
      return test.includes("bun test") || dev.includes("\"bun\"") || existsSync(resolve(_path, "..", "bun.lockb")) || existsSync(resolve(_path, "..", "bun.lock"));
    } catch {
      return false;
    }
  },
  prompt_language_block:
    "The implementing subprocess uses **Bun + TypeScript**. Specs use `bun:test` syntax (`import { describe, test, expect } from \"bun:test\"`). The verify command is `bun test <spec_file>`.",
  prompt_spec_example: `import { describe, test, expect } from "bun:test";\n\ndescribe("g1: title", () => {\n  test("does the thing", () => {\n    expect(...).toBe(...);\n  });\n});\n`,
};

export const PROFILE_TYPESCRIPT_NODE: ProjectProfile = {
  id: "typescript-node",
  display_name: "TypeScript (Node + Vitest)",
  language: "TypeScript",
  test_framework: "vitest",
  test_command: "npx vitest run",
  spec_test_command: (p) => `npx vitest run ${p}`,
  typecheck_command: "npx tsc --noEmit",
  spec_extension: ".test.ts",
  spec_filename: (id) => `${id}.test.ts`,
  manifest_files: ["package.json"],
  manifest_matcher: (_path, content) => {
    try {
      const pkg = JSON.parse(content);
      const dev = JSON.stringify(pkg.devDependencies || {});
      const deps = JSON.stringify(pkg.dependencies || {});
      return (dev.includes("vitest") || deps.includes("vitest")) && !dev.includes("\"bun\"");
    } catch {
      return false;
    }
  },
  prompt_language_block:
    "The implementing subprocess uses **TypeScript + Vitest** on Node. Specs use Vitest syntax (`import { describe, test, expect } from \"vitest\"`). The verify command is `npx vitest run <spec_file>`.",
  prompt_spec_example: `import { describe, test, expect } from "vitest";\n\ndescribe("g1: title", () => {\n  test("does the thing", () => {\n    expect(...).toBe(...);\n  });\n});\n`,
};

export const PROFILE_TYPESCRIPT_JEST: ProjectProfile = {
  id: "typescript-jest",
  display_name: "TypeScript (Node + Jest)",
  language: "TypeScript",
  test_framework: "jest",
  test_command: "npx jest",
  spec_test_command: (p) => `npx jest ${p}`,
  typecheck_command: "npx tsc --noEmit",
  spec_extension: ".test.ts",
  spec_filename: (id) => `${id}.test.ts`,
  manifest_files: ["package.json"],
  manifest_matcher: (_path, content) => {
    try {
      const pkg = JSON.parse(content);
      const dev = JSON.stringify(pkg.devDependencies || {});
      return dev.includes("jest");
    } catch {
      return false;
    }
  },
  prompt_language_block:
    "The implementing subprocess uses **TypeScript + Jest** on Node. Specs use Jest syntax (`describe`/`test`/`expect` are global). The verify command is `npx jest <spec_file>`.",
  prompt_spec_example: `describe("g1: title", () => {\n  test("does the thing", () => {\n    expect(...).toBe(...);\n  });\n});\n`,
};

export const PROFILE_PYTHON_POETRY: ProjectProfile = {
  id: "python-poetry",
  display_name: "Python (Poetry + pytest)",
  language: "Python",
  test_framework: "pytest",
  test_command: "poetry run pytest",
  spec_test_command: (p) => `poetry run pytest ${p}`,
  typecheck_command: null,
  spec_extension: ".py",
  spec_filename: (id) => `test_${id}.py`,
  manifest_files: ["pyproject.toml"],
  manifest_matcher: (_path, content) =>
    content.includes("[tool.poetry]") || content.includes("poetry-core") || existsSync(resolve(_path, "..", "poetry.lock")),
  prompt_language_block:
    "The implementing subprocess uses **Python + pytest** managed by Poetry. Specs use pytest convention (functions named `test_*` discovered by pytest). The verify command is `poetry run pytest <spec_file>`.",
  prompt_spec_example: `import pytest\n\n\ndef test_g1_does_the_thing() -> None:\n    assert ...\n`,
};

export const PROFILE_PYTHON_PYTEST: ProjectProfile = {
  id: "python-pytest",
  display_name: "Python (pytest)",
  language: "Python",
  test_framework: "pytest",
  test_command: "pytest",
  spec_test_command: (p) => `pytest ${p}`,
  typecheck_command: null,
  spec_extension: ".py",
  spec_filename: (id) => `test_${id}.py`,
  manifest_files: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt"],
  manifest_matcher: undefined, // any-match — fallback for non-poetry Python projects
  prompt_language_block:
    "The implementing subprocess uses **Python + pytest**. Specs use pytest convention (functions named `test_*` discovered by pytest). The verify command is `pytest <spec_file>`.",
  prompt_spec_example: `import pytest\n\n\ndef test_g1_does_the_thing() -> None:\n    assert ...\n`,
};

export const PROFILE_GO: ProjectProfile = {
  id: "go",
  display_name: "Go",
  language: "Go",
  test_framework: "go test",
  test_command: "go test ./...",
  // Go's test discovery is package-aware. Putting frozen specs in .council/specs/
  // requires the directory to be a Go package (package main or similar). Document
  // this constraint in CLAUDE.md and treat as a known sharp edge.
  spec_test_command: (p) => `go test ${p}`,
  typecheck_command: "go vet ./...",
  spec_extension: "_test.go",
  spec_filename: (id) => `${id}_test.go`,
  manifest_files: ["go.mod"],
  prompt_language_block:
    "The implementing subprocess uses **Go**. Specs use Go's built-in `testing` package (functions named `TestX` taking `*testing.T`). NOTE: Go's test discovery is package-aware — the spec directory must be a valid Go package. Place specs in `.council/specs/` with `package specs` and run with `go test ./.council/specs/...`.",
  prompt_spec_example: `package specs\n\nimport "testing"\n\nfunc TestG1DoesTheThing(t *testing.T) {\n\tif !true {\n\t\tt.Errorf("expected ...")\n\t}\n}\n`,
};

export const PROFILE_RUST: ProjectProfile = {
  id: "rust",
  display_name: "Rust (Cargo)",
  language: "Rust",
  test_framework: "cargo test",
  // Rust's test discovery requires tests under `tests/` or `src/`. We can't put
  // them under .council/specs/ and have cargo find them. Documented sharp edge:
  // Rust users should expect test files in `tests/` with the goal id in the
  // filename, e.g. `tests/g1_test.rs`.
  test_command: "cargo test",
  spec_test_command: (p) => `cargo test --test ${p.replace(/^tests\//, "").replace(/\.rs$/, "")}`,
  typecheck_command: "cargo check",
  spec_extension: ".rs",
  spec_filename: (id) => `${id}_test.rs`,
  manifest_files: ["Cargo.toml"],
  prompt_language_block:
    "The implementing subprocess uses **Rust + cargo**. Specs use Rust's `#[test]` attribute. NOTE: Rust's test discovery requires test files under `tests/` (integration tests) — the autopilot uses `tests/` for specs in this profile (NOT `.council/specs/`). Verify with `cargo test --test <name>`.",
  prompt_spec_example: `#[test]\nfn g1_does_the_thing() {\n    assert_eq!(2 + 2, 4);\n}\n`,
};

export const PROFILE_RUBY_RSPEC: ProjectProfile = {
  id: "ruby-rspec",
  display_name: "Ruby (RSpec)",
  language: "Ruby",
  test_framework: "rspec",
  test_command: "bundle exec rspec",
  spec_test_command: (p) => `bundle exec rspec ${p}`,
  typecheck_command: null,
  spec_extension: "_spec.rb",
  spec_filename: (id) => `${id}_spec.rb`,
  manifest_files: ["Gemfile"],
  manifest_matcher: (_path, content) =>
    content.includes("rspec") || existsSync(resolve(_path, "..", "spec")),
  prompt_language_block:
    "The implementing subprocess uses **Ruby + RSpec**. Specs use RSpec's `describe`/`it`/`expect` DSL. The verify command is `bundle exec rspec <spec_file>`.",
  prompt_spec_example: `require "rspec"\n\nRSpec.describe "g1: title" do\n  it "does the thing" do\n    expect(...).to eq(...)\n  end\nend\n`,
};

export const PROFILE_GENERIC: ProjectProfile = {
  id: "generic",
  display_name: "Generic (no test runner detected)",
  language: "(any)",
  test_framework: "(custom)",
  test_command: "echo 'no test command configured' && false",
  spec_test_command: (_p) => "echo 'no test command configured' && false",
  typecheck_command: null,
  spec_extension: ".md",
  spec_filename: (id) => `${id}.md`,
  manifest_files: [],
  prompt_language_block:
    "**No project type detected.** The autopilot fell back to the generic profile, which means the verify command is not configured and the implementing subprocess will need explicit test instructions in the goal. Specs are written as Markdown acceptance criteria. The user should configure --profile-file with a custom profile for their stack.",
  prompt_spec_example: `# g1: title\n\nAcceptance criteria:\n- [ ] criterion 1\n- [ ] criterion 2\n\n(This is a fallback profile. The autopilot does NOT have a test runner configured for this project.)\n`,
};

/**
 * Built-in profiles in detection order. More-specific profiles MUST come
 * before more-general ones (e.g., python-poetry before python-pytest, since
 * a poetry project has both pyproject.toml AND poetry.lock).
 */
export const BUILTIN_PROFILES: ProjectProfile[] = [
  PROFILE_TYPESCRIPT_BUN,
  PROFILE_TYPESCRIPT_NODE,
  PROFILE_TYPESCRIPT_JEST,
  PROFILE_PYTHON_POETRY,
  PROFILE_PYTHON_PYTEST,
  PROFILE_GO,
  PROFILE_RUST,
  PROFILE_RUBY_RSPEC,
  PROFILE_GENERIC,
];

/**
 * Auto-detect the project profile from manifest files in the repo root.
 * Returns the first profile whose manifest files exist (and whose
 * manifest_matcher, if defined, returns true). Falls back to PROFILE_GENERIC
 * when nothing matches.
 */
export function detectProfile(repoRoot: string): ProjectProfile {
  for (const profile of BUILTIN_PROFILES) {
    if (profile.id === "generic") continue; // skip the fallback in detection
    for (const manifest of profile.manifest_files) {
      const path = resolve(repoRoot, manifest);
      if (!existsSync(path)) continue;
      if (profile.manifest_matcher) {
        try {
          const content = readFileSync(path, "utf-8");
          if (profile.manifest_matcher(path, content)) return profile;
        } catch {
          continue;
        }
      } else {
        return profile;
      }
    }
  }
  return PROFILE_GENERIC;
}

/**
 * Look up a profile by id (for --profile <id> CLI flag). Returns null on
 * unknown id; caller decides whether to fail or fall back.
 */
export function profileById(id: string): ProjectProfile | null {
  return BUILTIN_PROFILES.find((p) => p.id === id) ?? null;
}

/**
 * List of all built-in profile ids, for --help and error messages.
 */
export function listProfileIds(): string[] {
  return BUILTIN_PROFILES.map((p) => p.id);
}

/**
 * Load a custom profile from a JSON file. The JSON must contain all required
 * fields except the function-typed ones (spec_test_command, spec_filename,
 * manifest_matcher) — those are reconstructed from string templates:
 *
 *   {
 *     "id": "elixir-mix",
 *     "language": "Elixir",
 *     "test_command": "mix test",
 *     "spec_test_command_template": "mix test {{spec_path}}",
 *     "spec_filename_template": "{{goal_id}}_test.exs",
 *     ...
 *   }
 *
 * Only string fields and string templates are supported in JSON; for full
 * function-based profiles, users must extend BUILTIN_PROFILES in source.
 */
export function loadCustomProfile(jsonPath: string): ProjectProfile {
  const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
  if (!raw.id || !raw.test_command || !raw.spec_filename_template) {
    throw new Error(
      `Custom profile at ${jsonPath} missing required fields (id, test_command, spec_filename_template).`
    );
  }
  const specCmdTpl: string = raw.spec_test_command_template || `${raw.test_command} {{spec_path}}`;
  const specFnTpl: string = raw.spec_filename_template;
  return {
    id: raw.id,
    display_name: raw.display_name || raw.id,
    language: raw.language || "(custom)",
    test_framework: raw.test_framework || "(custom)",
    test_command: raw.test_command,
    spec_test_command: (p) => specCmdTpl.replace("{{spec_path}}", p),
    typecheck_command: raw.typecheck_command || null,
    spec_extension: raw.spec_extension || ".test",
    spec_filename: (id) => specFnTpl.replace("{{goal_id}}", id),
    manifest_files: raw.manifest_files || [],
    prompt_language_block: raw.prompt_language_block || `Custom profile: ${raw.id}.`,
    prompt_spec_example: raw.prompt_spec_example || "// Custom spec example not provided\n",
  };
}
