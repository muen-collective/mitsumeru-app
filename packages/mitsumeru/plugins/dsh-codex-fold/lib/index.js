/**
 * Host half — deliberately empty.
 *
 * Upstream registered a Host settings namespace for its `statusText` option and
 * imported `@deepseek-ai/schemastery` to declare the schema. That import cannot
 * resolve from a workspace-linked bundle: Node resolves bare specifiers by
 * walking up from the package's *real* path, and the profile's node_modules
 * carries no `@deepseek-ai/*` packages at all — so the row failed to mount and
 * the whole plugin was inert. The same wall is already recorded for
 * `@muen/dsh-white-label` in the release-loop skill.
 *
 * Dropping the registration costs only the "Status text" settings card. The
 * Client half tolerates its absence by construction: `statusTextProvider(undefined)`
 * falls back to the built-in `Deep sleeping...`, and the card setup returns early
 * when the `settingsScope` service is absent — the fold observer is a separate
 * effect and is unaffected. Folding, which is the point of this plugin, needs
 * nothing from the Host.
 *
 * If the setting is wanted later, the honest route is to vendor schemastery into
 * this package rather than to import a peer the profile cannot resolve.
 */
export function apply() {}
