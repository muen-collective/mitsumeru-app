#!/usr/bin/env bash
# One-command release cut: build + sign + notarize + merge manifest + gates.
#
# Turns today's ~10 ordered pnpm commands into one resumable run that stops at
# the first failure and never publishes (the GitHub release stays manual).
#
#   pnpm release:cut                # whole cut, both Mac arches
#   pnpm release:cut -- --dry-run   # print the ordered plan, run nothing
#   pnpm release:cut -- --from notarize+merge   # resume from a step
#
# Signing is electron-builder's, during package:mac. Notarization uses the
# stored keychain profile; NOTARY_PROFILE defaults to asuka-notary (the name
# store:credentials writes) so notarize never trips the "stored but unnamed"
# trap it documents.
set -euo pipefail
cd "$(dirname "$0")/.."

DRY=0; FROM=""
while [ $# -gt 0 ]; do
  case "$1" in
    --)          shift ;;             # pnpm forwards this separator — ignore it
    --dry-run) DRY=1; shift ;;
    --from)    FROM="${2:-}"; shift 2 ;;
    --from=*)  FROM="${1#*=}"; shift ;;
    *) echo "[FAIL] unknown argument: $1" >&2; exit 1 ;;
  esac
done

VERSION=$(node -p "require('./package.json').version")
case "$VERSION" in
  *-dev) PROMOTE="";  LABEL="internal (-dev)" ;;
  *)     PROMOTE="1"; LABEL="promotion (latest)" ;;
esac
export NOTARY_PROFILE="${NOTARY_PROFILE:-asuka-notary}"

# name:pnpm-script, in the order the cut must run.
STEPS=(
  "label:check:label"
  "identity:check:identity"
  "typecheck:typecheck"
  "build+sign:package:mac"
  "notarize+merge:notarize:all"
  "smoke:smoke"
  "native:smoke:native"
  "surfaces:verify:surfaces"
  "mount:verify:mount"
  "release:verify:release"
  "artifacts:verify:artifacts"
  "docs:verify:docs"
)

run_step() {
  local name="$1" script="$2"
  echo
  echo "----- [$name] pnpm $script -----"
  if [ "$DRY" -eq 1 ]; then echo "  (dry-run)"; return 0; fi
  if [ "$script" = "check:label" ] && [ -n "$PROMOTE" ]; then
    PROMOTE=1 pnpm check:label
  else
    pnpm "$script"
  fi
}

echo "release:cut — Mitsumeru $VERSION  [$LABEL]"
echo "notary profile: $NOTARY_PROFILE"

# fail fast on credentials before spending a build (skipped when APPLE_ID env is used)
if [ "$DRY" -eq 0 ] && [ -z "${APPLE_ID:-}" ]; then
  if ! xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    echo "[FAIL] notary profile '$NOTARY_PROFILE' is not usable here." >&2
    echo "       run:  pnpm store:credentials" >&2
    exit 2
  fi
fi

START=0   # array indices are 0-based; 0 = run every step
if [ -n "$FROM" ]; then
  START=-1
  for i in "${!STEPS[@]}"; do
    [ "${STEPS[$i]%%:*}" = "$FROM" ] && START=$i
  done
  if [ "$START" -lt 0 ]; then
    echo "[FAIL] --from step '$FROM' is not one of: $(printf '%s ' "${STEPS[@]%%:*}")" >&2
    exit 1
  fi
fi

for i in "${!STEPS[@]}"; do
  [ "$i" -lt "$START" ] && continue
  run_step "${STEPS[$i]%%:*}" "${STEPS[$i]#*:}"
done

echo
echo "----- cut complete — $VERSION -----"
echo "artifacts in release/ ; update-feed fragments merged by notarize:all"
echo "manual next step (never automated): create the GitHub release + upload assets"
if [ -n "$PROMOTE" ]; then
  echo "promotion: confirm the 'latest' channel resolves before announcing"
fi
