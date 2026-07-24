#!/usr/bin/env node
const fs   = require('fs');
const path = require('path');
const ROOT  = path.resolve(__dirname, '../../');
const STATE = path.join(ROOT, '.claude/state.json');

// ── Schema ────────────────────────────────────────────────────────────────────
// Canonical shape for state.json. validate() returns [] on success or
// an array of error strings. coerce() returns a safe default for any missing
// or malformed field — never throws, never silently keeps garbage.

const VALID_PHASES = ['scaffold', 'build', 'test', 'release', 'hotfix'];

function validate(s) {
  const errs = [];
  if (typeof s !== 'object' || s === null)   return ['state must be an object'];
  if (typeof s.phase !== 'string')            errs.push('phase: must be string');
  else if (!VALID_PHASES.includes(s.phase))   errs.push(`phase: "${s.phase}" not in ${VALID_PHASES.join('|')}`);
  if (!Array.isArray(s.working))              errs.push('working: must be array');
  if (!Array.isArray(s.in_progress))          errs.push('in_progress: must be array');
  if (!Array.isArray(s.blocked))              errs.push('blocked: must be array');
  if (!Array.isArray(s.next))                 errs.push('next: must be array');
  if (s.last_session !== undefined && typeof s.last_session !== 'string')
                                              errs.push('last_session: must be string');
  if (!Array.isArray(s.instincts))            errs.push('instincts: must be array');
  // All array items must be strings
  for (const field of ['working','in_progress','blocked','next','instincts']) {
    if (Array.isArray(s[field]) && s[field].some(x => typeof x !== 'string'))
      errs.push(`${field}: all items must be strings`);
  }
  return errs;
}

function coerce(raw) {
  if (typeof raw !== 'object' || raw === null) raw = {};
  return {
    phase:        VALID_PHASES.includes(raw.phase) ? raw.phase : 'build',
    working:      Array.isArray(raw.working)     ? raw.working.filter(x => typeof x === 'string')     : [],
    in_progress:  Array.isArray(raw.in_progress) ? raw.in_progress.filter(x => typeof x === 'string') : [],
    blocked:      Array.isArray(raw.blocked)     ? raw.blocked.filter(x => typeof x === 'string')     : [],
    next:         Array.isArray(raw.next)         ? raw.next.filter(x => typeof x === 'string')        : [],
    last_session: typeof raw.last_session === 'string' ? raw.last_session : '',
    instincts:    Array.isArray(raw.instincts)   ? raw.instincts.filter(x => typeof x === 'string')   : [],
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function parse() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { o[a[i].slice(2)] = a[i+1]||''; i++; }
  }
  return o;
}
function list(s) { return s ? s.split(',').map(x=>x.trim()).filter(Boolean) : []; }

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    const errs = validate(raw);
    if (errs.length) {
      process.stderr.write(`\n[STATE] Corrupt state.json — coercing to defaults:\n  ${errs.join('\n  ')}\n\n`);
      return coerce(raw);  // recover what we can, don't propagate garbage
    }
    return raw;
  } catch {
    return coerce({});  // missing or unparseable — start fresh
  }
}

// ── State file sync ───────────────────────────────────────────────────────────
function syncStateFile(filePath, state, dateStr) {
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');

  const phaseBlock  = `## Phase\n**${state.phase}** — last updated ${dateStr}`;
  const activeBlock = [
    '## Active work',
    `- Working: ${state.working.join(', ')||'none'}`,
    `- In progress: ${state.in_progress.join(', ')||'none'}`,
    `- Blocked: ${state.blocked.join(', ')||'none'}`,
  ].join('\n');

  content = content.replace(/## Phase\n[\s\S]*?(?=\n## )/, phaseBlock + '\n');
  content = content.replace(/## Active work\n[\s\S]*?(?=\n## )/, activeBlock + '\n');

  fs.writeFileSync(filePath, content);
}

// ── Session log ───────────────────────────────────────────────────────────────
function writeSessionEntry(state, note, now) {
  const dir = path.join(ROOT, '.agents/sessions');
  fs.mkdirSync(dir, { recursive: true });

  const dateStr   = now.slice(0, 10);
  const fileName  = `claude-${dateStr}.md`;
  const dayFile   = path.join(dir, fileName);
  const indexFile = path.join(dir, 'INDEX.md');

  const entry = [
    `## ${now}${note ? ' — ' + note : ''}`,
    `- Phase: ${state.phase}`,
    `- Working: ${state.working.join(', ')||'none'}`,
    `- In progress: ${state.in_progress.join(', ')||'none'}`,
    `- Blocked: ${state.blocked.join(', ')||'none'}`,
    `- Next: ${state.next.slice(0,3).join(', ')||'tbd'}`,
    '',
  ].join('\n');

  if (fs.existsSync(dayFile)) {
    fs.appendFileSync(dayFile, entry);
  } else {
    fs.writeFileSync(dayFile, `# Session Log: ${dateStr}\n\n${entry}`);
  }

  const indexLine = `- [${dateStr}](${fileName}) — ${note||'auto-saved'} | ${state.phase} | next: ${state.next.slice(0,3).join(', ')||'tbd'}`;

  if (!fs.existsSync(indexFile)) {
    fs.writeFileSync(indexFile, `# Session Index\n\nFull history for each date at \`.agents/sessions/YYYY-MM-DD.md\`.\nPre-2026-06-08: \`.claude/docs/session-history.md\`\n\n${indexLine}\n`);
  } else {
    let idx = fs.readFileSync(indexFile, 'utf8');
    const re = new RegExp(`^- \\[${dateStr}\\].*$`, 'm');
    idx = re.test(idx)
      ? idx.replace(re, indexLine)
      : idx.replace(/(\n\n)(- \[)/, `\n\n${indexLine}\n$2`);
    fs.writeFileSync(indexFile, idx);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
const args = parse();
const ex   = read();  // validated + coerced on read
const now  = new Date().toISOString().slice(0,16).replace('T',' ');

const next = coerce({
  ...ex,
  phase:       args.phase      || ex.phase,
  working:     args.working    !== undefined ? list(args.working)    : ex.working,
  in_progress: args.progress   !== undefined ? list(args.progress)   : ex.in_progress,
  blocked:     args.blocked    !== undefined ? list(args.blocked)    : ex.blocked,
  next:        args.next       !== undefined ? list(args.next)       : ex.next,
  // Kept short: rehydrate.js echoes this in full on EVERY prompt. Full note is preserved
  // untruncated in .agents/sessions/claude-*.md (writeSessionEntry below) and the commit body.
  last_session: now + (args.note ? ` — ${args.note.length > 150 ? args.note.slice(0, 147).trim() + '...' : args.note}` : ''),
  instincts:   args.instincts  !== undefined ? list(args.instincts)  : ex.instincts,
});

// instincts get re-sent in full on EVERY prompt via rehydrate.js's UserPromptSubmit
// hook — unbounded growth here is a direct, compounding per-turn token cost, not a
// one-time doc-size issue. Cap hard instead of letting it silently creep (grew to
// 8 entries / ~1850 chars before a 2026-07-15 trim brought it back to 3 / ~1100).
// Enforced (not just warned) — oldest entries are dropped past the cap, since a soft
// warning was easy to ignore mid-wrap and let the array creep back up anyway.
const INSTINCT_CAP = 10;
if (next.instincts.length > INSTINCT_CAP) {
  const dropped = next.instincts.length - INSTINCT_CAP;
  process.stderr.write(`\n[STATE] instincts had ${next.instincts.length} entries (cap ${INSTINCT_CAP}) — dropped ${dropped} oldest. Consolidate instead of just appending next time.\n`);
  next.instincts = next.instincts.slice(-INSTINCT_CAP);
}

// working/in_progress/blocked/next are comma-split by list() above — an item containing
// prose with its own commas gets silently shredded into unrelated fragments (seen in the
// wild: a single sentence became 4-5 disconnected array entries). Flag long items so the
// caller shortens them into tags instead of writing paragraphs into a CSV-style field.
const TAG_MAX_CHARS = 90;
for (const field of ['working', 'in_progress', 'blocked', 'next']) {
  const long = next[field].filter(x => x.length > TAG_MAX_CHARS);
  if (long.length) {
    process.stderr.write(`\n[STATE] ${field} has ${long.length} entr${long.length === 1 ? 'y' : 'ies'} over ${TAG_MAX_CHARS} chars — likely prose that got comma-shredded, not a short tag:\n  ${long.map(x => `"${x.slice(0, 60)}..."`).join('\n  ')}\n`);
  }
}

// Final validation before write — hard stop if coerce still fails
const finalErrs = validate(next);
if (finalErrs.length) {
  process.stderr.write(`\n[STATE] Cannot write invalid state:\n  ${finalErrs.join('\n  ')}\n`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(STATE), { recursive: true });
fs.writeFileSync(STATE, JSON.stringify(next, null, 2));

syncStateFile(path.join(ROOT, '.agents/context/state.md'), next, now.slice(0, 10));
writeSessionEntry(next, args.note||'', now);

// Stage all useful changes — source files, skills, docs, config, agent context
const { execSync, execFileSync } = require('child_process');
try {
  // Stage all tracked modified files
  execSync(`git -C "${ROOT}" add -u`, { stdio: 'pipe' });
  // Stage new untracked files that belong in the repo (skills, docs, source)
  // Use -z to get null-delimited output — avoids quoting issues with special chars in filenames
  const untracked = execSync(`git -C "${ROOT}" ls-files --others --exclude-standard -z`, { stdio: 'pipe' })
    .toString().split('\0').filter(f =>
      f && !f.startsWith('attached_assets/') && !f.includes('.codegraph/') &&
      !/\.(png|jpg|jpeg|gif|webp)$/.test(f)
    );
  if (untracked.length) {
    // Add in batches to avoid arg length limits
    for (const f of untracked) {
      try { execSync(`git -C "${ROOT}" add "${f.replace(/"/g, '\\"')}"`, { stdio: 'pipe' }); } catch {}
    }
  }
  const staged = execSync(`git -C "${ROOT}" diff --cached --name-only`, { stdio: 'pipe' }).toString().trim();
  console.log(`✅ Staged: ${staged.split('\n').join(', ')}`);
} catch (e) {
  console.warn(`⚠️  git add failed: ${e.message}`);
}

// Auto-commit and push staged changes
// Subject is kept short (<=72 chars) because `git log --oneline` — echoed in full by
// rehydrate.js on EVERY prompt — shows only the subject line. A long subject compounds
// as a per-turn cost forever; the full note still lives in the commit body (git log, not --oneline).
const rawNote = args.note || 'auto-saved';
const subjectPrefix = 'chore: session checkpoint — ';
const subjectNote = rawNote.length > 72 ? rawNote.slice(0, 69).trim() + '...' : rawNote;
const commitSubject = `${subjectPrefix}${subjectNote}`;
try {
  // Only commit if there are staged changes
  const staged = execSync(`git -C "${ROOT}" diff --cached --name-only`, { stdio: 'pipe' }).toString().trim();
  if (staged) {
    const commitArgs = ['-C', ROOT, 'commit', '-m', commitSubject];
    if (rawNote !== subjectNote) commitArgs.push('-m', rawNote);
    execFileSync('git', commitArgs, { stdio: 'pipe' });
    console.log(`✅ Committed: ${commitSubject}`);
    try {
      execSync(`git -C "${ROOT}" push origin main`, { stdio: 'pipe' });
      console.log(`✅ Pushed to origin/main`);
    } catch (pushErr) {
      console.warn(`⚠️  push failed (will retry next session): ${pushErr.message}`);
    }
  } else {
    console.log(`ℹ️  Nothing staged to commit`);
  }
} catch (e) {
  console.warn(`⚠️  commit failed: ${e.message}`);
}

console.log(`✅ State saved at ${now}`);
console.log(JSON.stringify(next, null, 2));
