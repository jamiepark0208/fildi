#!/usr/bin/env node
/**
 * Fully detach a Mac local-dev process so Cursor agent / terminal abort cannot kill it.
 *
 *   node scripts/dev-spawn.mjs --cwd=DIR --log=FILE [--pidfile=FILE] [--port=N] -- KEY=val ... cmd arg...
 */
import { spawn } from "node:child_process";
import { openSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0) {
  console.error(
    "usage: node scripts/dev-spawn.mjs --cwd=DIR --log=FILE [--pidfile=FILE] [--port=N] -- KEY=val ... cmd args...",
  );
  process.exit(2);
}
const meta = argv.slice(0, sep);
let rest = argv.slice(sep + 1);
if (rest[0] === "--") rest = rest.slice(1);

let cwd = process.cwd();
let logFile = "/tmp/fildi-logs/spawn.log";
let pidFile = "";
let port = null;
for (const a of meta) {
  if (a.startsWith("--cwd=")) cwd = resolve(a.slice(6));
  if (a.startsWith("--log=")) logFile = resolve(a.slice(6));
  if (a.startsWith("--pidfile=")) pidFile = resolve(a.slice(10));
  if (a.startsWith("--port=")) port = Number(a.slice(7)) || null;
}

const env = { ...process.env };
const cmd = [];
for (const tok of rest) {
  if (cmd.length === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) {
    const i = tok.indexOf("=");
    env[tok.slice(0, i)] = tok.slice(i + 1);
    if (tok.startsWith("PORT=") && port == null) {
      port = Number(tok.slice(5)) || null;
    }
  } else {
    cmd.push(tok);
  }
}
if (cmd.length === 0) {
  console.error("missing command after env assignments");
  process.exit(2);
}

if (!pidFile) {
  // sibling of log: api.log → api.pid.json
  const base = basename(logFile).replace(/\.log$/i, "");
  pidFile = resolve(dirname(logFile), `${base}.pid.json`);
}

mkdirSync(dirname(logFile), { recursive: true });
mkdirSync(dirname(pidFile), { recursive: true });
const out = openSync(logFile, "a");
const child = spawn(cmd[0], cmd.slice(1), {
  cwd,
  env,
  detached: true,
  stdio: ["ignore", out, out],
});
child.on("error", (err) => {
  console.error("spawn failed:", err.message);
  process.exit(1);
});

const startedAt = new Date().toISOString();
const record = {
  pid: child.pid,
  pgid: child.pid, // detached = new session; spawn pid is group leader
  port,
  cmd: cmd.join(" "),
  cwd,
  log: logFile,
  startedAt,
};
writeFileSync(pidFile, JSON.stringify(record, null, 2) + "\n");

child.unref();
console.log(
  `spawned pid=${child.pid} cwd=${cwd} log=${logFile} pidfile=${pidFile} cmd=${cmd.join(" ")}`,
);
