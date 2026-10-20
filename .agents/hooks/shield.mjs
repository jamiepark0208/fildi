#!/usr/bin/env node
// Shield — catch and undo accidental truncation of shared files (incident 2026-10-20: a Python one-liner
// `open(p,'w').write(f(open(p).read()))` truncated research/studies/INDEX.md before reading it and lost another
// agent's uncommitted S067 row). Tool-agnostic; warns, never blocks.
//
//   node .agents/hooks/shield.mjs snap            before a shell command / file write: store every dirty file as a git blob
//   node .agents/hooks/shield.mjs check           after: flag files that shrank ≥ 50 % (≥ 20 lines) vs snapshot or HEAD
//   node .agents/hooks/shield.mjs restore <path>  put back the last snapshot of <path> (atomic); `list <path>` shows versions
//
// Snapshots are git blobs (`git hash-object -w`): no working-tree change, no stash, invisible to other agents.
// Manifest: ~/.fildi/shield/latest.json (path → {sha, lines}); history.jsonl appends only changed versions.
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DIR = join(homedir(), ".fildi", "shield");
const LATEST = join(DIR, "latest.json");
const HIST = join(DIR, "history.jsonl");
const TEXT = /\.(md|ts|tsx|js|mjs|py|json|sh|sql|toml|ya?ml|txt|csv)$/;
const MAX_BYTES = 2_000_000;

const git = (args, input) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"], maxBuffer: 64 << 20 });
const lines = (p) => {
  try {
    const s = readFileSync(join(ROOT, p), "utf8");
    return s.length > MAX_BYTES ? -1 : s.split("\n").length;
  } catch {
    return 0;
  }
};
const readJSON = (f, d) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};

function dirty() {
  const tracked = git(["diff", "--name-only", "HEAD"]).split("\n");
  const untracked = git(["ls-files", "-o", "--exclude-standard", "research", ".agents", ".claude", ".cursor", "scripts"]).split("\n");
  return [...new Set([...tracked, ...untracked])].filter((p) => p && TEXT.test(p) && lines(p) > 0);
}

function snap() {
  mkdirSync(DIR, { recursive: true });
  const paths = dirty();
  if (!paths.length) return;
  const shas = git(["hash-object", "-w", "--stdin-paths"], paths.join("\n") + "\n").trim().split("\n");
  const prev = readJSON(LATEST, {});
  const next = {}; // only files dirty now → a flagged file warns once; its versions stay in history.jsonl for restore
  const ts = new Date().toISOString();
  paths.forEach((p, i) => {
    const n = lines(p);
    if (prev[p]?.sha !== shas[i]) appendFileSync(HIST, JSON.stringify({ ts, path: p, sha: shas[i], lines: n }) + "\n");
    next[p] = { sha: shas[i], lines: n, ts };
  });
  writeFileSync(LATEST, JSON.stringify(next));
}

function check() {
  const flags = [];
  const latest = readJSON(LATEST, {});
  for (const [p, v] of Object.entries(latest)) {
    const n = lines(p);
    if (v.lines >= 20 && n >= 0 && n < v.lines * 0.5) flags.push(`${p}: ${v.lines} → ${n} lines since the pre-command snapshot`);
  }
  for (const row of git(["diff", "--numstat", "HEAD"]).split("\n")) {
    const [add, del, p] = row.split("\t");
    if (!p || add === "-" || latest[p]) continue;
    if (+del >= 20 && +add < +del * 0.5) flags.push(`${p}: −${del} / +${add} lines vs HEAD`);
  }
  if (!flags.length) return;
  process.stderr.write(
    "SHIELD: possible accidental truncation —\n  " + flags.join("\n  ") +
      "\nIf unintended: node .agents/hooks/shield.mjs restore <path>  (versions: … list <path>). If intended (archive/rotate), ignore.\n",
  );
  process.exit(2); // Claude Code shows exit-2 stderr to the model; other tools just print it
}

function versions(p) {
  if (!existsSync(HIST)) return [];
  return readFileSync(HIST, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.path === p);
}

function restore(p, sha) {
  const v = versions(p);
  const pick = sha ? v.find((r) => r.sha.startsWith(sha)) : v.filter((r) => r.lines > 0).at(-1);
  if (!pick) return console.error(`no snapshot for ${p}`), process.exit(1);
  const tmp = join(ROOT, p) + ".shield-tmp";
  writeFileSync(tmp, git(["cat-file", "-p", pick.sha]));
  renameSync(tmp, join(ROOT, p));
  console.log(`restored ${p} from ${pick.ts} (${pick.lines} lines, ${pick.sha.slice(0, 8)})`);
}

const [cmd, p, sha] = process.argv.slice(2);
try {
  if (cmd === "snap") snap();
  else if (cmd === "check") check();
  else if (cmd === "restore") restore(p, sha);
  else if (cmd === "list") for (const r of versions(p)) console.log(r.ts, r.sha.slice(0, 8), r.lines);
  else console.error("usage: shield.mjs snap | check | restore <path> [sha] | list <path>");
} catch (e) {
  if (e?.status === 2) throw e;
  // never break the host tool on a hook error
}
