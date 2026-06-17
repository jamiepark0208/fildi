#!/usr/bin/env node
/**
 * Update Cursor-only session context.
 * Usage:
 *   node .cursor/scripts/session-wrap-cursor.js "one-line summary of what we did"
 *   node .cursor/scripts/session-wrap-cursor.js   (interactive — reads stdin lines until EOF)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const SESSION = path.join(ROOT, '.cursor/context/session.md');
const today = new Date().toISOString().slice(0, 10);

const summary = process.argv.slice(2).join(' ').trim()
  || fs.readFileSync(0, 'utf8').trim();

if (!summary) {
  console.error('Usage: session-wrap-cursor.js "summary text"');
  process.exit(1);
}

let text = fs.existsSync(SESSION) ? fs.readFileSync(SESSION, 'utf8') : '';

// Update last-updated and last session summary
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

// Append history line
const histLine = `- ${today} — ${summary.slice(0, 120)}`;
if (text.includes('## History')) {
  text = text.replace(/(## History\n)/, `$1${histLine}\n`);
} else {
  text += `\n## History\n${histLine}\n`;
}

fs.mkdirSync(path.dirname(SESSION), { recursive: true });
fs.writeFileSync(SESSION, text);
console.log(`Updated ${SESSION}`);
