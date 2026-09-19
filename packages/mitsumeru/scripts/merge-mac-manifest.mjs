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
    entries.push({ url: match[1], sha512: match[2], size: Number(match[3]) });
  }
}

if (entries.length === 0) {
  console.error(`[FAIL] manifest:merge found no entries — run notarize.sh for at least one arch first`);
  process.exit(1);
}

const primary = entries[0];
const lines = [
  `version: ${version}`,
  "files:",
  ...entries.flatMap((e) => [`  - url: ${e.url}`, `    sha512: ${e.sha512}`, `    size: ${e.size}`]),
  `path: ${primary.url}`,
  `sha512: ${primary.sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  "",
];
writeFileSync(out, lines.join("\n"));
console.log(`manifest:merge ${out} — ${entries.length} entries: ${entries.map((e) => e.url).join(", ")}`);
if (entries.length < 2) {
  console.warn("manifest:merge WARNING: fewer than two artifacts — this feed describes one architecture only");
}
