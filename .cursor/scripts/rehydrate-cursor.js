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

/** Recent browser crashes → agents fix without Jamie re-reporting. */
function uiCrashes() {
  try {
    const p = path.join(require('os').homedir(), '.fildi', 'ui-crashes.jsonl');
    if (!fs.existsSync(p)) return null;
    const cutoff = Date.now() - 48 * 3600 * 1000;
    const rows = fs.readFileSync(p, 'utf8').trim().split('\n').slice(-40)
      .map((ln) => { try { return JSON.parse(ln); } catch { return null; } })
      .filter((j) => j && j.t && Date.parse(j.t) >= cutoff);
    if (!rows.length) return 'UI crashes 48h: 0';
    const last = rows[rows.length - 1];
    const msg = String(last.message || '').slice(0, 60);
    return `UI crashes 48h: ${rows.length} — last: ${msg} @ ${last.path || '?'} → fix now`;
  } catch {
    return null;
  }
}

function buildBanner() {
  const s = readCursorState();
  const c = readCursorSession();
  const g = git();
  const planPath = '.agents/context/plans/fundamental-sector-scoring.md';
  const lines = [
    `TRADEDASH (Cursor) | Phase: ${s.phase}`,
    s.tasks.length ? `Next: ${s.tasks.join(', ')}` : null,
    c.last ? `Last Cursor session: ${c.last}` : null,
    s.active.length ? s.active.join(' | ') : null,
    uiCrashes(),
    `Git: ${g.log}${g.dirty ? ` | ${g.dirty} changed` : ' | clean'}`,
    `Codegraph: ${codegraph()}`,
    `Plan: ${planPath} · State: .cursor/context/cursor-state.md`,
  ].filter(Boolean);
  return lines.join('\n');
}

const banner = buildBanner();
if (process.argv.includes('--json')) {
  process.stdout.write(JSON.stringify({
    additional_context: `[Session context]\n${banner}\n\nFollow AGENTS.md + CURSOR.md + .agents/context/INDEX.md. After plan confirmation, execute (do not stay plan-only). Sector scoring: READ .agents/context/plans/fundamental-sector-scoring.md — score vs primary_peer_group_id / peer_group_members, NEVER vs user watchlist. FUNDAMENTAL_WATCHLIST is removed from code (do not re-add).`,
  }));
} else {
  console.log(`\n${banner}\n`);
}
