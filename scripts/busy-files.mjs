#!/usr/bin/env node
// Files other agents edited in the last N minutes (from ~/.fildi/agent-events.jsonl) — collision guard for the shared tree.
// Usage: node scripts/busy-files.mjs [--min 30] [--except-session <id>] [--one-line]
// Labels: claude · cursor (IDE) · cursor←claude (headless run launched by Claude via scripts/agent-dispatch.sh).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const a = process.argv.slice(2);
const opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
const cut = Date.now() - Number(opt("--min", 30)) * 60e3;
const except = opt("--except-session", process.env.CURSOR_SESSION_ID ?? "");
const seen = new Map();
let lines = [];
try { lines = readFileSync(join(homedir(), ".fildi/agent-events.jsonl"), "utf8").trim().split("\n").slice(-5000); } catch { /* no events yet */ }
for (const l of lines) {
  try {
    const e = JSON.parse(l);
    if (e.event !== "tool" || !/^(Write|Edit|MultiEdit|StrReplace|edit)$/.test(e.tool || "") || !e.detail) continue;
    if (Date.parse(e.t) < cut || (except && e.session === except)) continue;
    const who = e.parent ? `${e.agent}←${e.parent.split(":")[0]}` : e.agent;
    seen.set(e.detail, `${who} ${e.t.slice(11, 16)}Z`);
  } catch { /* partial line */ }
}
const rows = [...seen].map(([f, w]) => `${f} (${w})`);
if (a.includes("--one-line")) process.stdout.write(rows.slice(0, 40).join("; "));
else console.log(rows.length ? rows.join("\n") : "none");
