#!/usr/bin/env node
/**
 * Cursor end-of-session wrap.
 * 1. Updates `.cursor/context/session.md` (Cursor-only ephemeral notes)
 * 2. Syncs `.agents/context/cursor-state.md` (Cursor task queue — not shared state.md)
 * 3. Appends to `.agents/sessions/cursor-YYYY-MM-DD.md` (shared git history)
 * 4. Upserts `.agents/sessions/INDEX.md`
 *
 * Usage:
 *   node .cursor/scripts/session-wrap-cursor.js "one-line summary of what we did"
 *   node .cursor/scripts/session-wrap-cursor.js --working "feat-a" --progress "feat-b" "summary"
 *   node .cursor/scripts/session-wrap-cursor.js --next "task one,task two" "summary"
 *   node .cursor/scripts/session-wrap-cursor.js   (interactive — reads stdin lines until EOF)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SESSION = path.join(ROOT, '.cursor/context/session.md');
const CURSOR_STATE = path.join(ROOT, '.agents/context/cursor-state.md');
const SESSIONS_DIR = path.join(ROOT, '.agents/sessions');
const INDEX_FILE = path.join(SESSIONS_DIR, 'INDEX.md');

const now = new Date();
const today = now.toISOString().slice(0, 10);
const timeStamp = now.toISOString().slice(0, 16).replace('T', ' ');
const sessionFileName = `cursor-${today}.md`;
const dayFile = path.join(SESSIONS_DIR, sessionFileName);

function list(s) {
  return s ? s.split(',').map(x => x.trim()).filter(Boolean) : [];
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { working: null, progress: null, next: null, positional: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--working' && args[i + 1]) { out.working = args[++i]; continue; }
    if (args[i] === '--progress' && args[i + 1]) { out.progress = args[++i]; continue; }
    if (args[i] === '--next' && args[i + 1]) { out.next = args[++i]; continue; }
    out.positional.push(args[i]);
  }
  out.summary = out.positional.join(' ').trim();
  return out;
}

const { summary: rawSummary, working, progress, next } = parseArgs();
const summary = rawSummary || fs.readFileSync(0, 'utf8').trim();

if (!summary) {
  console.error('Usage: session-wrap-cursor.js [--working a,b] [--progress c] [--next t1,t2] "summary text"');
  process.exit(1);
}

function syncCursorState(note) {
  if (!fs.existsSync(CURSOR_STATE)) return;

  let content = fs.readFileSync(CURSOR_STATE, 'utf8');
  content = content.replace(/## Last updated\n.+/, `## Last updated\n${today}`);

  const activeMatch = content.match(/## Active work\n([\s\S]*?)(?=\n## |$)/);
  const activeLines = activeMatch?.[1]?.split('\n') || [];
  let workingVal = working !== null ? list(working).join(', ') || 'none' : null;
  let progressVal = progress !== null ? list(progress).join(', ') || 'none' : null;

  for (const line of activeLines) {
    if (workingVal === null && line.startsWith('- Working:')) {
      workingVal = line.replace('- Working:', '').trim();
    }
    if (progressVal === null && line.startsWith('- In progress:')) {
      progressVal = line.replace('- In progress:', '').trim();
    }
  }

  const blockedLine = activeLines.find(l => l.startsWith('- Blocked:'))
    || '- Blocked: none (see shared state.md for project-wide blockers)';

  const activeBlock = [
    '## Active work',
    `- Working: ${workingVal || 'none'}`,
    `- In progress: ${progressVal || 'none'}`,
    blockedLine,
  ].join('\n');
  content = content.replace(/## Active work\n[\s\S]*?(?=\n## )/, `${activeBlock}\n`);

  if (next !== null) {
    const items = list(next);
    const nextBlock = [
      '## Next tasks (Cursor priority)',
      ...items.map((item, i) => {
        const parts = item.split('—').map(s => s.trim());
        const title = parts[0];
        const detail = parts.slice(1).join(' — ');
        return detail
          ? `${i + 1}. **${title}** — ${detail}`
          : `${i + 1}. **${title}**`;
      }),
    ].join('\n');
    content = content.replace(
      /## Next tasks \(Cursor priority\)\n[\s\S]*?(?=\n## )/,
      `${nextBlock}\n`,
    );
  }

  content = content.replace(
    /## Last session\n[\s\S]*?(?=\n## |$)/,
    `## Last session\n${note}\n`,
  );

  fs.writeFileSync(CURSOR_STATE, content);
}

// ── 1. Cursor-only session.md ────────────────────────────────────────────────

let text = fs.existsSync(SESSION) ? fs.readFileSync(SESSION, 'utf8') : '';

text = text.replace(/\*\*Last updated:\*\* .+/, `**Last updated:** ${today}`);
const bullet = `- ${summary}`;
if (text.includes('## Last session summary')) {
  const section = text.match(/## Last session summary\n([\s\S]*?)(?=\n## |$)/);
  const existing = section?.[1]?.trim().split('\n').filter(l => l.startsWith('-')) || [];
  const updated = [bullet, ...existing].slice(0, 5).join('\n');
  text = text.replace(
    /## Last session summary\n[\s\S]*?(?=\n## |$)/,
    `## Last session summary\n${updated}\n`,
  );
} else {
  text += `\n## Last session summary\n${bullet}\n`;
}

const histLine = `- ${today} — ${summary.slice(0, 120)}`;
if (text.includes('## History')) {
  text = text.replace(/(## History\n)/, `$1${histLine}\n`);
} else {
  text += `\n## History\n${histLine}\n`;
}

fs.mkdirSync(path.dirname(SESSION), { recursive: true });
fs.writeFileSync(SESSION, text);

// ── 2. Cursor task state (not shared state.md) ───────────────────────────────

syncCursorState(summary);

// ── 3. Shared .agents/sessions/cursor-YYYY-MM-DD.md ─────────────────────────

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const entry = [
  `## ${timeStamp}`,
  summary,
  '',
].join('\n');

if (fs.existsSync(dayFile)) {
  fs.appendFileSync(dayFile, entry);
} else {
  fs.writeFileSync(dayFile, `# Cursor Session — ${today}\n\n${entry}`);
}

// ── 4. INDEX.md ───────────────────────────────────────────────────────────────

const indexLine = `- [${sessionFileName.replace('.md', '')}](${sessionFileName}) — ${summary.slice(0, 120)}`;

if (!fs.existsSync(INDEX_FILE)) {
  fs.writeFileSync(
    INDEX_FILE,
    `# Session Index\n\n` +
    `Cursor sessions: \`.agents/sessions/cursor-YYYY-MM-DD.md\`\n` +
    `Claude sessions: \`.agents/sessions/YYYY-MM-DD.md\`\n` +
    `Pre-2026-06-08: \`.claude/docs/session-history.md\`\n\n` +
    `${indexLine}\n`,
  );
} else {
  let idx = fs.readFileSync(INDEX_FILE, 'utf8');

  if (!idx.includes('cursor-YYYY-MM-DD')) {
    idx = idx.replace(
      /Full detail for each date at `.agents\/sessions\/YYYY-MM-DD.md`\./,
      'Cursor sessions: `.agents/sessions/cursor-YYYY-MM-DD.md` · Claude: `.agents/sessions/YYYY-MM-DD.md`',
    );
  }

  const re = new RegExp(`^- \\[cursor-${today.replace(/[-]/g, '[-]')}\\].*$`, 'm');
  idx = re.test(idx)
    ? idx.replace(re, indexLine)
    : idx.replace(/(\n\n)(- \[)/, `\n\n${indexLine}\n$2`);

  fs.writeFileSync(INDEX_FILE, idx);
}

console.log(`Updated ${SESSION}`);
console.log(`Synced ${CURSOR_STATE}`);
console.log(`Appended ${dayFile}`);
