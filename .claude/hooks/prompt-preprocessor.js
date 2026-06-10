#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let raw = '';
rl.on('line', l => raw += l + '\n');
rl.on('close', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const prompt = (input?.tool_input?.prompt || input?.tool_input?.description || '').toLowerCase();
  const warnings = [];
  const HAIKU = ['fetch', 'cache read', 'scaffold', 'boilerplate', 'write test stub'];
  const OPUS  = ['/opus', 'redesign entire', 'refactor all'];
  if (OPUS.some(s => prompt.includes(s)))
    warnings.push('[MODEL] Opus-tier task — add /opus flag to confirm.');
  else if (HAIKU.some(s => prompt.includes(s)))
    warnings.push('[MODEL] Haiku-tier task — use claude-haiku-4-5-20251001 for this subtask.');
  if (prompt.split(/\s+/).length > 120)
    warnings.push('[CONTEXT] Prompt is long — move reusable parts into a skill file.');
  if (prompt.includes('options chain') && !prompt.includes('cache'))
    warnings.push('[DATA] Options chain fetch must check Redis cache first.');
  if (warnings.length) process.stderr.write('\n' + warnings.join('\n') + '\n\n');
  process.exit(0);
});
