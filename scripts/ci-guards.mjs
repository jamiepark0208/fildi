#!/usr/bin/env node
// CI guards for one push or pull-request range. Not full history.
//   BASE_SHA / HEAD_SHA from the workflow, or: node scripts/ci-guards.mjs <base> <head>
import { execFileSync } from "node:child_process";

export const PROTECTED_PATHS = [
  "artifacts/macro-data.json",
  "artifacts/macro-charts.json",
  ".claude/state.json",
];

const SCHEMA_PREFIX = "lib/db/src/schema/";
const MIGRATION_RE = /^lib\/db\/drizzle\/[^/]+\.sql$/;

export function normalizePath(file) {
  return String(file).replace(/\\/g, "/").replace(/^\.\//, "");
}

export function protectedHits(files) {
  const set = new Set(PROTECTED_PATHS);
  return files.map(normalizePath).filter((f) => set.has(f));
}

/** Merge commits (2+ parents) are integration noise and do not need an Agent trailer. */
export function isMergeCommit(parents) {
  return parents.filter(Boolean).length > 1;
}

/**
 * Muse AM/PM briefs land as commentary-only commits (often without a local Agent hook).
 * A197: skip the trailer rule when every path in that commit is under commentary/.
 */
export function isCommentaryOnly(files) {
  const paths = files.map(normalizePath).filter(Boolean);
  return paths.length > 0 && paths.every((f) => f.startsWith("commentary/"));
}

function isTrailerLine(line) {
  return /^[A-Za-z0-9][A-Za-z0-9-]*: \S/.test(line.trim());
}

/**
 * True when the ending trailer block contains `Agent: <name>`.
 * A blank line between trailer lines still counts (git puts Co-authored-by
 * after Agent, with a blank line, and then only the last line is a git trailer).
 */
export function hasAgentTrailer(message) {
  const lines = String(message).replace(/\r\n/g, "\n").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.trim() === "") {
      let j = i - 1;
      while (j >= 0 && lines[j].trim() === "") j--;
      if (j >= 0 && isTrailerLine(lines[j])) continue;
      break;
    }
    if (!isTrailerLine(line)) break;
    if (/^Agent:\s+\S+/.test(line.trim())) return true;
  }
  return false;
}

/**
 * Schema edits ship with a SQL file in lib/db/drizzle/.
 * That directory is the migration set (0000_*.sql through 0028_*.sql, journal in meta/).
 * lib/db/sql/ is ad-hoc and does not count.
 */
export function schemaWithoutMigration(files) {
  const paths = files.map(normalizePath);
  const schema = paths.filter((f) => f.startsWith(SCHEMA_PREFIX));
  const migrations = paths.filter((f) => MIGRATION_RE.test(f));
  if (schema.length === 0 || migrations.length > 0) return [];
  return schema;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function rangeFiles(base, head) {
  const out = git(["diff", "--name-only", "--diff-filter=ACDMRTUXB", base, head]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function commitFiles(hash) {
  const out = git(["diff-tree", "--no-commit-id", "--name-only", "-r", hash]);
  return out ? out.split("\n").filter(Boolean) : [];
}

function rangeCommits(base, head) {
  const out = git(["rev-list", "--reverse", `${base}..${head}`]);
  if (!out) return [];
  return out.split("\n").filter(Boolean).map((hash) => {
    const parents = git(["rev-list", "--parents", "-n", "1", hash]).split(/\s+/).slice(1);
    const message = execFileSync("git", ["log", "-1", "--format=%B", hash], { encoding: "utf8" });
    return { hash, parents, message, files: commitFiles(hash) };
  });
}

export function guardRange({ files, commits }) {
  const errors = [];
  const prot = protectedHits(files);
  if (prot.length) errors.push(`protected files changed: ${prot.join(", ")}`);
  const missingAgent = commits.filter((c) => {
    if (isMergeCommit(c.parents) || hasAgentTrailer(c.message)) return false;
    // Prefer per-commit file list; fall back to range files only when omitted (unit tests).
    const touched = Array.isArray(c.files) ? c.files : files;
    return !isCommentaryOnly(touched);
  });
  if (missingAgent.length) {
    errors.push(`commits missing Agent: <name> trailer: ${missingAgent.map((c) => c.hash.slice(0, 7)).join(", ")}`);
  }
  const schema = schemaWithoutMigration(files);
  if (schema.length) errors.push(`schema changed without a lib/db/drizzle/*.sql migration: ${schema.join(", ")}`);
  return errors;
}

function runningAsCli() {
  const arg = process.argv[1] ?? "";
  return arg.endsWith("ci-guards.mjs");
}

if (runningAsCli()) {
  const base = process.argv[2] || process.env.BASE_SHA || "";
  const head = process.argv[3] || process.env.HEAD_SHA || "HEAD";
  if (!base || /^0+$/.test(base)) {
    console.log("ci-guards: no base commit (new branch or missing before sha) — skip");
    process.exit(0);
  }
  const errors = guardRange({ files: rangeFiles(base, head), commits: rangeCommits(base, head) });
  if (errors.length) {
    for (const e of errors) console.error(`ci-guards: ${e}`);
    process.exit(1);
  }
  console.log(`ci-guards ok ${base.slice(0, 7)}..${head.slice(0, 7)}`);
}
