#!/usr/bin/env node
// Validates that all token-efficiency workflow hooks are correctly configured
// AND that CLAUDE.md's file references haven't drifted from the actual code.
// Run at session start to confirm enforcement is active. Exits 0 if all pass.
//
// Doc-freshness checks added 2026-07-31 after an audit found 6 stale references
// (deleted MacroComponents.tsx still indexed, deleted provenance-cache.ts still
// listed, a removed Edit/Write hook still described). Docs decay faster than
// they're read — this catches drift mechanically at session start.
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
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

// 2. Playwright note still present in rehydrate (case-insensitive — the note
// uses capital P; the old check silently passed vacuously... i.e. failed)
const rehydrate = fs.readFileSync(path.join(ROOT, '.claude/scripts/rehydrate.js'), 'utf8');
const hasPw = /playwright/i.test(rehydrate);
check('Playwright status in rehydrate', hasPw, hasPw ? 'ok' : 'MISSING — re-add playwright note to rehydrate.js');

// 3. codegraph_node memory note exists
const memDir = path.join(process.env.HOME, '.local/bin/claude/projects/-home-runner-workspace/memory');
const memFile = path.join(memDir, 'feedback_codegraph_node_default.md');
check('codegraph_node default:false memory', fs.existsSync(memFile), fs.existsSync(memFile) ? 'ok' : 'MISSING — recreate memory note');

// 4. Line-count ratchet: every file >600L has its current size locked as a
// ceiling in .claude/line-ratchet.json. Growing one fails; shrinking one
// auto-lowers its ceiling. Big files are the main AI-analysis tax (windowed
// reads invalidate, edits churn unrelated context) — the ratchet forces them
// to only ever shrink. Files split below 600L drop out of the ratchet.
const RATCHET = path.join(ROOT, '.claude/line-ratchet.json');
try {
  const ratchet = JSON.parse(fs.readFileSync(RATCHET, 'utf8'));
  const grew = [];
  let lowered = 0;
  for (const [rel, ceiling] of Object.entries(ratchet)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { delete ratchet[rel]; lowered++; continue; } // deleted/split — drop
    const lines = fs.readFileSync(abs, 'utf8').split('\n').length;
    if (lines > ceiling) grew.push(`${path.basename(rel)} ${ceiling}→${lines}L`);
    else if (lines < ceiling) { ratchet[rel] = lines <= 600 ? undefined : lines; if (ratchet[rel] === undefined) delete ratchet[rel]; lowered++; }
  }
  if (lowered) fs.writeFileSync(RATCHET, JSON.stringify(ratchet, null, 1) + '\n');
  check('Line ratchet (no big file grew)', grew.length === 0,
    grew.length ? `GREW: ${grew.join(', ')} — split out the code you're adding instead` : `${Object.keys(ratchet).length} ceilings held${lowered ? `, ${lowered} lowered` : ''}`);
} catch { check('Line ratchet (no big file grew)', false, '.claude/line-ratchet.json missing/corrupt — regenerate'); }

// 5. macro-static.ts and macro-page-types.ts exist (splits intact)
for (const rel of [
  'artifacts/api-server/src/lib/macro-static.ts',
  'artifacts/stock-compare/src/components/macro/macro-page-types.ts',
]) {
  const name = path.basename(rel);
  check(`${name} exists`, fs.existsSync(path.join(ROOT, rel)), fs.existsSync(path.join(ROOT, rel)) ? 'ok' : 'MISSING — file was deleted');
}

// ── 6. CLAUDE.md doc-freshness ──────────────────────────────────────────────
const claudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');

// Resolve a doc-relative path against the roots it might be relative to.
function resolveDocPath(rel) {
  for (const base of ['', 'artifacts', 'artifacts/api-server/src', 'artifacts/stock-compare/src']) {
    const abs = path.join(ROOT, base, rel);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

// 6a. Every backticked *.ts/tsx path in KEY FILES resolves to a real file
const keySection = claudeMd.split(/## KEY FILES/)[1]?.split(/\n## /)[0] ?? '';
const keyPaths = [...keySection.matchAll(/`([^`]+\.tsx?)`/g)].map(m => m[1]);
const deadKeys = keyPaths.filter(p => !resolveDocPath(p));
check('KEY FILES paths all exist', deadKeys.length === 0,
  deadKeys.length ? `STALE: ${deadKeys.join(', ')} — remove or repoint in CLAUDE.md` : `${keyPaths.length} paths verified`);

// 6b. Every hot-index row: file exists AND its grep pattern still matches ≥1 line
const hotSection = claudeMd.split(/## HOT FILE INDEX/)[1]?.split(/\n## /)[0] ?? '';
const rows = [...hotSection.matchAll(/^\| `([^`]+)`[^|]*\|[^|]+\| `grep -n "([^"]+)"`/gm)];
const hotProblems = [];
for (const [, rel, pattern] of rows) {
  const abs = resolveDocPath(rel);
  if (!abs) { hotProblems.push(`${rel}: FILE MISSING`); continue; }
  try {
    execSync(`grep -c ${JSON.stringify(pattern)} ${JSON.stringify(abs)}`, { stdio: 'pipe' });
  } catch {
    hotProblems.push(`${rel}: pattern "${pattern}" matches nothing`);
  }
}
check('Hot file index fresh', hotProblems.length === 0,
  hotProblems.length ? `STALE: ${hotProblems.join(' | ')}` : `${rows.length} rows verified (file + pattern)`);

// 6c. CLAUDE.md doesn't describe hooks that aren't registered
const claimsEditWriteHook = /auto-runs on Edit\/Write/i.test(claudeMd);
check('No phantom hook claims', !claimsEditWriteHook,
  claimsEditWriteHook ? 'CLAUDE.md claims an Edit/Write codegraph hook that is not registered' : 'ok');

// 6d. API endpoint catalog completeness (routes in code vs api-endpoints.md)
try {
  execSync(`node ${path.join(__dirname, 'check-api-endpoints.js')}`, { stdio: 'pipe' });
  check('API endpoint catalog complete', true, 'all code routes present in doc');
} catch (e) {
  const firstLine = (e.stdout?.toString() ?? '').split('\n')[0];
  check('API endpoint catalog complete', false,
    `${firstLine} — run: node .claude/scripts/check-api-endpoints.js --write`);
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
