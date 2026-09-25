#!/usr/bin/env bash
# Azure signing preflight.
#
# Run this BEFORE starting an Artifact Signing identity validation. The
# validation takes 1 to 20 business days and cannot be edited once created: if
# the billing account's legal name or sold-to address does not match the
# government ID, the request fails or the certificate is wrong, and the fix is a
# brand new request. Microsoft's billing docs note that changing the Sold-to
# name requires a support case and a credit check.
#
# So the point of this script is to surface the billing account (its legal name,
# sold-to address and account type) while that is still cheap to correct.
#
# It reads only. It creates nothing and changes nothing.
#
#   bash scripts/preflight-signing.sh [account-name-to-check]
set -uo pipefail
cd "$(dirname "$0")/.." # packages/mitsumeru

export AZURE_CORE_COLLECT_TELEMETRY=0
fail=0
note() { printf '  %s\n' "$1"; }

echo "== azure signing preflight =="

# 1. CLI present.
if ! command -v az >/dev/null 2>&1; then
  echo "[FAIL] az is not installed. Run: brew install azure-cli" >&2
  exit 2
fi
note "cli $(az version -o tsv 2>/dev/null | cut -f1 || echo '?')"

# 2. Extension present (it carries every az artifact-signing command).
if ! az extension show --name artifact-signing >/dev/null 2>&1; then
  echo "[FAIL] the artifact-signing extension is missing. Run:" >&2
  echo "       az extension add --name artifact-signing" >&2
  exit 2
fi
note "extension artifact-signing installed"

# 3. Logged in. Unavoidably interactive, so this script cannot do it for you.
#    `az account show` is the only thing that fails cleanly when signed out.
if ! az account show >/dev/null 2>&1; then
  echo "[BLOCKED] not logged in. Run (opens a browser):" >&2
  echo "          az login" >&2
  exit 2
fi

sub_id=$(az account show --query id -o tsv 2>/dev/null)
sub_name=$(az account show --query name -o tsv 2>/dev/null)
tenant_id=$(az account show --query tenantId -o tsv 2>/dev/null)
user=$(az account show --query user.name -o tsv 2>/dev/null)

echo
echo "subscription"
note "name   $sub_name"
note "id     $sub_id"
note "tenant $tenant_id"
note "user   $user"

# 4. The provider must be registered before an account can be created.
state=$(az provider show --namespace Microsoft.CodeSigning --query registrationState -o tsv 2>/dev/null || echo "Unknown")
if [ "$state" = "Registered" ]; then
  note "provider Microsoft.CodeSigning: Registered"
else
  fail=1
  note "provider Microsoft.CodeSigning: $state"
  echo "  [TODO] az provider register --namespace Microsoft.CodeSigning" >&2
fi

# 5. The expensive one. `--expand soldTo` is what carries the legal name and
#    address that end up on the certificate. Preview command, and it needs
#    billing read access, so a failure here is reported and not fatal: the same
#    values are visible in the portal under Cost Management + Billing.
echo
echo "billing account (the certificate's legal identity)"
if billing=$(az billing account list --expand soldTo -o json 2>/dev/null) && [ "$billing" != "[]" ]; then
  printf '%s' "$billing" | node --input-type=module -e '
let raw = ""
process.stdin.on("data", (d) => (raw += d)).on("end", () => {
  let accounts
  try {
    accounts = JSON.parse(raw)
  } catch {
    console.log("  could not parse the billing account response")
    process.exit(0)
  }
  for (const a of accounts) {
    const s = a.soldTo ?? {}
    // soldTo is flat: addressLine1/city/region/country/postalCode. It is NOT
    // nested under an `address` object, which is why the first version of this
    // script printed "?".
    const where = [s.addressLine1, s.city, s.region, s.country, s.postalCode]
      .filter(Boolean).join(", ")
    const individual = a.accountType === "Individual"
    console.log(`  name         ${a.displayName ?? "?"}`)
    console.log(`  agreement    ${a.agreementType ?? "?"}`)
    // accountType is the field identity validation gates on, not agreementType.
    console.log(`  account type ${a.accountType ?? "?"}${individual ? "  <- required for individual validation" : ""}`)
    console.log(`  account id   ${a.id ?? "?"}`)
    console.log(`  legal name   ${s.companyName ?? "?"}`)
    console.log(`  person       ${[s.firstName, s.lastName].filter(Boolean).join(" ") || "?"}`)
    console.log(`  sold-to      ${where || "?"}`)
    console.log(`  email        ${s.email ?? "?"}`)
    console.log(`  status       ${a.accountStatus ?? "?"}`)
    console.log("")
    if (!individual) {
      console.log(`  [TODO] account type is "${a.accountType ?? "?"}", not Individual.`)
      console.log("         Individual identity validation requires an Individual billing account.")
    }
  }
})'
  echo "  Compare the legal name and sold-to address above with the government ID"
  echo "  that identity validation will check. They must match, and the fields are"
  echo "  read-only inside the validation form."
else
  note "not readable here (preview command, or no billing read access)"
  echo "  [TODO] verify by hand: Azure portal > Cost Management + Billing >"
  echo "         Properties > Type  (or Billing scopes > Billing account type)"
fi

# 6. Optional: is the account name free? Globally unique, and free to ask.
#    Name rules: 3 to 24 alphanumerics, starts with a letter, no double hyphens,
#    and Azure rejects names beginning with "one".
#    The CLI answers with a real boolean in JSON, and `-o tsv` renders it as
#    lowercase `false`. Compare case-insensitively, or a taken name reads as free.
if [ "${1:-}" != "" ]; then
  echo
  echo "account name \"$1\""
  available=$(az artifact-signing check-name-availability -n "$1" \
    --type "Microsoft.CodeSigning/codeSigningAccounts" \
    --query nameAvailable -o tsv 2>/dev/null || echo "?")
  note "nameAvailable: $available"
  if [ "$(printf '%s' "$available" | tr '[:upper:]' '[:lower:]')" = "false" ]; then
    fail=1
    echo "  [INFO] taken. Either it already exists (then reuse it; do not create" >&2
    echo "         a second one) or another tenant holds it (then pick another name)." >&2
  fi
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "[OK] preflight clear; safe to create the account"
else
  echo "[TODO] resolve the items above before creating the account"
fi
exit "$fail"
