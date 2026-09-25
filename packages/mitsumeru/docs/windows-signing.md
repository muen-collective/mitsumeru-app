# Signing the Windows build - Azure Artifact Signing

The `.exe` ships unsigned today: 0.2.2's notes say so, and on first run a user gets
**"Windows protected your PC"** → *More info* → *Run anyway*. This is the opt-in
path to a real Authenticode signature.

## First: do you actually need this?

**No, not to install on your own Windows machine.** Verified 2026-09-24:

- `v0.2.2` already publishes a working unsigned installer
  (`Mitsumeru-Setup-0.2.2.exe`, 244 MB, downloadable now) and the local build tree
  also has one. Nothing in `package:win:x64` requires a certificate, and no gate
  blocks an unsigned Windows build.
- **Unsigned auto-update works.** `NsisUpdater.verifySignature` returns `null`
  (skips verification) when `app-update.yml` has no `publisherName`. The packaged
  Windows app's `app-update.yml` has no `publisherName` key at all, so the update
  path is not blocked. Verified by reading the installed updater's source and the
  bytes of the packaged `app-update.yml`, not assumed.
- Each user sees **"Windows protected your PC"** once, then *More info → Run
  anyway*. On your own machine that is one extra click, forever.

Signing buys exactly three things: **no SmartScreen prompt on other people's
machines**, a publisher name on the UAC dialog, and accumulated reputation. If the
only install target is your own box, skip it and stop here.

The rest of this document is the signed path, for when Mitsumeru ships to people
who are not you.

> **Naming:** Microsoft renamed **Trusted Signing → Artifact Signing** (docs now live
> at `learn.microsoft.com/azure/artifact-signing/`). The old `trusted-signing` URLs
> redirect, and electron-builder's option is still called `azureSignOptions`, so
> old guides and the option name disagree with the current service name. That is
> expected, not a version problem.

## What it costs

From Azure's own retail price API (queried 2026-09-24), not from a blog post:

| SKU | Price | Meter |
|---|---|---|
| **Basic** | **$9.99 / month** | Basic Account |
| Premium | $99.99 / month | Premium Account |
| Basic signature | $0.00 | included |
| Signature overage | $0.005 each | per-unit beyond the plan |

Basic is the tier for one publisher signing its own installers. Premium buys
higher throughput and CI volume, which this repo does not need. (The docs do not
state the included signature count in a place I could cite, so check the portal's
cost estimate at the pricing step rather than trusting a number from memory.)

**Before paying:** 0.2.2's notes record that **EV certificates stopped bypassing
SmartScreen in 2024**. Any valid signature helps because reputation accumulates
against a consistent publisher identity and carries across releases, but do not
pay an EV premium expecting to skip SmartScreen.

## Before you start

- An **Azure subscription** and a **Microsoft Entra tenant**.
- **Pay-As-You-Go, not a free account.** The free trial gives $200 for 30 days, then
  drops to free-tier services only until 12 months; Artifact Signing is not a free
  service. Pay-As-You-Go is a normal subscription that can bill this, and it is the
  cheapest correct choice. You do not need Premium, an EA, an MCA, or support plan.
  (Verified: nothing in the Artifact Signing docs restricts subscription offer type.)
- Eligibility for **Public Trust** (this is a geographic restriction, from the
  quickstart):
  - **Individual developer:** must be located in the **United States or Canada**.
  - **Organization:** US, Canada, EU, UK, Australia, NZ, Japan, South Korea,
    Singapore, Switzerland, Norway, or Israel.
- Your identity details must match real documents; see the accuracy warning below.

## Step 0 - install and check the CLI

```bash
brew install azure-cli        # done on this machine: 2.90.0
az extension add --name artifact-signing
```

> **Preview status.** The extension reports itself as `Preview: True` and every
> command group prints *"in preview and under development"* (`aka.ms/CLI_refstatus`).
> The portal path is the supported one; the CLI is convenient but is a moving target.
> Azure CLI 2.90.0 + extension `artifact-signing` 1.0.0 were installed and the
> flags below were verified against `az ... -h` on 2026-09-24.

> **Do not copy Microsoft's CLI example verbatim.** The quickstart's profile command
> uses `--include-street`; the extension's actual parameter is
> `--include-street-address` (alias `--street`). Trust `az <cmd> -h`.

## Step 1 - register the resource provider

```bash
az login
az account set -s "<subscription id>"
az provider register --namespace "Microsoft.CodeSigning"
az provider show --namespace "Microsoft.CodeSigning"      # verify
```

## Step 2 - create the account

**Created and then deleted on 2026-09-24.** Nothing in Azure remains: the signing
account, the resource group and the identity validation are all gone (verified with
`az artifact-signing list` -> `0` and `az group list` -> `0`). Signing was deferred
because the only install target was our own Windows machine, and the unsigned
installer works there (see "First: do you actually need this?" above).

What to recreate when signing is actually needed, so the choices do not have to be
re-derived:

| Setting | Value |
|---|---|
| Resource group | `mitsumeru-signing` (eastus) |
| Account name | `mitsumeru-signing` (SKU `Basic`, $9.99/mo) |
| **Endpoint** | **`https://eus.codesigning.azure.net/`** |
| Billing account type | `Individual` (agreement `MicrosoftCustomerAgreement`) |

Both names were free when released, so they are reusable but not reserved. The
billing account type was the real prerequisite and it does not change: it is an
`Individual` account on this subscription, which is what individual identity
validation requires.

This file is in a **public** repository, so the subscription id, tenant id, legal
name and address are deliberately not recorded here. Run
`pnpm check:signing <account-name>` to print them locally when you need them.

The account name is a container only. It does **not** appear on the certificate;
the certificate's identity comes from the billing account's sold-to. That is why
the account name is free to be dull, but the billing account details are not.

Pick a region from the supported list; the region decides your endpoint, which
goes into the build config later. East US was chosen because it is the closest
supported region and yields `eus`.

| Region | Endpoint |
|---|---|
| East US | `https://eus.codesigning.azure.net` |
| West US 2 | `https://wus2.codesigning.azure.net` |
| West US 3 | `https://wus3.codesigning.azure.net` |
| Central US / North Central US / South Central US / West Central US | `cus` / `ncus` / `scus` / `wcus` |
| West Europe / North Europe | `weu` / `neu` |
| Switzerland North | `https://swn.codesigning.azure.net` |
| Japan East / Korea Central | `jpe` / `krc` |
| Brazil South / Poland Central | `brs` / `plc` |

```bash
# what was run, in order
az group create --name mitsumeru-signing --location eastus
az artifact-signing check-name-availability -n mitsumeru-signing \
  --type "Microsoft.CodeSigning/codeSigningAccounts"
az artifact-signing create -n mitsumeru-signing -l eastus \
  -g mitsumeru-signing --sku Basic
```

Provider registration is not instant: `az provider register` returns while the
state is still `Registering`. Poll it before creating the account, or the create
fails:

```bash
az provider show --namespace Microsoft.CodeSigning --query registrationState -o tsv
# repeat until it prints: Registered   (took about 50s here)
```

`--sku` accepts `Basic` or `Premium`. `--location` is optional (defaults to the
resource group's). Run `pnpm check:signing <account-name>` first: it verifies the
provider is registered and the name is free before the create call.

**Account name rules:** 3–24 alphanumeric characters, globally unique, must start
with a letter, end with a letter or number, no consecutive hyphens, and Azure
rejects names starting with `one`.

## Step 3 - identity validation (the slow step: 1–20 business days)

This is the gate. It is a real identity check, not a form.

**Portal only.** The CLI has no identity-validation command (`az artifact-signing`
exposes only `check-name-availability`, `create`, `delete`, `list`, `show`,
`update`, `wait`, plus the `certificate-profile` subgroup). Steps 1, 2 and 4 have
CLI paths; this step does not. Do it in the browser.

### First: run the preflight

```bash
pnpm check:signing <account-name>      # e.g. pnpm check:signing mitsumeru-signing
```

`scripts/preflight-signing.sh` reads only; it creates nothing. It reports the CLI
and extension state, the active subscription, whether the `Microsoft.CodeSigning`
provider is registered, the billing account (name, account type, legal name,
sold-to address), and whether the account name you passed is still free. It stops
with `[BLOCKED]` before doing anything useful when you are not logged in, because
`az login` needs a browser and has to be yours.

### Where the two later values come from

They are different in kind, which is easy to trip over:

- **Certificate profile name: you invent it.** It does not exist until step 4
  creates it, so there is nothing to look up. Rules: 5 to 100 alphanumeric
  characters, must start with a letter and end with a letter or number, no
  consecutive hyphens, unique within the account. Something like
  `mitsumeru-public-trust` or `mitsumeru-release`.
- **Identity validation Id: you find it.** It is minted by the portal during
  step 3, after the identity check completes. Nothing has it before then, and no
  CLI command exposes it (see below). It is a GUID that step 4 passes to
  `--identity-validation-id`.

**The Identity validation Id is portal-only.** Verified on 2026-09-24 against this
subscription: `az artifact-signing` has no `identity-validation` command, and
`identityValidations` is not a readable ARM resource type under `Microsoft.CodeSigning`
(REST returns `InvalidResourceType` / `ResourceTypeRegistrationNotFound`).
`certificateProfiles` *is* readable, which is why only this one value cannot be
fetched from the CLI.

Find it at: your signing account -> **Identity validations** -> click the entity
(or the row's name) -> the **Identity validation Id** field, with a copy control.
It is also visible in the identity validation list before you click in.

### Then: read the billing account yourself

The subscription's **billing account must have an Account Type of `Individual`** for
individual validation. This is the single most expensive detail to get wrong.

**Check it in the portal:** search **Cost Management + Billing** →
**Properties** (or **Billing scopes** if you have several) → read **Type** / the
**Billing account type** column. The type is one of Microsoft Online Subscription
Program, Enterprise Agreement, Microsoft Customer Agreement, or Microsoft Partner
Agreement.

`az billing account list --expand soldTo` prints the same legal name, address and
agreement type from the CLI, and the preflight runs it for you. Treat it as a
convenience, not the authority: it is a preview command and needs billing read
access, so the portal is what you trust if the two disagree.

The legal name and **sold-to address** on that billing account appear on the
certificate and must match your government ID. To change them you edit the billing
account *before* submitting, and per Microsoft's own billing docs, **a change to
the Sold-to name requires contacting support and a credit check**. Confirm both
before you start the clock on a 1–20 business day validation.

1. In the portal, open the account → **Identity validations** → **New Identity**.
2. Choose **Public**, and choose **Individual** or **Organization**.
3. **Individual:** pick the billing account in the dropdown; the name, address and
   email are then read from it and are **read-only**. Review the quickstart's table
   before submitting; the exact legal name and sold-to address on the billing
   account must match your government ID, and **you cannot edit them in this form**;
   you change the billing account before submitting, or you must start a **new**
   request afterwards.
4. **Organization:** you also supply website URL, a monitored **primary** email on
   the entity's own domain, a different **secondary** email on a matching domain,
   a business identifier, and the name of the person representing the entity.

Then the verification itself:

1. Status goes **In Progress** → **Action Required**.
2. Open the link and complete verification with a trusted ID verifier (AU10TIX).
   It is a phone flow: email PIN → phone number → QR code → ID photos → Microsoft
   Authenticator. Have the phone and the ID ready.
3. Status → **Completed** (a few minutes after the phone flow).

**Accuracy warning, from the docs:** if you need any change after the request is
created, you must complete a **new** identity validation request, and that affects
the certificates already in use. Get it right the first time.

**Photo requirements**, if you submit documents: government-issued photo ID
(passport, driver's licence, state ID); no library/school/club cards; colour,
no flash, no direct sunlight, flat surface, shot from directly above, margins
intact, nothing covering it, ≥200 DPI (400+ preferred), 600×370 px minimum,
30 KB–5 MB, `.bmp .jpg .gif .tif .pdf`, one side per file, no editing.

## Step 4 - create the certificate profile

Profile names: 5–100 alphanumeric, start with a letter, end with a letter or
number, no consecutive hyphens, unique within the account.

```bash
az artifact-signing certificate-profile create \
  -g mitsumeru-signing --account-name mitsumeru-signing \
  -n <profile-name> --profile-type PublicTrust \
  --identity-validation-id <identity-validation-id>

az artifact-signing certificate-profile show \
  -g mitsumeru-signing --account-name mitsumeru-signing -n <profile-name>
```

`--profile-type` accepts `PublicTrust`, `PublicTrustTest`, `PrivateTrust`,
`PrivateTrustCIPolicy`, `VBSEnclave`. **`PublicTrust` is the one that produces a
real Authenticode signature**: `PublicTrustTest` issues non-trusted certs for
testing the pipeline without identity validation.

Copy the **Identity validation Id** from the portal (account → Identity validations
→ your entity). This is the one value Step 4 needs that only the portal has. The
profile name in the same command is one you choose, not one you find.

## Step 5 - grant the signer role

Assign **Artifact Signing Certificate Profile Signer** to whoever or whatever signs:
your user account for local signing, or the service principal / managed identity for
CI.

## Step 6 - credentials for signing

Nothing in the CLI is run yet: `az login` has **not** been done on this machine, so
`az account show` currently errors with `Please run 'az login'`. That is expected
and is the first command in step 1.

electron-builder authenticates with Azure's `EnvironmentCredential`, which reads
standard variables:

```bash
export AZURE_TENANT_ID="<entra tenant id>"
export AZURE_CLIENT_ID="<app registration client id>"
export AZURE_CLIENT_SECRET="<client secret>"
```

Create a service principal and grant it the signer role on the account. For local
signing only, `az login` + the Azure CLI credential can be enough (the signer tries
several sources in order), but the environment triple is what makes a CI run
reproducible.

**Never commit these.** The repo's macOS notary credentials already live in the
login keychain rather than the repo; keep the same rule here.

## Step 7 - signing from this Mac

**This is the part that decides your workflow, and the repo's tooling does not
support it today.** From `app-builder-lib@26.15.3`:

- `windowsSignAzureManager.js` shells out to `Invoke-TrustedSigning` through a
  PowerShell "vm" (`PwshVm`), installing the `TrustedSigning` PowerShell module at
  signing time.
- `vm.js` → `getWindowsVm()` only returns `PwshVmManager` when **`pwsh` AND `wine`
  are both available**. Otherwise it throws `Cannot find suitable Parallels Desktop
  virtual machine … and cannot access pwsh and wine locally`.
- Neither is installed on this machine: `pwsh` **absent**, `wine` **absent**.
  (`brew info powershell` shows 7.6.6 available, so `pwsh` is a `brew install` away;
  `wine` is a much heavier dependency and the combination is untested here.)

So there are two honest routes:

| Route | What it needs | Trade-off |
|---|---|---|
| **Sign on Windows** | A Windows machine or CI runner (GitHub Actions `windows-latest`) | The supported path; `Invoke-TrustedSigning` and the module install are native. Matches "Windows is signed by Windows". |
| **Sign on this Mac** | `brew install powershell` **and** a working `wine` | Requires proof; I have not run it. Treat as an experiment, not a plan. |

Also still true from 0.2.2: `prepare-harness.sh` stages **one** target's native
closure and electron-builder copies that tree into whatever it builds, which is why
the build is per-target (`--os win32 --cpu x64`). A Windows signing run has to stage
the win32 closure, not reuse the macOS one.

## Step 8 - the build config

Once credentials and the Windows rig exist, `electron-builder.yml` gains a `win`
block (values from steps 2 and 4):

```yaml
win:
  azureSignOptions:
    publisherName: <the CN exactly as it will appear on the certificate>
    endpoint: https://eus.codesigning.azure.net
    certificateProfileName: <profile-name>
    codeSigningAccountName: <account-name>
```

`publisherName` must match the certificate's subject exactly, because it is also
what `verifyUpdateCodeSignature` checks against for updates.

## Verification, once it is set up

There is no gate for this today: `verify:artifacts` asserts architecture and
native addons, and `verify:release` covers only the macOS artifacts. The check that
proves a Windows signature is:

```bash
# on Windows
signtool verify /pa /v "Mitsumeru Setup 0.2.3-dev.exe"
```

Worth adding to the release gates when this lands, next to the macOS Gatekeeper
assertions, next to the macOS Gatekeeper assertions. A signature nobody asserts is
a signature that can silently stop applying.

## Sources

- Quickstart (setup steps, regions, naming, identity validation):
  `articles/artifact-signing/quickstart.md` in `MicrosoftDocs/azure-docs`
- Signing integrations (roles, auth, `Invoke-TrustedSigning`):
  `articles/artifact-signing/how-to-signing-integrations.md`
- Pricing: Azure retail prices API, `serviceName` contains `Signing`
- Tooling behaviour: `app-builder-lib@26.15.3`, `out/codeSign/windowsSignAzureManager.js`,
  `out/vm/vm.js`, `out/vm/PwshVm.js`, `out/options/winOptions.d.ts`
