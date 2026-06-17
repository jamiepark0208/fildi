#!/usr/bin/env node
// sessionStart hook — inject git-tracked session context once per new chat
const { spawnSync } = require('child_process');
const path = require('path');

const script = path.join(__dirname, 'rehydrate-cursor.js');
const result = spawnSync(process.execPath, [script, '--json'], {
  encoding: 'utf8',
  cwd: path.resolve(__dirname, '../..'),
});

if (result.status !== 0 || !result.stdout?.trim()) {
  process.exit(0);
}

process.stdout.write(result.stdout.trim());
