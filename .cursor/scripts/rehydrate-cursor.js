#!/usr/bin/env node
/**
 * Cursor session rehydrate — prints banner from .cursor/context/cursor-state.md
 * Usage: node .cursor/scripts/rehydrate-cursor.js
 *        node .cursor/scripts/rehydrate-cursor.js --json  (for sessionStart hook)
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '../..');
const CURSOR_STATE = path.join(ROOT, '.cursor/context/cursor-state.md');
const CURSOR_SESSION = path.join(ROOT, '.cursor/context/session.md');

function readCursorSession() {
  try {
    const text = fs.readFileSync(CURSOR_SESSION, 'utf8');
    const notes = text.match(/## Notes for next Cursor session\n([\s\S]*?)(?=\n## |$)/)?.[1]
      ?.split('\n').filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '').trim()).slice(0, 2) || [];
    const last = text.match(/## Last session summary\n([\s\S]*?)(?=\n## |$)/)?.[1]
      ?.split('\n').find(l => l.startsWith('-'))?.replace(/^-\s*/, '').trim();
    return { notes, last };
  } catch {
    return { notes: [], last: null };
  }
}

function readCursorState() {
  try {
    const text = fs.readFileSync(CURSOR_STATE, 'utf8');
    const phase = text.match(/## Phase\s*\n\*\*([^*]+)\*\*/)?.[1]?.trim() || 'unknown';
    const active = text.match(/## Active work\s*\n([\s\S]*?)(?=\n## |$)/)?.[1]
      ?.split('\n').filter(l => l.startsWith('-')).map(l => l.replace(/^-\s*/, '').trim()) || [];
    const tasks = [...text.matchAll(/^\d+\.\s+(.+)$/gm)].map(m => m[1].trim()).slice(0, 3);
    return { phase, active, tasks };
  } catch {
    return { phase: 'unknown', active: [], tasks: [] };
  }
}

function git() {
  try {
    const log = execSync('git log --oneline -1 2>/dev/null', { cwd: ROOT }).toString().trim();
    const diff = execSync('git status --short 2>/dev/null', { cwd: ROOT })
      .toString().split('\n').filter(l => l.match(/^[MADR?]/)).length;
    return { log, dirty: diff };
  } catch {
    return { log: 'no git', dirty: 0 };
  }
}

function codegraph() {
  try {
    const out = execSync('codegraph status 2>/dev/null', { cwd: ROOT }).toString();
    const files = out.match(/Files:\s+([\d,]+)/)?.[1] ?? '?';
    const ok = out.includes('up to date') ? 'up to date' : 'needs sync';
    return `${files} files · ${ok}`;
  } catch {
    return 'unavailable';
  }
}

function buildBanner() {
  const s = readCursorState();
  const c = readCursorSession();
  const g = git();
  const planPath = '.cursor/context/plans/fundamental-sector-scoring-v1.md';
  const lines = [
    `TRADEDASH (Cursor) | Phase: ${s.phase}`,
    s.tasks.length ? `Next: ${s.tasks.join(', ')}` : null,
    c.last ? `Last Cursor session: ${c.last}` : null,
    s.active.length ? s.active.join(' | ') : null,
    `Git: ${g.log}${g.dirty ? ` | ${g.dirty} changed` : ' | clean'}`,
    `Codegraph: ${codegraph()}`,
    `Plan: ${planPath} · State: .cursor/context/cursor-state.md`,
  ].filter(Boolean);
  return lines.join('\n');
}

const banner = buildBanner();
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({
    additional_context: `[Session context]\n${banner}\n\nFollow CURSOR.md. Fundamental scoring: READ .cursor/context/plans/fundamental-sector-scoring-v1.md — score vs peer_group_members in DB, NEVER vs user watchlist or FUNDAMENTAL_WATCHLIST (31-name legacy hack).`,
  }));
} else {
  console.log(`\n${banner}\n`);
}
