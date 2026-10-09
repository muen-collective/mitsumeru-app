#!/usr/bin/env bash
# Easy version bump — the ONE place the version lives (package.json), plus the
# harness re-pin and the release-notes scaffold. It never builds, signs or
# publishes; pnpm release:cut does that.
#
#   pnpm bump 0.2.6-dev                            # internal build
#   pnpm bump 0.3.0                                # promote: drop -dev
#   pnpm bump 0.2.6-dev --with-harness 0.2.0-rc.2  # also re-pin the harness
#
# The harness version is data, not code (AGENTS.md): a re-pin needs no shell
# edit beyond this dep line. After --with-harness you must `pnpm install` and
# retarget the supply-chain age-gate exception list (see a prior bump's release
# notes) before the harness will stage.
set -euo pipefail
cd "$(dirname "$0")/.."

NEW="${1:-}"
shift 2>/dev/null || true
WITH_HARNESS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --with-harness)   WITH_HARNESS="${2:-}"; shift 2 ;;
    --with-harness=*) WITH_HARNESS="${1#*=}"; shift ;;
    *) echo "[FAIL] unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$NEW" ]; then
  echo "usage: pnpm bump <x.y.z[-dev]> [--with-harness <dsh-version>]" >&2
  exit 1
fi

# 1. the label rule, identical to check-version-label.sh, so a bad bump cannot pass.
if ! printf '%s' "$NEW" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-dev)?$'; then
  echo "[FAIL] '$NEW' is not 0.x.y or 0.x.y-dev" >&2
  exit 1
fi

CUR=$(node -p "require('./package.json').version")
echo "bump: version $CUR -> $NEW"

# 2. precise, format-preserving edits — targeted text replaces, not a JSON re-dump.
node - "$NEW" "$WITH_HARNESS" <<'NODE'
const fs = require('fs');
const next = process.argv[2];
const harness = process.argv[3];
let t = fs.readFileSync('package.json', 'utf8');
const before = t;
t = t.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
if (harness) {
  if (!/"@deepseek-ai\/dsh"\s*:\s*"[^"]+"/.test(t)) {
    console.error('[FAIL] @deepseek-ai/dsh dep line not found'); process.exit(1);
  }
  t = t.replace(/("@deepseek-ai\/dsh"\s*:\s*")[^"]+(")/, `$1${harness}$2`);
}
if (t === before) { console.error('[FAIL] nothing changed — check package.json'); process.exit(1); }
fs.writeFileSync('package.json', t);
console.log('bump: package.json updated');
NODE

# 3. scaffold release notes if absent (the -dev label rule baked in).
NOTES="release-notes/v${NEW}.md"
if [ ! -f "$NOTES" ]; then
  if printf '%s' "$NEW" | grep -q -- '-dev$'; then
    LABEL="Internal build — carries the \`-dev\` suffix; the update channel is \`dev\`."
  else
    LABEL="Promoted release — no \`-dev\` suffix; this takes the \`latest\` channel."
  fi
  cat > "$NOTES" <<EOF
# Mitsumeru $NEW

$LABEL

Wraps DeepSeek Harness <version> (from <previous>).

## What changed

-

## Gates

-

## Install

-
EOF
  echo "bump: scaffolded $NOTES"
else
  echo "bump: $NOTES already exists — left untouched"
fi

echo
echo "next steps:"
if [ -n "$WITH_HARNESS" ]; then
  echo "  1. pnpm install                              # fetch @deepseek-ai/dsh@$WITH_HARNESS"
  echo "  2. retarget the supply-chain age-gate exception list (see a prior bump's notes)"
fi
echo "  fill in release-notes/v${NEW}.md"
echo "  pnpm release:cut                             # build + sign + notarize + gates"
