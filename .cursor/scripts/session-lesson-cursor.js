#!/usr/bin/env node
/**
 * Manage Cursor lessons (mistake → guardrail).
 *
 * Usage:
 *   node .cursor/scripts/session-lesson-cursor.js list
 *   node .cursor/scripts/session-lesson-cursor.js grep "cache"
 *   node .cursor/scripts/session-lesson-cursor.js add \
 *     --title "short title" \
 *     --trigger "when to apply" \
 *     --mistake "what went wrong" \
 *     --fix "guardrail" \
 *     [--verify "how to confirm"]
 *
 * Max 15 active lessons in lessons.md — oldest active archived automatically.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const LESSONS = path.join(ROOT, '.cursor/context/lessons.md');
const ARCHIVE = path.join(ROOT, '.cursor/context/lessons-archive.md');
const MAX_ACTIVE = 15;

function readFile(p) {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
}

function writeFile(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

function splitEntries(text) {
  const headerEnd = text.indexOf('---\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd + 4) : '';
  const body = headerEnd >= 0 ? text.slice(headerEnd + 4) : text;
  const chunks = body.split(/\n(?=### L-)/).filter(Boolean);
  return { header, entries: chunks };
}

function parseEntry(chunk) {
  const id = chunk.match(/^### (L-\d{4}-\d{2}-\d{2}-\d+):/)?.[1] ?? null;
  const status = chunk.match(/\*\*Status:\*\* (.+)/)?.[1]?.trim() ?? 'active';
  return { id, status, chunk: chunk.trim() + '\n' };
}

function nextId(entries) {
  const today = new Date().toISOString().slice(0, 10);
  const prefix = `L-${today}-`;
  const nums = entries
    .map(e => e.id)
    .filter(id => id?.startsWith(prefix))
    .map(id => parseInt(id.split('-').pop(), 10))
    .filter(n => !Number.isNaN(n));
  const n = nums.length ? Math.max(...nums) + 1 : 1;
  return `${prefix}${String(n).padStart(2, '0')}`;
}

function rebuild(header, entries) {
  return header + '\n' + entries.map(e => e.chunk).join('\n');
}

function cmdList() {
  const { entries } = splitEntries(readFile(LESSONS));
  const active = entries.filter(e => parseEntry(e).status.startsWith('active'));
  if (!active.length) {
    console.log('No active lessons.');
    return;
  }
  for (const chunk of active) {
    const { id } = parseEntry(chunk);
    const title = chunk.match(/^### L-[^:]+:\s*(.+)$/m)?.[1]?.trim() ?? '';
    const trigger = chunk.match(/\*\*Trigger:\*\* (.+)/)?.[1] ?? '';
    console.log(`${id}  ${title}`);
    console.log(`       ${trigger}`);
  }
  console.log(`\n${active.length}/${MAX_ACTIVE} active`);
}

function cmdGrep(query) {
  if (!query) {
    console.error('Usage: session-lesson-cursor.js grep "keyword"');
    process.exit(1);
  }
  const text = readFile(LESSONS);
  const re = new RegExp(query, 'i');
  const { entries } = splitEntries(text);
  const hits = entries.filter(e => re.test(e));
  if (!hits.length) {
    console.log(`No lessons matching "${query}"`);
    return;
  }
  process.stdout.write(hits.join('\n'));
}

function cmdAdd(args) {
  const { title, trigger, mistake, fix, verify } = args;
  if (!title || !trigger || !mistake || !fix) {
    console.error('Required: --title --trigger --mistake --fix');
    process.exit(1);
  }

  let text = readFile(LESSONS);
  if (!text.includes('# Cursor Lessons')) {
    console.error('lessons.md missing or corrupt — restore from repo');
    process.exit(1);
  }

  const { header, entries: rawEntries } = splitEntries(text);
  let entries = rawEntries.map(chunk => parseEntry(chunk));

  // Duplicate check on title/trigger
  const dupe = entries.find(e =>
    e.chunk.toLowerCase().includes(title.toLowerCase()) ||
    e.chunk.includes(trigger),
  );
  if (dupe) {
    console.error(`Likely duplicate of ${dupe.id} — not adding.`);
    process.exit(1);
  }

  const id = nextId(entries);
  const block = `### ${id}: ${title}
- **Trigger:** ${trigger}
- **Mistake:** ${mistake}
- **Fix:** ${fix}
${verify ? `- **Verify:** ${verify}\n` : ''}- **Status:** active
`;
  entries.push(parseEntry(block));

  // Archive oldest active if over cap
  const active = entries.filter(e => e.status.startsWith('active'));
  if (active.length > MAX_ACTIVE) {
    const oldest = active[0];
    oldest.chunk = oldest.chunk.replace(
      /\*\*Status:\*\* active/,
      `**Status:** deprecated ${new Date().toISOString().slice(0, 10)} auto-archived (cap ${MAX_ACTIVE})`,
    );
    const archiveText = readFile(ARCHIVE);
    const archiveBody = archiveText.includes('_No archived')
      ? archiveText.replace('_No archived entries yet._', `\n${oldest.chunk}`)
      : archiveText + '\n' + oldest.chunk;
    writeFile(ARCHIVE, archiveBody);
    console.log(`Archived ${oldest.id} → lessons-archive.md`);
  }

  writeFile(LESSONS, rebuild(header, entries));
  console.log(`Added ${id}: ${title}`);
  console.log(id);
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] ?? 'list';

if (cmd === 'list') cmdList();
else if (cmd === 'grep') cmdGrep(args._[1] ?? args.query);
else if (cmd === 'add') cmdAdd(args);
else {
  console.error('Commands: list | grep | add');
  process.exit(1);
}
