#!/usr/bin/env node
// PreToolUse hook on Edit|Write — auto-injects codegraph context for the target file.
// Eliminates the need to Read files before editing by providing symbol graph inline.
const { execSync } = require('child_process');
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let raw = '';
rl.on('line', l => raw += l + '\n');
rl.on('close', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  const filePath = input?.tool_input?.file_path || '';
  if (!filePath) { process.exit(0); }

  // Only fire for indexed source files — skip hooks, config, markdown, etc.
  const inSource = filePath.includes('/artifacts/api-server/src/') || filePath.includes('/artifacts/stock-compare/src/');
  if (!inSource) { process.exit(0); }

  try {
    const result = execSync(
      `codegraph context "${filePath.replace(/"/g, '\\"')}" 2>/dev/null`,
      { cwd: '/home/runner/workspace', timeout: 5000, encoding: 'utf8' }
    ).trim();

    if (!result) { process.exit(0); }

    // Strip code blocks — keep only entry points + related symbols (structural graph info).
    // The code section is ~67% of output and duplicates explicit codegraph_context MCP calls.
    const codeIdx = result.indexOf('\n### Code');
    const structural = (codeIdx > -1 ? result.slice(0, codeIdx) : result).trim();

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `[CODEGRAPH:${filePath}]\n${structural.slice(0, 1200)}\n[/CODEGRAPH]`
      }
    }));
  } catch { /* codegraph unavailable — silent pass-through */ }
  process.exit(0);
});
