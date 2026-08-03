#!/usr/bin/env bash
# Reproduces CI's environment locally, before you push.
#
# GitHub Actions runs this suite on a bare runner: no `pi`, `claude`, or
# `codex` on PATH, and CI/GITHUB_ACTIONS set. A test that reaches for an
# installed harness binary instead of injecting its dependency will pass on a
# developer machine and fail there — that's exactly what happened on this
# repo's first push (see ROADMAP.md, "Fase 0" progress log). This script
# rebuilds that environment so the check is cheap enough to run before every
# push, not just discovered by one.
#
# What it does:
#   - Builds a temp bin directory containing only `node`, `npm`, and `npx`,
#     symlinked from the currently running node's own bin directory.
#   - Runs `npm test` with PATH restricted to that temp directory plus the
#     standard system paths (no harness binaries reachable), and CI,
#     GITHUB_ACTIONS set to match what the runner sets.
#   - Cleans up the temp directory and exits with the suite's own exit code.
#
# Nothing here is permanent: PATH and the CI variables are set only for the
# `npm test` child process, and the temp bin directory is removed on exit
# (success, failure, or interruption) via the trap below.

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

echo "test-ci-like: PATH restricted to $TMP_BIN:/usr/bin:/bin:/usr/sbin:/sbin, CI=true GITHUB_ACTIONS=true" >&2

set +e
(
  cd "$REPO_ROOT"
  PATH="$TMP_BIN:/usr/bin:/bin:/usr/sbin:/sbin" \
    CI=true \
    GITHUB_ACTIONS=true \
    npm test
)
STATUS=$?
set -e

exit "$STATUS"
