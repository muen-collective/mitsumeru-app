# Mitsumeru Packaging vs DeepSeek Harness App

**Date:** 2026-09-30  
**Scope:** Capture the packaging decision for the Mitsumeru Electron app and compare it with the official DeepSeek Harness app.

## Executive decision

Mitsumeru should keep its current packaging model:

- Electron shell in the application bundle
- Published `@deepseek-ai/dsh` npm closure staged into `Resources/harness`
- A real, loose, symlink-free harness tree
- `asar: false`
- Electron itself reused as the packaged Node runtime through `ELECTRON_RUN_AS_NODE=1`
- Native dependencies staged for one target architecture at a time
- Updates delivered from the Muen GitHub release feed

The official DeepSeek Harness app uses a more compact hybrid model, but it does **not** prove that Mitsumeru should copy that layout wholesale. The two apps have different runtime constraints.

## What DeepSeek Harness ships

Measured from the official DeepSeek Harness application bundle:

| Area | Observed shape |
|---|---|
| Application code and JavaScript harness | `app.asar`, approximately 116 MB |
| Native and filesystem-sensitive dependencies | `app.asar.unpacked`, approximately 216 MB |
| Runtime and supporting tools | `runtime/`, approximately 378 MB |
| Runtime executable | A very small `bin/node` script that appears to dispatch through the Electron binary |
| Electron-as-Node usage | The app contains repeated `ELECTRON_RUN_AS_NODE` and `fork(` references |
| Native artifacts | `node-pty`, ripgrep, pako, unicode-properties, and several `.node` files are unpacked |

The important point is that DeepSeek does not put everything into `app.asar`. It archives the code that can be read through Electron's Node path shim, then unpacks the parts that need to be real filesystem paths or native files.

## What Mitsumeru ships

Mitsumeru currently stages the harness as:

```text
Contents/Resources/
  app/                 # Mitsumeru Electron shell
  harness/
    package.json
    node_modules/      # pinned, hoisted, symlink-free DSH closure
```

The relevant implementation is in:

- `packages/mitsumeru/electron-builder.yml`
- `packages/mitsumeru/scripts/prepare-harness.sh`
- `packages/mitsumeru/src/main/harness.ts`
- `packages/mitsumeru/package.json`

The packaged shell launches the harness with the following behavior:

1. Resolve the harness entry from `Resources/harness/node_modules/@deepseek-ai/dsh/lib/bin.js`.
2. Use the harness package root as the child process `cwd`.
3. Link the shipped Muen plugins into the profile directory.
4. Launch with Electron's own binary when Finder provides no usable `node` on `PATH`.
5. Set `ELECTRON_RUN_AS_NODE=1` for that fallback.
6. Pass `--expose-internals` when using Electron-as-Node because the live patch layer requires it.
7. Keep user state isolated under the Mitsumeru user-data directory.

## Why Mitsumeru currently uses `asar: false`

`asar` is a Node-level path shim, not a real filesystem. Electron can require and read files inside an archive, but the operating system cannot treat an archive path as a normal directory.

Mitsumeru has two direct filesystem constraints:

1. `spawnHarness()` passes the harness package root as the child process `cwd`.
2. The profile linker creates and resolves filesystem links from the harness tree into the user profile.

A path inside an archive fails when handed to the OS for operations such as `chdir`, `spawn` with `cwd`, or filesystem link resolution. The harness tree also contains native addons and executable files that need to remain real files.

Therefore, `asar: false` is a deliberate runtime decision, not a packaging oversight.

## Why the DeepSeek layout is not automatically better for Mitsumeru

The official app's hybrid layout reduces the visible size of `app.asar`, but it still leaves a large unpacked resource area. The decisive question is not whether the harness is in an archive. It is which paths the application hands to the kernel.

DeepSeek can archive the JavaScript harness because its launch path appears to avoid using an archive path as the process working directory. Mitsumeru currently uses the harness root as `cwd` and performs plugin linking relative to that tree. Until those contracts change, copying DeepSeek's `app.asar` layout would create a boot failure rather than a smaller build.

The official layout is still useful as a future optimization target:

```text
app.asar                  # shell and archive-safe JavaScript
app.asar.unpacked/        # native addons and real executables
Resources/harness/        # only if Mitsumeru still needs a real cwd and link root
```

But it is not a drop-in replacement for the current design.

## Second opinion

### Verdict: current Mitsumeru packaging is the safer design for this product

The current approach has four advantages over copying the official layout now:

1. **It matches the actual launch contract.** The harness has a real `cwd`, a real plugin root, and no archive-path ambiguity.
2. **It makes the dependency closure explicit.** `prepare-harness.sh` stages a pinned release and checks the resulting tree rather than allowing a fresh install to drift.
3. **It handles target architecture intentionally.** The harness is staged separately for `darwin/arm64`, `darwin/x64`, and Windows x64. This avoids shipping the host architecture's optional native dependencies into another target.
4. **It is easier to diagnose.** A missing package, broken link, missing native addon, or wrong target can be inspected directly under `Resources/harness`.

### The real costs

The tradeoffs are real:

- Larger visible application resources
- More files to sign on macOS
- Longer packaging time
- More careful handling of architecture-specific staging
- A larger update payload when the harness closure changes

Those costs are acceptable while Mitsumeru is still stabilizing its own shell, plugin composition, and update path.

## What should be borrowed from DeepSeek

Borrow the **principles**, not the exact directory layout:

- Keep archive-safe JavaScript in `app.asar` where possible.
- Keep native addons and executable files unpacked.
- Reuse Electron as the Node runtime rather than shipping an uncontrolled second Node runtime.
- Separate the application shell from runtime resources.
- Verify the packaged app, not only the source build.

## Future optimization path

Do not change packaging just to match DeepSeek. Revisit the layout only if all of the following become true:

1. The harness no longer needs an archive path as `cwd`.
2. Plugin linking no longer realpaths or mutates the archive-adjacent tree.
3. The harness entry can be resolved through an archive-safe path.
4. Native addons and executables have an explicit `asarUnpack` or equivalent resource contract.
5. Packaged Finder launches pass the same smoke, native, architecture, signing, and updater checks.
6. The resulting update size and startup behavior are measurably better.

A possible experiment would be to archive only the JavaScript closure while keeping a small unpacked runtime and plugin-link root. It should remain an experiment behind a packaging branch or build flag until the full packaged smoke suite passes.

## Verification already available

The Mitsumeru repository documents and scripts checks for:

- harness staging and closure pinning
- architecture-specific resource preparation
- Finder launch behavior
- native addon loading
- app signing and notarization
- updater feed and channel metadata
- packaged application smoke behavior

The most important validation commands are:

```bash
pnpm --filter mitsumeru typecheck
pnpm --filter mitsumeru package:dir
pnpm --filter mitsumeru smoke:finder
pnpm --filter mitsumeru smoke:native
pnpm --filter mitsumeru verify:release
```

## Final recommendation

Keep `asar: false` for the current Mitsumeru architecture. The official DeepSeek Harness app is more aggressively optimized, but its archive split is coupled to its own process and path contracts. Mitsumeru's current loose resource tree is the correct packaging choice until the harness launch and plugin-linking contracts are redesigned and proven against the packaged app.
