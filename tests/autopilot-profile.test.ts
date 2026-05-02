import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import {
  BUILTIN_PROFILES,
  PROFILE_GENERIC,
  PROFILE_GO,
  PROFILE_PYTHON_POETRY,
  PROFILE_PYTHON_PYTEST,
  PROFILE_RUBY_RSPEC,
  PROFILE_RUST,
  PROFILE_TYPESCRIPT_BUN,
  PROFILE_TYPESCRIPT_JEST,
  PROFILE_TYPESCRIPT_NODE,
  detectProfile,
  listProfileIds,
  loadCustomProfile,
  profileById,
} from "../src/autopilot-profile";

const tmpDir = resolve(import.meta.dir, ".tmp-autopilot-profile-test");

afterAll(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function freshRepo(name: string): string {
  const dir = resolve(tmpDir, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("Built-in profiles — sanity", () => {
  test("each profile has a unique id", () => {
    const ids = BUILTIN_PROFILES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("each profile produces a valid spec_test_command for a sample path", () => {
    for (const p of BUILTIN_PROFILES) {
      const cmd = p.spec_test_command(".council/specs/g1.test.ts");
      expect(typeof cmd).toBe("string");
      expect(cmd.length).toBeGreaterThan(0);
    }
  });

  test("each profile produces a non-empty spec_filename for any goal id", () => {
    for (const p of BUILTIN_PROFILES) {
      expect(p.spec_filename("g1").length).toBeGreaterThan(0);
      expect(p.spec_filename("g1")).toContain("g1");
    }
  });

  test("listProfileIds returns all built-in ids", () => {
    const ids = listProfileIds();
    expect(ids).toContain("typescript-bun");
    expect(ids).toContain("python-poetry");
    expect(ids).toContain("python-pytest");
    expect(ids).toContain("go");
    expect(ids).toContain("rust");
    expect(ids).toContain("ruby-rspec");
    expect(ids).toContain("generic");
  });

  test("profileById returns the right profile or null", () => {
    expect(profileById("typescript-bun")?.language).toBe("TypeScript");
    expect(profileById("python-poetry")?.language).toBe("Python");
    expect(profileById("nonexistent")).toBeNull();
  });
});

describe("Profile spec filename conventions", () => {
  test("TypeScript profiles use .test.ts", () => {
    expect(PROFILE_TYPESCRIPT_BUN.spec_filename("g1")).toBe("g1.test.ts");
    expect(PROFILE_TYPESCRIPT_NODE.spec_filename("g3")).toBe("g3.test.ts");
    expect(PROFILE_TYPESCRIPT_JEST.spec_filename("g3")).toBe("g3.test.ts");
  });

  test("Python profiles use test_<id>.py (pytest convention)", () => {
    expect(PROFILE_PYTHON_POETRY.spec_filename("g1")).toBe("test_g1.py");
    expect(PROFILE_PYTHON_PYTEST.spec_filename("g3")).toBe("test_g3.py");
  });

  test("Go uses <id>_test.go", () => {
    expect(PROFILE_GO.spec_filename("g1")).toBe("g1_test.go");
  });

  test("Rust uses <id>_test.rs (intended for tests/ directory)", () => {
    expect(PROFILE_RUST.spec_filename("g1")).toBe("g1_test.rs");
  });

  test("Ruby+RSpec uses <id>_spec.rb", () => {
    expect(PROFILE_RUBY_RSPEC.spec_filename("g1")).toBe("g1_spec.rb");
  });
});

describe("detectProfile — auto-detection from manifest files", () => {
  test("python-poetry: pyproject.toml with [tool.poetry] block", () => {
    const dir = freshRepo("py-poetry");
    writeFileSync(
      resolve(dir, "pyproject.toml"),
      `[tool.poetry]\nname = "thing"\n`,
      "utf-8"
    );
    const p = detectProfile(dir);
    expect(p.id).toBe("python-poetry");
  });

  test("python-pytest: pyproject.toml without poetry", () => {
    const dir = freshRepo("py-pytest");
    writeFileSync(resolve(dir, "pyproject.toml"), `[build-system]\nrequires = ["setuptools"]\n`, "utf-8");
    const p = detectProfile(dir);
    expect(p.id).toBe("python-pytest");
  });

  test("python-pytest: requirements.txt fallback", () => {
    const dir = freshRepo("py-req");
    writeFileSync(resolve(dir, "requirements.txt"), "pytest\n", "utf-8");
    const p = detectProfile(dir);
    expect(p.id).toBe("python-pytest");
  });

  test("typescript-bun: package.json with bun in test script", () => {
    const dir = freshRepo("ts-bun");
    writeFileSync(
      resolve(dir, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "bun test" } }, null, 2),
      "utf-8"
    );
    const p = detectProfile(dir);
    expect(p.id).toBe("typescript-bun");
  });

  test("typescript-bun: package.json + bun.lock file", () => {
    const dir = freshRepo("ts-bun-lock");
    writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: "x", scripts: {} }), "utf-8");
    writeFileSync(resolve(dir, "bun.lock"), "{}", "utf-8");
    const p = detectProfile(dir);
    expect(p.id).toBe("typescript-bun");
  });

  test("typescript-node: package.json with vitest in devDependencies", () => {
    const dir = freshRepo("ts-vitest");
    writeFileSync(
      resolve(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { vitest: "^1.0.0" } }),
      "utf-8"
    );
    const p = detectProfile(dir);
    expect(p.id).toBe("typescript-node");
  });

  test("typescript-jest: package.json with jest in devDependencies", () => {
    const dir = freshRepo("ts-jest");
    writeFileSync(
      resolve(dir, "package.json"),
      JSON.stringify({ name: "x", devDependencies: { jest: "^29.0.0" } }),
      "utf-8"
    );
    const p = detectProfile(dir);
    expect(p.id).toBe("typescript-jest");
  });

  test("go: go.mod present", () => {
    const dir = freshRepo("go");
    writeFileSync(resolve(dir, "go.mod"), "module example.com/x\n", "utf-8");
    const p = detectProfile(dir);
    expect(p.id).toBe("go");
  });

  test("rust: Cargo.toml present", () => {
    const dir = freshRepo("rust");
    writeFileSync(resolve(dir, "Cargo.toml"), `[package]\nname = "x"\n`, "utf-8");
    const p = detectProfile(dir);
    expect(p.id).toBe("rust");
  });

  test("ruby-rspec: Gemfile with rspec", () => {
    const dir = freshRepo("ruby");
    writeFileSync(resolve(dir, "Gemfile"), `gem "rspec"\n`, "utf-8");
    const p = detectProfile(dir);
    expect(p.id).toBe("ruby-rspec");
  });

  test("generic: no manifest files at all", () => {
    const dir = freshRepo("empty");
    const p = detectProfile(dir);
    expect(p.id).toBe("generic");
  });

  test("python-poetry takes precedence over python-pytest when poetry.lock present", () => {
    const dir = freshRepo("py-precedence");
    writeFileSync(resolve(dir, "pyproject.toml"), `[tool.poetry]\nname = "x"\n`, "utf-8");
    writeFileSync(resolve(dir, "poetry.lock"), "{}", "utf-8");
    const p = detectProfile(dir);
    expect(p.id).toBe("python-poetry");
  });
});

describe("loadCustomProfile — JSON-loaded profiles", () => {
  test("loads a complete custom profile (Elixir+Mix)", () => {
    const dir = freshRepo("custom");
    const profilePath = resolve(dir, "elixir.json");
    writeFileSync(
      profilePath,
      JSON.stringify({
        id: "elixir-mix",
        display_name: "Elixir (Mix)",
        language: "Elixir",
        test_framework: "ExUnit",
        test_command: "mix test",
        spec_test_command_template: "mix test {{spec_path}}",
        spec_filename_template: "{{goal_id}}_test.exs",
        spec_extension: ".exs",
        manifest_files: ["mix.exs"],
        prompt_language_block: "Elixir + ExUnit.",
        prompt_spec_example: "defmodule G1Test do\n  use ExUnit.Case\n  test \"x\" do\n    assert true\n  end\nend\n",
      }),
      "utf-8"
    );
    const p = loadCustomProfile(profilePath);
    expect(p.id).toBe("elixir-mix");
    expect(p.language).toBe("Elixir");
    expect(p.test_command).toBe("mix test");
    expect(p.spec_test_command(".council/specs/g3_test.exs")).toBe("mix test .council/specs/g3_test.exs");
    expect(p.spec_filename("g5")).toBe("g5_test.exs");
  });

  test("rejects custom profile missing required fields", () => {
    const dir = freshRepo("custom-bad");
    const profilePath = resolve(dir, "bad.json");
    writeFileSync(profilePath, JSON.stringify({ id: "x" }), "utf-8");
    expect(() => loadCustomProfile(profilePath)).toThrow(/missing required fields/);
  });
});
