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

  // ── codegraph_context guard: nudge toward includeCode:false / small maxNodes
  // when not overridden — the full-code-snippet mode is the single largest
  // per-call context cost in this project (easily 1-2k tokens per call).
  if (tool === 'mcp__codegraph__codegraph_context') {
    const includeCode = input?.tool_input?.includeCode;
    const maxNodes     = input?.tool_input?.maxNodes;
    const codeOn       = includeCode !== false;   // codegraph defaults includeCode to true
    const wide         = maxNodes == null || maxNodes > 10;
    if (codeOn && wide) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `⚠️ CODEGRAPH GUARD: codegraph_context with includeCode:true (default) and maxNodes:${maxNodes ?? 20} returns full source for every matched symbol — often 1-2k+ tokens. If you just need symbol locations, pass includeCode:false. Otherwise cap maxNodes to ~8-10.`
        }
      }));
    }
    process.exit(0);
  }

  const filePath = input?.tool_input?.file_path || '';
  if (!filePath) { process.exit(0); }

  const inSource = filePath.includes('/artifacts/api-server/src/') || filePath.includes('/artifacts/stock-compare/src/');

  // ── Read guard: warn on large files without offset+limit, AND on windows
  // that are still too wide even when offset/limit is given (e.g. limit:300
  // technically satisfies "targeted" but still burns ~1.5-2k tokens for
  // content likely unrelated to the one symbol being edited).
  const MAX_WINDOW_LINES = 100;
  if (tool === 'Read') {
    if (!inSource) { process.exit(0); }
    const limit  = input?.tool_input?.limit;
    const offset = input?.tool_input?.offset;
    const hasWindow = limit != null || offset != null;
    const windowTooWide = limit != null && limit > MAX_WINDOW_LINES;

    if (hasWindow && !windowTooWide) { process.exit(0); } // tight, targeted read — fine

    try {
      const lines = parseInt(
        execSync(`wc -l < "${filePath.replace(/"/g, '\\"')}" 2>/dev/null`, { encoding: 'utf8' }).trim(), 10
      );
      if (!lines || lines <= 150) { process.exit(0); } // small file — fine either way

      const msg = windowTooWide
        ? `⚠️ READ GUARD: requesting limit:${limit} lines from "${filePath.split('/').pop()}" (${lines} total). ` +
          `Narrow the window to ~${MAX_WINDOW_LINES} lines or fewer — grep for the exact symbol/line number first, then re-Read just that range.`
        : `⚠️ READ GUARD: "${filePath.split('/').pop()}" has ${lines} lines. Do NOT read the whole file.\n` +
          `1. Use grep/codegraph to find the target line numbers first.\n` +
          `2. Then Read with offset+limit (≤${MAX_WINDOW_LINES} lines) covering only the relevant section.\n` +
          `Reading the whole file burns ~${Math.round(lines * 5 / 1000)}k tokens unnecessarily.`;

      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: msg }
      }));
    } catch { /* wc failed — pass through silently */ }
    process.exit(0);
  }

  // Edit/Write: no-op — codegraph auto-injection removed, see header comment.
  process.exit(0);
});
