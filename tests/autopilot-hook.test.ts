import { describe, test, expect, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "fs";
import { resolve } from "path";
import { installPreCommitHook, uninstallPreCommitHook } from "../src/autopilot-hook";

const tmpDir = resolve(import.meta.dir, ".tmp-hook-test");

afterAll(() => {
  if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

function freshGitRepo(name: string): string {
  const dir = resolve(tmpDir, name);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  mkdirSync(resolve(dir, ".git", "hooks"), { recursive: true });
  return dir;
}

describe("installPreCommitHook", () => {
  test("installs hook when missing", () => {
    const dir = freshGitRepo("install-fresh");
    const r = installPreCommitHook(dir);
    expect(r).toBe("installed");
    expect(existsSync(resolve(dir, ".git", "hooks", "pre-commit"))).toBe(true);
    const content = readFileSync(resolve(dir, ".git", "hooks", "pre-commit"), "utf-8");
    expect(content).toContain("agent-council autopilot pre-commit hook");
    expect(content).toContain(".autopilot/state.json");
  });

  test("returns 'installed' (no-op) when hook is identical", () => {
    const dir = freshGitRepo("install-twice");
    installPreCommitHook(dir);
    const r2 = installPreCommitHook(dir);
    expect(r2).toBe("installed");
  });

  test("returns 'updated' when our marker present but content differs", () => {
    const dir = freshGitRepo("install-update");
    // Write a stale version that has our marker but different content
    writeFileSync(
      resolve(dir, ".git", "hooks", "pre-commit"),
      "#!/bin/bash\n# agent-council autopilot pre-commit hook (old)\necho stale\nexit 0\n",
      "utf-8"
    );
    const r = installPreCommitHook(dir);
    expect(r).toBe("updated");
    const content = readFileSync(resolve(dir, ".git", "hooks", "pre-commit"), "utf-8");
    expect(content).toContain(".autopilot/state.json");  // new content
  });

  test("returns 'preserved' (does NOT overwrite) when a non-autopilot hook exists", () => {
    const dir = freshGitRepo("install-preserve");
    const userHook = "#!/bin/bash\n# my own pre-commit hook\nfoo()\n";
    writeFileSync(resolve(dir, ".git", "hooks", "pre-commit"), userHook, "utf-8");
    const r = installPreCommitHook(dir);
    expect(r).toBe("preserved");
    const content = readFileSync(resolve(dir, ".git", "hooks", "pre-commit"), "utf-8");
    expect(content).toBe(userHook);  // untouched
  });

  test("returns 'no-git' when target has no .git/hooks/", () => {
    const dir = resolve(tmpDir, "no-git");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const r = installPreCommitHook(dir);
    expect(r).toBe("no-git");
  });
});

describe("uninstallPreCommitHook", () => {
  test("removes our hook when marker present", () => {
    const dir = freshGitRepo("uninstall-ours");
    installPreCommitHook(dir);
    const r = uninstallPreCommitHook(dir);
    expect(r).toBe("removed");
    expect(existsSync(resolve(dir, ".git", "hooks", "pre-commit"))).toBe(false);
  });

  test("preserves non-autopilot hook (does NOT delete user's hook)", () => {
    const dir = freshGitRepo("uninstall-preserve");
    writeFileSync(resolve(dir, ".git", "hooks", "pre-commit"), "#!/bin/bash\necho user\n", "utf-8");
    const r = uninstallPreCommitHook(dir);
    expect(r).toBe("preserved");
    expect(existsSync(resolve(dir, ".git", "hooks", "pre-commit"))).toBe(true);
  });

  test("returns 'missing' when hook file doesn't exist", () => {
    const dir = freshGitRepo("uninstall-missing");
    const r = uninstallPreCommitHook(dir);
    expect(r).toBe("missing");
  });
});
