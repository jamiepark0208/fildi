#!/usr/bin/env node
// Fail when research/common/asks/A<id>.md is in neither ASKS.md nor ASKS-archive.md.
// Closed rows are moved to the archive on purpose (ASKS.md header). A file in neither is invisible
// to the review loop and the Agents › Ideas cubes.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function unindexedAskFiles(fileNames, indexText, archiveText) {
  const missing = [];
  for (const name of fileNames) {
    if (!/^A\d+\.md$/.test(name)) continue;
    const link = `asks/${name}`;
    if (!indexText.includes(link) && !archiveText.includes(link)) missing.push(name);
  }
  return missing;
}

function runningAsCli() {
  const arg = process.argv[1];
  if (!arg) return false;
  return arg.endsWith("check-asks-index.mjs");
}

export function checkAsksIndex(repoRoot = root) {
  const asksDir = join(repoRoot, "research/common/asks");
  const indexText = readFileSync(join(repoRoot, "research/common/ASKS.md"), "utf8");
  const archiveText = readFileSync(join(repoRoot, "research/common/ASKS-archive.md"), "utf8");
  const fileNames = readdirSync(asksDir);
  return unindexedAskFiles(fileNames, indexText, archiveText);
}

if (runningAsCli()) {
  const missing = checkAsksIndex();
  if (missing.length) {
    console.error(`ASKS files missing from ASKS.md and ASKS-archive.md (${missing.length}):`);
    for (const name of missing) console.error(`  research/common/asks/${name}`);
    process.exit(1);
  }
  const n = readdirSync(join(root, "research/common/asks")).filter((f) => /^A\d+\.md$/.test(f)).length;
  console.log(`asks index ok (${n} files)`);
}
