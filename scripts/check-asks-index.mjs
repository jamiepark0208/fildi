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

// Report collisions without choosing which agent's work to keep.
export function askIndexProblems(fileNames, indexText, archiveText) {
  const files = new Set(fileNames);
  const seen = new Map();
  const problems = [];
  for (const [source, text] of [["ASKS.md", indexText], ["ASKS-archive.md", archiveText]]) {
    for (const [offset, line] of text.split("\n").entries()) {
      const match = line.match(/^\s*\|\s*\[(A\d+)\]\(([^)]+)\)\s*\|/);
      if (!match) continue;
      const [, id, target] = match;
      const normalized = target.replace(/^\.\//, "");
      const file = normalized.startsWith("asks/") ? normalized.slice(5) : null;
      const location = `${source}:${offset + 1}`;
      if (!file || !/^A\d+\.md$/.test(file)) problems.push(`${location}: invalid task target ${target}`);
      else {
        if (file !== `${id}.md`) problems.push(`${location}: ${id} links to ${file}`);
        if (!files.has(file)) problems.push(`${location}: missing asks/${file}`);
      }
      if (seen.has(id)) problems.push(`${location}: duplicate ${id}; first at ${seen.get(id)}`);
      else seen.set(id, location);
    }
  }
  return problems;
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
  const fileNames = readdirSync(join(root, "research/common/asks"));
  const problems = askIndexProblems(fileNames,
    readFileSync(join(root, "research/common/ASKS.md"), "utf8"),
    readFileSync(join(root, "research/common/ASKS-archive.md"), "utf8"));
  if (missing.length || problems.length) {
    if (missing.length) {
      console.error(`ASKS files missing from ASKS.md and ASKS-archive.md (${missing.length}):`);
      for (const name of missing) console.error(`  research/common/asks/${name}`);
    }
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  const n = readdirSync(join(root, "research/common/asks")).filter((f) => /^A\d+\.md$/.test(f)).length;
  console.log(`asks index ok (${n} files)`);
}
