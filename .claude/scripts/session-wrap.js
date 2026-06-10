#!/usr/bin/env node
const fs   = require('fs');
const path = require('path');
const ROOT  = path.resolve(__dirname, '../../');
const STATE = path.join(ROOT, '.claude/state.json');

function parse() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) { o[a[i].slice(2)] = a[i+1]||''; i++; }
  }
  return o;
}
function list(s) { return s ? s.split(',').map(x=>x.trim()).filter(Boolean) : []; }
function read() { try { return JSON.parse(fs.readFileSync(STATE,'utf8')); } catch { return {}; } }

// Sync Phase + Active work blocks in .kiro/steering/03-state.md.
// Only updates the two machine-generated sections; Next tasks is left human-managed.
function syncKiroState(state, dateStr) {
  const kiroPath = path.join(ROOT, '.kiro/steering/03-state.md');
  if (!fs.existsSync(kiroPath)) return;
  let content = fs.readFileSync(kiroPath, 'utf8');

  const phaseBlock   = `## Phase\n**${state.phase}** — last updated ${dateStr}`;
  const activeBlock  = [
    '## Active work',
    `- Working: ${(state.working||[]).join(', ')||'none'}`,
    `- In progress: ${(state.in_progress||[]).join(', ')||'none'}`,
    `- Blocked: ${(state.blocked||[]).join(', ')||'none'}`,
  ].join('\n');

  // Replace each section — match content up to (but not including) the next ##
  content = content.replace(/## Phase\n[\s\S]*?(?=\n## )/, phaseBlock + '\n');
  content = content.replace(/## Active work\n[\s\S]*?(?=\n## )/, activeBlock + '\n');

  fs.writeFileSync(kiroPath, content);
}

// Append a timestamped entry to .agents/sessions/YYYY-MM-DD.md
// and upsert a one-line summary in .agents/sessions/INDEX.md.
function writeSessionEntry(state, note, now) {
  const dir = path.join(ROOT, '.agents/sessions');
  fs.mkdirSync(dir, { recursive: true });

  const dateStr  = now.slice(0, 10);
  const dayFile  = path.join(dir, `${dateStr}.md`);
  const indexFile = path.join(dir, 'INDEX.md');

  const entry = [
    `## ${now}${note ? ' — ' + note : ''}`,
    `- Phase: ${state.phase}`,
    `- Working: ${(state.working||[]).join(', ')||'none'}`,
    `- In progress: ${(state.in_progress||[]).join(', ')||'none'}`,
    `- Blocked: ${(state.blocked||[]).join(', ')||'none'}`,
    `- Next: ${(state.next||[]).slice(0,3).join(', ')||'tbd'}`,
    '',
  ].join('\n');

  if (fs.existsSync(dayFile)) {
    fs.appendFileSync(dayFile, entry);
  } else {
    fs.writeFileSync(dayFile, `# Session Log: ${dateStr}\n\n${entry}`);
  }

  // INDEX line: one line per day, upsert by date
  const indexLine = `- [${dateStr}](${dateStr}.md) — ${note||'auto-saved'} | ${state.phase} | next: ${(state.next||[]).slice(0,3).join(', ')||'tbd'}`;

  if (!fs.existsSync(indexFile)) {
    fs.writeFileSync(indexFile, `# Session Index\n\nFull history for each date at \`.agents/sessions/YYYY-MM-DD.md\`.\nPre-2026-06-08: \`.claude/docs/session-history.md\`\n\n${indexLine}\n`);
  } else {
    let idx = fs.readFileSync(indexFile, 'utf8');
    const re = new RegExp(`^- \\[${dateStr}\\].*$`, 'm');
    if (re.test(idx)) {
      idx = idx.replace(re, indexLine);
    } else {
      // Prepend after the header block (first blank line after a non-bullet line)
      idx = idx.replace(/(\n\n)(- \[)/, `\n\n${indexLine}\n$2`);
    }
    fs.writeFileSync(indexFile, idx);
  }
}

const args = parse(), ex = read();
const now  = new Date().toISOString().slice(0,16).replace('T',' ');
const next = {
  ...ex,
  phase:       args.phase      || ex.phase      || 'scaffold',
  working:     args.working    !== undefined ? list(args.working)  : (ex.working||[]),
  in_progress: args.progress   !== undefined ? list(args.progress) : (ex.in_progress||[]),
  blocked:     args.blocked    !== undefined ? list(args.blocked)  : (ex.blocked||[]),
  next:        args.next       !== undefined ? list(args.next)     : (ex.next||[]),
  last_session: now + (args.note ? ` — ${args.note}` : ''),
  instincts:   ex.instincts || []
};

fs.mkdirSync(path.dirname(STATE), { recursive:true });
fs.writeFileSync(STATE, JSON.stringify(next, null, 2));

syncKiroState(next, now.slice(0, 10));
writeSessionEntry(next, args.note||'', now);

console.log(`✅ State saved at ${now}`);
console.log(JSON.stringify(next, null, 2));
