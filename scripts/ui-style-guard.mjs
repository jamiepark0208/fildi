#!/usr/bin/env node
/**
 * A305 — UI style drift guard for stock-compare.
 *
 * Hard-fail (exit 1) on:
 *   - import of deleted `@/components/ui/tab-bar`
 *   - new `font-family:` outside index.css / font token files
 *   - Google Fonts CDN `@import` in src CSS
 *
 * Soft-warn (exit 0, printed) on legacy washed text classes until Phase 2 codemod:
 *   text-zinc-400/500, text-gray-400/500, text-white/40–70, text-muted-foreground, text-foreground/60
 *
 * Prove P7: touch a new file with `from "@/components/ui/tab-bar"` → must fail.
 *
 *   node scripts/ui-style-guard.mjs
 *   node scripts/ui-style-guard.mjs --strict   # also fail on soft bans in migrated paths
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SRC = join(ROOT, "artifacts/stock-compare/src");
const STRICT = process.argv.includes("--strict");

const HARD = [
  { re: /@\/components\/ui\/tab-bar|components\/ui\/tab-bar/, msg: "dead tab-bar import (use @/lib/sub-tabs)" },
  { re: /fonts\.googleapis\.com/, msg: "Google Fonts CDN — use @fontsource self-host" },
];

const SOFT = [
  /text-zinc-400\b/,
  /text-zinc-500\b/,
  /text-gray-400\b/,
  /text-gray-500\b/,
  /text-white\/(40|50|60|70)\b/,
  /text-muted-foreground\b/,
  /text-foreground\/60\b/,
];

/** Paths already on the Live/sub-tabs system — soft bans become hard under --strict */
const MIGRATED = [
  "lib/sub-tabs.ts",
  "components/ui/tabs.tsx",
  "pages/live.tsx",
  "pages/rankings.tsx",
  "pages/macro.tsx",
  "pages/settings.tsx",
  "pages/scorecard-explanation.tsx",
  "components/lseg-street-panel.tsx",
  "components/wrds-street-panel.tsx",
  "components/settings/AgentsTab.tsx",
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
let hard = 0;
let soft = 0;
const softHits = new Map();

for (const file of files) {
  const rel = relative(SRC, file);
  const text = readFileSync(file, "utf8");
  for (const { re, msg } of HARD) {
    if (re.test(text)) {
      console.error(`FAIL ${rel}: ${msg}`);
      hard++;
    }
  }
  // font-family only allowed in index.css (and @fontsource packages live in node_modules)
  if (/font-family\s*:/.test(text) && !rel.endsWith("index.css") && !rel.includes("fonts")) {
    console.error(`FAIL ${rel}: font-family outside index.css`);
    hard++;
  }
  for (const re of SOFT) {
    const m = text.match(new RegExp(re.source, "g"));
    if (!m) continue;
    soft += m.length;
    softHits.set(re.source, (softHits.get(re.source) || 0) + m.length);
    if (STRICT && MIGRATED.some((m) => rel === m || rel.endsWith(m))) {
      console.error(`FAIL ${rel}: soft-ban under --strict (${re.source} ×${m.length})`);
      hard++;
    }
  }
}

console.log(`ui-style-guard: scanned ${files.length} files · hard=${hard} · soft hits=${soft}`);
if (softHits.size) {
  console.log("soft (Phase 2 codemod):");
  for (const [k, v] of [...softHits.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}\t${k}`);
  }
}

// P7 self-check: ensure tab-bar.tsx is gone
try {
  statSync(join(SRC, "components/ui/tab-bar.tsx"));
  console.error("FAIL components/ui/tab-bar.tsx still exists — delete it");
  hard++;
} catch {
  /* expected missing */
}

if (hard > 0) {
  console.error(`ui-style-guard: FAILED (${hard})`);
  process.exit(1);
}
console.log("ui-style-guard: ok");
