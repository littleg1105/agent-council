import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import { augmentEnvForVerifier, augmentEnvWithProjectBins } from "../src/autopilot-env";

const tmpDir = resolve(import.meta.dir, ".tmp-env-test");

afterAll(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function freshRepo(name: string): string {
  const dir = resolve(tmpDir, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("augmentEnvWithProjectBins", () => {
  test("prepends .venv/bin to PATH when present (Python+Poetry case)", () => {
    const dir = freshRepo("py-venv");
    mkdirSync(resolve(dir, ".venv", "bin"), { recursive: true });
    const env = augmentEnvWithProjectBins(dir, { PATH: "/usr/bin:/bin" });
    expect(env.PATH).toContain(`${dir}/.venv/bin`);
    expect(env.PATH.startsWith(`${dir}/.venv/bin`)).toBe(true);
    expect(env.PATH.endsWith("/usr/bin:/bin")).toBe(true);
  });

  test("prepends node_modules/.bin to PATH when present", () => {
    const dir = freshRepo("node-bin");
    mkdirSync(resolve(dir, "node_modules", ".bin"), { recursive: true });
    const env = augmentEnvWithProjectBins(dir, { PATH: "/usr/bin" });
    expect(env.PATH).toContain(`${dir}/node_modules/.bin`);
    expect(env.PATH.startsWith(`${dir}/node_modules/.bin`)).toBe(true);
  });

  test("prepends BOTH .venv/bin AND node_modules/.bin (with .venv first)", () => {
    const dir = freshRepo("both");
    mkdirSync(resolve(dir, ".venv", "bin"), { recursive: true });
    mkdirSync(resolve(dir, "node_modules", ".bin"), { recursive: true });
    const env = augmentEnvWithProjectBins(dir, { PATH: "/usr/bin" });
    const venvIdx = env.PATH.indexOf(`${dir}/.venv/bin`);
    const nmIdx = env.PATH.indexOf(`${dir}/node_modules/.bin`);
    expect(venvIdx).toBeGreaterThan(-1);
    expect(nmIdx).toBeGreaterThan(-1);
    expect(venvIdx).toBeLessThan(nmIdx); // .venv first
  });

  test("leaves PATH unchanged when no project-local bin dirs exist", () => {
    const dir = freshRepo("none");
    const env = augmentEnvWithProjectBins(dir, { PATH: "/usr/bin:/bin" });
    expect(env.PATH).toBe("/usr/bin:/bin");
  });

  test("preserves all other env vars from base env", () => {
    const dir = freshRepo("preserve");
    const env = augmentEnvWithProjectBins(dir, {
      PATH: "/usr/bin",
      HOME: "/Users/test",
      LANG: "en_US.UTF-8",
      MY_VAR: "x",
    });
    expect(env.HOME).toBe("/Users/test");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(env.MY_VAR).toBe("x");
  });

  test("works without a base env (falls back to process.env)", () => {
    const dir = freshRepo("default");
    const env = augmentEnvWithProjectBins(dir);
    // process.env always has at least HOME/PATH on a real shell
    expect(typeof env.PATH).toBe("string");
  });
});

describe("augmentEnvForVerifier — additionally strips API keys", () => {
  test("strips ANTHROPIC_API_KEY", () => {
    const dir = freshRepo("strip-anthropic");
    const env = augmentEnvForVerifier(dir, {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-ant-secret",
      HOME: "/Users/test",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.HOME).toBe("/Users/test");
  });

  test("strips OPENAI_API_KEY, GEMINI_API_KEY, CODEX_API_KEY, CLAUDE_CODE_OAUTH_TOKEN", () => {
    const dir = freshRepo("strip-many");
    const env = augmentEnvForVerifier(dir, {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "sk-openai-secret",
      GEMINI_API_KEY: "gem-secret",
      CODEX_API_KEY: "codex-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
      OTHER_VAR: "kept",
    });
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(env.OTHER_VAR).toBe("kept");
  });

  test("does NOT strip vars that just happen to start with a redacted prefix without the right suffix", () => {
    const dir = freshRepo("preserve-prefix");
    const env = augmentEnvForVerifier(dir, {
      PATH: "/usr/bin",
      ANTHROPIC_USER: "george",  // no _KEY/_TOKEN/_API_KEY suffix
      OPENAI_DEBUG: "1",
    });
    expect(env.ANTHROPIC_USER).toBe("george");
    expect(env.OPENAI_DEBUG).toBe("1");
  });

  test("still augments PATH like the non-stripping variant", () => {
    const dir = freshRepo("strip-and-augment");
    mkdirSync(resolve(dir, ".venv", "bin"), { recursive: true });
    const env = augmentEnvForVerifier(dir, {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-secret",
    });
    expect(env.PATH.startsWith(`${dir}/.venv/bin`)).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});
