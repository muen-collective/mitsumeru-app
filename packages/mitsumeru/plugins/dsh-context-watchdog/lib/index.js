/**
 * Host half — deliberately empty.
 *
 * The reminder is a Client surface and the number it reads is already on the
 * Client (`contextPressure` is a projection the host's own ContextMeter reads),
 * so there is nothing for the Host to do beyond carrying the row that mounts
 * the bundle. Kept as a real export rather than dropped so the package keeps the
 * shape `dsh.bundle.patch` expects and a future Host-side setting has a home.
 */
export function apply() {}
