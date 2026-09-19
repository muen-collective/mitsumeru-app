#!/usr/bin/env bash
# Docs-truth gate (the Mitsu docs ↔ this shell).
#
# The docs describe *this* shell: the pinned harness version, the shipped plugin
# set, the paths and the packaging decisions. They drift, and a drifting doc is
# worse than no doc — an agent reads it and states a wrong fact with confidence.
# This gate runs the docs repo's own checker, which reads the real values from
# here and fails when a doc disagrees, naming the file and the line.
#
# The docs repo is a separate checkout on an external drive. A missing checkout
# is a FAILURE, never a skip: a gate that passes when the thing it checks is
# absent is worse than no gate (0.2.0 shipped without its fixes precisely because
# nothing read the artifact). Point elsewhere with MITSUMERU_DOCS_REPO.
#
#   pnpm verify:docs
set -uo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

DOCS_REPO="${MITSUMERU_DOCS_REPO:-/Volumes/External SSD/mitsu}"
CHECKER="$DOCS_REPO/scripts/check-docs-truth.mjs"

if [ ! -f "$CHECKER" ]; then
  echo "[FAIL] docs repo not found at: $DOCS_REPO"
  echo "       expected: $CHECKER"
  echo "       mount the drive, or set MITSUMERU_DOCS_REPO=<path to the mitsu repo>"
  exit 2
fi

MITSUMERU_SHELL="$PWD" node "$CHECKER"
status=$?

if [ "$status" -eq 0 ]; then
  echo "[PASS] docs agree with this shell"
else
  echo "[FAIL] the docs disagree with this shell — fix the docs, not this gate"
  echo "       procedure: skills/docs-truth/SKILL.md in the docs repo"
fi
exit "$status"
