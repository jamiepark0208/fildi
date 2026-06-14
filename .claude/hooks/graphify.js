#!/usr/bin/env node
// PreToolUse on Edit|Write — runs codegraph context on the target file
// and injects relevant symbols/callers as additionalContext so Claude
// doesn't need to re-read source files to understand structure.
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

  try {
    const result = execSync(
      `codegraph context "${filePath.replace(/"/g, '\\"')}" 2>/dev/null`,
      { cwd: '/home/runner/workspace', timeout: 8000, encoding: 'utf8' }
    ).trim();

    if (!result) { process.exit(0); }

    const out = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `[CODEGRAPH — ${filePath}]\n${result.slice(0, 3000)}\n[END CODEGRAPH]`,
      },
    };
    process.stdout.write(JSON.stringify(out));
  } catch {
    // codegraph unavailable or file not indexed — silent pass-through
  }
  process.exit(0);
});
