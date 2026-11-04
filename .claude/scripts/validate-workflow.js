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

// 2. (removed 2026-10-11: Playwright-note-in-rehydrate check — the rehydrate hook was dropped 2026-10-06)

// 3. codegraph_node includeCode guidance is in CLAUDE.md (was a Replit-only memory-file path;
// CLAUDE.md is loaded every session on every machine, so the rule lives there).
const cgClaudeMd = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
const hasCgRule = /codegraph_node`? with `?includeCode:true/.test(cgClaudeMd) && /includeCode:false/.test(cgClaudeMd);
check('codegraph_node includeCode rule in CLAUDE.md', hasCgRule, hasCgRule ? 'ok' : 'MISSING — restore the codegraph_node includeCode line in CLAUDE.md');

// 4. Large-file report (advisory, user 2026-10-11: "big" is subjective, so size never blocks work).
// Tracks files >600L in .claude/line-ratchet.json and reports growth once (the new size is recorded).
// Size alone is not a reason to split: split only when a file mixes unrelated jobs, never to dodge this report,
// and never by creating a second home for logic (AGENTS rule 5). Reads stay cheap via grep + offset/limit.
const RATCHET = path.join(ROOT, '.claude/line-ratchet.json');
try {
  const sizes = JSON.parse(fs.readFileSync(RATCHET, 'utf8'));
  const grew = [];
  for (const [rel, prev] of Object.entries(sizes)) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { delete sizes[rel]; continue; }
    const text = fs.readFileSync(abs, 'utf8');
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0); // same as wc -l
    if (lines > prev) grew.push(`${path.basename(rel)} ${prev}→${lines}L`);
    if (lines <= 600) delete sizes[rel]; else sizes[rel] = lines;
  }
  fs.writeFileSync(RATCHET, JSON.stringify(sizes, null, 1) + '\n');
  check('Large files (advisory)', true,
    grew.length ? `grew: ${grew.join(', ')} — fine if the code belongs there` : `${Object.keys(sizes).length} tracked`);
} catch { check('Large files (advisory)', true, '.claude/line-ratchet.json missing/corrupt — skipped'); }

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

// 6c2. OpenJev registry integrity (A150): numbers only from oj eval, no self-verification, md generated
try {
  const out = execSync(`python3 ${path.join(ROOT, 'scripts/oj.py')} check`, { stdio: 'pipe' }).toString().trim();
  check('OpenJev registry consistent', true, out);
} catch (e) {
  check('OpenJev registry consistent', false, (e.stdout?.toString() ?? '').trim().split('\n').slice(0, 3).join(' · '));
}

// 6d. API endpoint catalog completeness (routes in code vs api-endpoints.md)
try {
  execSync(`node ${path.join(__dirname, 'check-api-endpoints.js')}`, { stdio: 'pipe' });
  check('API endpoint catalog complete', true, 'all code routes present in doc');
} catch (e) {
  const firstLine = (e.stdout?.toString() ?? '').split('\n')[0];
  check('API endpoint catalog complete', false,
    `${firstLine} — run: node .claude/scripts/check-api-endpoints.js --write`);
}

// 6e. Dead paths in agent docs (11-03 audit: 13 real dead/wrong pointers → grep waste / invented paths).
// Ratchet at 10 (8 left are shorthand, build output or uncommitted files).
{
  let out = '';
  try { out = execSync(`python3 ${path.join(ROOT, 'scripts/doc_paths_check.py')}`, { stdio: 'pipe' }).toString(); }
  catch (e) { out = e.stdout?.toString() ?? ''; }
  const n = Number((out.match(/dead paths: (\d+)/) || [])[1] ?? -1);
  check('Agent-doc dead paths ≤ 10', n >= 0 && n <= 10, `${n} — run: python3 scripts/doc_paths_check.py`);
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
