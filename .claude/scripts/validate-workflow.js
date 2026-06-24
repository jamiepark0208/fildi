#!/usr/bin/env node
// Validates that all token-efficiency workflow hooks are correctly configured.
// Run at session start to confirm enforcement is active. Exits 0 if all pass.
const fs   = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../../');

const checks = [];

function check(name, pass, detail) {
  checks.push({ name, pass, detail });
}

// 1. Read guard hook is registered in settings
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude/settings.local.json'), 'utf8'));
const preHooks = settings?.hooks?.PreToolUse ?? [];
const readHook = preHooks.find(h => h.matcher?.includes('Read') && h.hooks?.[0]?.command?.includes('codegraph-precheck'));
check('Read guard hook active', !!readHook, readHook ? 'matcher: ' + readHook.matcher : 'MISSING — add Read to matcher in settings.local.json');

// 2. Playwright detection in rehydrate
const rehydrate = fs.readFileSync(path.join(ROOT, '.claude/scripts/rehydrate.js'), 'utf8');
check('Playwright status in rehydrate', rehydrate.includes('playwright'), rehydrate.includes('playwright') ? 'ok' : 'MISSING — re-add playwright check to rehydrate.js');

// 3. codegraph_node memory note exists
const memDir = path.join(process.env.HOME, '.local/bin/claude/projects/-home-runner-workspace/memory');
const memFile = path.join(memDir, 'feedback_codegraph_node_default.md');
check('codegraph_node default:false memory', fs.existsSync(memFile), fs.existsSync(memFile) ? 'ok' : 'MISSING — recreate memory note');

// 4. Large files haven't regressed (warn if any re-merged into >500L)
const srcPaths = [
  ['macro.tsx', 'artifacts/stock-compare/src/pages/macro.tsx', 700],
  ['macro-data.ts', 'artifacts/api-server/src/lib/macro-data.ts', 1000],
  ['MacroComponents.tsx', 'artifacts/stock-compare/src/components/macro/MacroComponents.tsx', 1600],
];
for (const [label, rel, limit] of srcPaths) {
  const absPath = path.join(ROOT, rel);
  if (fs.existsSync(absPath)) {
    const lines = fs.readFileSync(absPath, 'utf8').split('\n').length;
    check(`${label} within line budget`, lines <= limit, `${lines}L (limit: ${limit}L)`);
  }
}

// 5. macro-static.ts and macro-page-types.ts exist (splits intact)
for (const rel of [
  'artifacts/api-server/src/lib/macro-static.ts',
  'artifacts/stock-compare/src/components/macro/macro-page-types.ts',
]) {
  const name = path.basename(rel);
  check(`${name} exists`, fs.existsSync(path.join(ROOT, rel)), fs.existsSync(path.join(ROOT, rel)) ? 'ok' : 'MISSING — file was deleted');
}

// Report
const pass = checks.filter(c => c.pass).length;
const fail = checks.filter(c => !c.pass).length;
console.log(`\n🔍 Workflow validation: ${pass} passed, ${fail} failed\n`);
for (const c of checks) {
  console.log(`  ${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail}`);
}
if (fail > 0) {
  console.log('\n⚠️  Fix failing checks before starting work to avoid token waste.\n');
  process.exit(1);
}
console.log();
