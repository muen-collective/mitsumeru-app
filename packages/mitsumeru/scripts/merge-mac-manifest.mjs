#!/usr/bin/env node
/**
 * Assemble the macOS update feed from the per-arch fragments.
 *
 * Why this exists: `latest-mac.yml` is the file a client asks for, and it must
 * describe BOTH architectures' artifacts in one document. electron-builder writes
 * one manifest per build invocation, and our builds are per-arch on purpose —
 * prepare-harness.sh stages one target's native closure, and electron-builder
 * copies that single tree into whatever it builds. So there are two fragments
 * (`release/.manifest-x64.yml`, `release/.manifest-arm64.yml`) and one feed.
 *
 * The fragments themselves are the builder's own output — including the dmg
 * entries notarize.sh patched after signing and stapling, because signing a dmg
 * changes its bytes and the builder wrote its entry before that happened. This
 * script therefore MOVES text, it does not invent it: every url/sha512/size
 * triplet is copied verbatim from the fragment that produced it. Only the
 * document around them (`version`, `path`, `sha512`, `releaseDate`) is written
 * here, in the same shape and order electron-builder uses for a two-arch build
 * (x64 first, then arm64 — the order its own multi-arch output used).
 *
 * Run: pnpm manifest:merge   (after notarize.sh has run for both arches)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.version;
// The version names the channel: a `-dev` build's client asks for dev-mac.yml.
const channel = version.includes("-") ? version.split("-")[1].split(".")[0] : "latest";
const out = `release/${channel}-mac.yml`;

const ORDER = ["x64", "arm64"];
const entries = [];
for (const arch of ORDER) {
  const fragment = `release/.manifest-${arch}.yml`;
  if (!existsSync(fragment)) {
    console.warn(`manifest:merge: no fragment for ${arch} (${fragment}) — skipping`);
    continue;
  }
  const text = readFileSync(fragment, "utf8");
  // Each entry is the three-line triplet the builder writes, in order.
  const re = /^\s*-\s*url:\s*(\S+)\s*\n\s*sha512:\s*(\S+)\s*\n\s*size:\s*(\d+)\s*$/gm;
  for (const match of text.matchAll(re)) {
    entries.push({ url: match[1], sha512: match[2], size: Number(match[3]), arch });
  }
}

if (entries.length === 0) {
  console.error(`[FAIL] manifest:merge found no entries — run notarize.sh for at least one arch first`);
  process.exit(1);
}

// A fragment is left over from an EARLIER release when the other arch has not
// been rebuilt yet, and merging it blindly produces a feed that names one version
// and ships another arch's older files — measured 2026-09-24: a 0.2.3-dev feed
// listing the 0.2.2 x64 zip and dmg, which an Intel client would have downloaded
// as "0.2.3-dev". The version is in the artifact name by convention (the builder
// names files `<product>-<version>[-<arch>]`), so the fragment's own filenames are
// what identify it — and a mismatch is dropped, loudly, rather than shipped.
const wanted = `-${version}`;
const isCurrent = (url) => url.includes(wanted) || url.includes(`${version}.`) || url.includes(`${version}-`);
const stale = entries.filter((e) => !isCurrent(e.url));
if (stale.length > 0) {
  console.warn(
    `manifest:merge: DROPPING ${stale.length} stale entr${stale.length === 1 ? "y" : "ies"} from another version — ` +
      `this feed is ${version}: ${stale.map((e) => e.url).join(", ")}`
  );
  console.warn(`manifest:merge: re-run notarize for those arches to include them`);
}
const current = entries.filter((e) => isCurrent(e.url));
if (current.length === 0) {
  console.error(`[FAIL] manifest:merge found no entries for ${version} — every fragment is from an older build`);
  process.exit(1);
}

const primary = current[0];
const lines = [
  `version: ${version}`,
  "files:",
  ...current.flatMap((e) => [`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`]),
  `path: ${primary.url}`,
  `sha512: ${primary.sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  "",
];
writeFileSync(out, lines.join("\n"));
console.log(`manifest:merge ${out} — ${current.length} entries: ${current.map((e) => e.url).join(", ")}`);
if (current.length < 2) {
  console.warn("manifest:merge WARNING: fewer than two artifacts — this feed describes one architecture only");
}
