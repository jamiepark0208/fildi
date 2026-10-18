#!/usr/bin/env node
// sessionStart hook — sync team bus, then inject git-tracked session context
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const env = { ...process.env, FILDI_AGENT: process.env.FILDI_AGENT || 'cursor' };

// Pull/push Muse+Claude bus before the agent starts reading ASKS (Jamie 10-18).
// Never stash/rebase/pull by hand — this script is the only sync path.
const sync = spawnSync('bash', ['scripts/agent-git-sync.sh'], {
  encoding: 'utf8',
  cwd: ROOT,
  env,
  timeout: 90_000,
});
const syncLine = (sync.stdout || sync.stderr || '').trim().split('\n').filter(Boolean).pop()
  || (sync.error ? `agent-git-sync: ${sync.error.message}` : 'agent-git-sync: no output');

const script = path.join(__dirname, 'rehydrate-cursor.js');
const result = spawnSync(process.execPath, [script, '--json'], {
  encoding: 'utf8',
  cwd: ROOT,
  env,
});

if (result.status !== 0 || !result.stdout?.trim()) {
  process.stdout.write(`Sync: ${syncLine}\n`);
  process.exit(0);
}

process.stdout.write(`${result.stdout.trim()}\nSync: ${syncLine}`);
