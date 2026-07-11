#!/usr/bin/env node
// PreToolUse hook on Read only (Edit/Write codegraph auto-injection removed —
// cost of ~1200 chars + a codegraph subprocess call on every single edit
// wasn't worth it; CLAUDE.md already tells the model to call codegraph
// tools itself before editing when it's actually useful).
// Read: warns when reading a large file without offset+limit — enforces targeted reads.
const { execSync } = require('child_process');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let raw = '';
rl.on('line', l => raw += l + '\n');
rl.on('close', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  const tool = input?.tool_name || '';
  const filePath = input?.tool_input?.file_path || '';
  if (!filePath) { process.exit(0); }

  const inSource = filePath.includes('/artifacts/api-server/src/') || filePath.includes('/artifacts/stock-compare/src/');

  // ── Read guard: warn on large files without offset+limit ──────────────────
  if (tool === 'Read') {
    if (!inSource) { process.exit(0); }
    const hasLimit  = input?.tool_input?.limit  != null;
    const hasOffset = input?.tool_input?.offset != null;
    if (hasLimit || hasOffset) { process.exit(0); } // targeted read — fine

    try {
      const lines = parseInt(
        execSync(`wc -l < "${filePath.replace(/"/g, '\\"')}" 2>/dev/null`, { encoding: 'utf8' }).trim(), 10
      );
      if (!lines || lines <= 150) { process.exit(0); } // small file — fine
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `⚠️ READ GUARD: "${filePath.split('/').pop()}" has ${lines} lines. Do NOT read the whole file.\n` +
            `1. Use grep/codegraph to find the target line numbers first.\n` +
            `2. Then Read with offset+limit covering only the relevant section.\n` +
            `Reading the whole file burns ~${Math.round(lines * 5 / 1000)}k tokens unnecessarily.`
        }
      }));
    } catch { /* wc failed — pass through silently */ }
    process.exit(0);
  }

  // Edit/Write: no-op — codegraph auto-injection removed, see header comment.
  process.exit(0);
});
