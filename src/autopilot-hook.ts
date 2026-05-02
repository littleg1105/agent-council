/**
 * Pre-commit hook installer for the autopilot's frozen-spec defense.
 *
 * From council-20260502-205303 (Fork 1B reasoning): the implementing
 * `claude -p` subprocess must NOT be able to edit the spec to make a
 * failing test pass. SHA-pinned specs in state.json catch the cheat
 * post-hoc; the pre-commit hook catches it pre-commit so the cheat
 * never lands as a green commit.
 *
 * The hook reads `.autopilot/state.json` to find frozen spec paths and
 * rejects any commit that modifies them. It's installed at
 * `.git/hooks/pre-commit` on autopilot init (live mode only — dry-run
 * doesn't need it).
 *
 * Hooks are not committed (they live under .git/), so the autopilot
 * installs the hook on every `--live` startup (idempotent: only installs
 * if missing or different).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { resolve } from "path";

/**
 * Bash hook content. Reads .autopilot/state.json with `jq`, walks `.goals`
 * for spec_file values, and rejects the commit if any of them appear in
 * the staged diff. Falls back to a Python parser if jq isn't available
 * (Python ships with macOS by default).
 *
 * We deliberately use a portable shell script (not a Bun script) so the
 * hook works for users who don't have Bun on their PATH at commit time
 * (CI environments, deployments, etc.).
 */
const HOOK_CONTENT = `#!/usr/bin/env bash
# agent-council autopilot pre-commit hook — rejects edits to frozen specs.
# Auto-installed by \`bun run bin/autopilot --live\`. Do not edit by hand.
# Bypass with --no-verify if you genuinely need to edit a spec (sparingly!).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
STATE_FILE="$REPO_ROOT/.autopilot/state.json"

# If autopilot isn't initialized in this repo, this hook is inert.
[ -f "$STATE_FILE" ] || exit 0

# Extract frozen spec paths from state.json. Try jq first (faster); fall
# back to Python (always available on macOS, usually on Linux).
SPEC_PATHS=""
if command -v jq >/dev/null 2>&1; then
  SPEC_PATHS="$(jq -r '.goals[].spec_file' "$STATE_FILE")"
else
  SPEC_PATHS="$(python3 -c 'import json,sys; [print(g["spec_file"]) for g in json.load(open(sys.argv[1]))["goals"]]' "$STATE_FILE")"
fi

[ -z "$SPEC_PATHS" ] && exit 0

# Get staged file list (additions, modifications, renames, deletions)
STAGED="$(git diff --cached --name-only --diff-filter=ACMRD)"

VIOLATIONS=""
while IFS= read -r spec; do
  [ -z "$spec" ] && continue
  if echo "$STAGED" | grep -Fxq -- "$spec"; then
    VIOLATIONS="$VIOLATIONS  $spec\\n"
  fi
done <<< "$SPEC_PATHS"

if [ -n "$VIOLATIONS" ]; then
  printf "\\n\\033[1;31mautopilot pre-commit: REJECTED — frozen spec(s) modified:\\033[0m\\n"
  printf "$VIOLATIONS"
  printf "\\nFrozen specs are CONTRACT. The implementing subprocess must satisfy them, not\\n"
  printf "edit them. If the spec is genuinely wrong, --reset the autopilot run and rephrase\\n"
  printf "the goal. To bypass this hook intentionally: git commit --no-verify (sparingly).\\n\\n"
  exit 1
fi

exit 0
`;

/**
 * Install the pre-commit hook at .git/hooks/pre-commit. Idempotent:
 *   - if hook is missing, install it
 *   - if hook exists with our marker, replace it (we may have updated)
 *   - if hook exists WITHOUT our marker, refuse (don't trample user's hook)
 *
 * Returns:
 *   "installed" — hook was missing, now installed
 *   "updated"   — hook had our marker, replaced
 *   "preserved" — hook exists without our marker; we did not touch it
 *                  (the autopilot prints a warning so the user knows the
 *                  frozen-spec defense is degraded)
 *   "no-git"    — repo has no .git/hooks dir; cannot install
 */
export function installPreCommitHook(repoRoot: string): "installed" | "updated" | "preserved" | "no-git" {
  const hooksDir = resolve(repoRoot, ".git", "hooks");
  if (!existsSync(hooksDir)) return "no-git";
  const hookPath = resolve(hooksDir, "pre-commit");

  const MARKER = "agent-council autopilot pre-commit hook";

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (!existing.includes(MARKER)) {
      // user has their own pre-commit hook; don't trample
      return "preserved";
    }
    if (existing === HOOK_CONTENT) return "installed"; // already up-to-date
    writeFileSync(hookPath, HOOK_CONTENT, "utf-8");
    chmodSync(hookPath, 0o755);
    return "updated";
  }

  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, HOOK_CONTENT, "utf-8");
  chmodSync(hookPath, 0o755);
  return "installed";
}

/**
 * Uninstall the autopilot's hook (only if WE installed it — checks the marker
 * before removing). Used by `--reset` cleanup.
 */
export function uninstallPreCommitHook(repoRoot: string): "removed" | "preserved" | "missing" {
  const hookPath = resolve(repoRoot, ".git", "hooks", "pre-commit");
  if (!existsSync(hookPath)) return "missing";
  const existing = readFileSync(hookPath, "utf-8");
  if (!existing.includes("agent-council autopilot pre-commit hook")) return "preserved";
  const { rmSync } = require("fs");
  rmSync(hookPath);
  return "removed";
}
