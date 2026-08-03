#!/usr/bin/env bash
# Reproduces CI's environment locally, before you push.
#
# GitHub Actions runs this suite on a bare runner: no `pi`, `claude`, or
# `codex` on PATH, and CI/GITHUB_ACTIONS set. A test that reaches for an
# installed harness binary instead of injecting its dependency will pass on a
# developer machine and fail there — that's exactly what happened on this
# repo's first push (see ROADMAP.md, "CI roja en el primer push a
# `origin/main`"). This script rebuilds that environment so the check is
# cheap enough to run before every push, not just discovered by one.
#
# What it does:
#   - Builds a temp bin directory containing only `node`, `npm`, and `npx`,
#     symlinked from the currently running node's own bin directory.
#   - Runs the same test suite as `npm test` (`node --test test/*.test.js`),
#     with PATH restricted to that temp directory plus the standard system
#     paths (no harness binaries reachable), CI/GITHUB_ACTIONS set to match
#     what the runner sets, and the project's own WORKFLOW_*/harness env
#     vars cleared (see below) so a developer's shell profile can't leak
#     state CI would never have.
#   - Verifies the harness binaries actually became unreachable before
#     running anything, so a PATH surprise (e.g. one of them also lives
#     under the restricted system paths) is a loud failure, not a silent
#     non-reproduction.
#   - Cleans up the temp directory and exits with the suite's own exit code.
#
# Nothing here is permanent: PATH, the CI variables, and the unset vars below
# apply only to the test child process, and the temp bin directory is
# removed on exit (success, failure, or interruption) via the trap below.
#
# Extra arguments (e.g. `npm run test:ci-like -- --test-name-pattern=x`) are
# forwarded to the test run (see the comment further down for why that goes
# through `node --test` directly rather than `npm test -- "$@"`).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

NODE_BIN="$(command -v node)" || {
  echo "test-ci-like: no 'node' found on PATH" >&2
  exit 1
}
NODE_BIN_DIR="$(dirname "$NODE_BIN")"

TMP_BIN="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_BIN"
}
trap cleanup EXIT

for tool in node npm npx; do
  if [ -e "$NODE_BIN_DIR/$tool" ]; then
    ln -s "$NODE_BIN_DIR/$tool" "$TMP_BIN/$tool"
  fi
done

# Assumes the standard Ubuntu/macOS/WSL split between /usr/bin, /bin,
# /usr/sbin, and /sbin for core system utilities. Breaks on Nix-style
# layouts (e.g. NixOS, a Nix-managed $PATH) where those paths don't hold the
# usual tools -- not handled here, deliberately: this repo's CI and dev
# machines are Ubuntu/macOS/WSL, and generalizing further isn't worth the
# complexity until that changes.
RESTRICTED_PATH="$TMP_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

# The whole point of this script is that harness binaries are unreachable.
# Verify that before running anything: a false negative here (one of these
# also resolving from inside the restricted system paths) would otherwise
# make the reproduction silently not reproduce CI at all.
for harness in pi claude codex herdr; do
  if found="$(PATH="$RESTRICTED_PATH" command -v "$harness" 2>/dev/null)"; then
    echo "test-ci-like: '$harness' is still reachable on the restricted PATH ($found) -- CI has no harness binaries on PATH, so this would not reproduce CI. Refusing to run." >&2
    exit 1
  fi
done

echo "test-ci-like: PATH restricted to $RESTRICTED_PATH, CI=true GITHUB_ACTIONS=true" >&2

set +e
(
  cd "$REPO_ROOT"
  # Clear the project's own env surface so the reproduction inherits as
  # little of the developer's shell as PATH allows it to inherit little of
  # the developer's PATH. Every var below is one this repo's own source
  # reads via `env.<NAME>` or `process.env.<NAME>` (grepped, not guessed):
  # WORKFLOW_STATE_ROOT (bin/workflow.js), WORKFLOW_PROJECTS_FILE
  # (src/workflow/runtime-config.js), WORKFLOW_HANDOFF_NOTIFIER
  # (src/workflow/notifier.js), WORKFLOW_RUN_ID/WORKFLOW_RUN_DIR/
  # WORKFLOW_HARNESS (hooks/lib/lifecycle-hook-core.mjs and the .pi/
  # extensions), WORKFLOW_DELEGATION_ID/WORKFLOW_DELEGATION_GENERATION/
  # WORKFLOW_DELEGATION_CLAIM_TOKEN (src/workflow/commands.js),
  # WORKFLOW_SMOKE_TEST_TTY (scripts/smoke-workflow-fixture.js), and
  # CODEX_HOME (src/workflow/launch.js). A developer with any of these
  # exported gets failures CI would never produce -- WORKFLOW_STATE_ROOT
  # alone is a measured example, see ROADMAP.md, "CI roja en el primer
  # push a `origin/main`".
  unset WORKFLOW_STATE_ROOT WORKFLOW_PROJECTS_FILE WORKFLOW_HANDOFF_NOTIFIER \
    WORKFLOW_RUN_ID WORKFLOW_RUN_DIR WORKFLOW_HARNESS WORKFLOW_DELEGATION_ID \
    WORKFLOW_DELEGATION_GENERATION WORKFLOW_DELEGATION_CLAIM_TOKEN \
    WORKFLOW_SMOKE_TEST_TTY CODEX_HOME
  # Runs the same command as the "test" script in package.json, but does not go
  # through `npm test -- "$@"`: npm always appends forwarded args after the
  # script's own arguments, landing them after the `test/*.test.js` glob --
  # and node's own --test-name-pattern (and similar) flags are only honored
  # before the file arguments, silently ignored after. Passing "$@" before the
  # glob here is what makes forwarding actually filter, not just appear to.
  PATH="$RESTRICTED_PATH" \
    CI=true \
    GITHUB_ACTIONS=true \
    node --test "$@" test/*.test.js
)
STATUS=$?
set -e

exit "$STATUS"
