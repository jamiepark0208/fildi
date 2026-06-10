#!/usr/bin/env node
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin });
let raw = '';
rl.on('line', l => raw += l + '\n');
rl.on('close', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  const used = parseInt(process.env.CONTEXT_TOKENS_USED || '0', 10);
  const max  = parseInt(process.env.CONTEXT_TOKENS_MAX || '200000', 10);
  const pct  = max > 0 ? Math.round((used / max) * 100) : 0;
  if (pct >= 60)
    process.stderr.write('\n[CONTEXT CRITICAL] ' + pct + '% full — stop after this step, run session-wrap, then /compact.\n\n');
  else if (pct >= 40)
    process.stderr.write('\n[CONTEXT WARN] ' + pct + '% full — consider /compact before next complex task.\n\n');
  const size = JSON.stringify(input?.tool_result || '').length;
  if (size > 15000)
    process.stderr.write('\n[OUTPUT] Tool returned ' + Math.round(size/1000) + 'KB — summarize before using in next prompt.\n\n');
  process.exit(0);
});
