#!/usr/bin/env node
// UserPromptSubmit hook. Runs on EVERY prompt for two reasons that must survive
// any refactor: (1) the API self-heal probe below restarts a dead server, and
// (2) state must survive auto-compact (fires at 45%). But injecting the FULL
// ~2.5KB block every prompt cost ~450 wasted tokens/prompt of repetition, so
// output is now delta-based:
//   FULL block  — first prompt of a session, every 10th prompt after (bounds
//                 staleness across auto-compact), or whenever state.json
//                 changed (new instincts/phase reappear immediately).
//   MINIMAL line — all other prompts (phase + next + change count + API).
// Session tracked via marker file keyed on the hook's stdin session_id.
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const ROOT  = path.resolve(__dirname, '../../');
const STATE = path.join(ROOT, '.claude/state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { phase:'scaffold', working:[], in_progress:[], blocked:[], next:[], last_session:null, instincts:[] }; }
}

function git() {
  try {
    return {
      log:  execSync('git log --oneline -2 2>/dev/null', { cwd:ROOT }).toString().trim(),
      // status codes occupy cols 0-1 (staged, unstaged) — e.g. " M" is an unstaged
      // modify. Matching only col 0 (old behavior) missed the common unstaged case.
      diff: execSync('git status --short 2>/dev/null', { cwd:ROOT })
              .toString().split('\n').filter(l => /[MADR]/.test(l.slice(0,2))).join('\n').trim() || 'clean'
    };
  } catch { return { log:'no git', diff:'clean' }; }
}

// ── Session marker: decide full vs minimal emit ──────────────────────────────
let sessionId = 'manual';
try {
  if (!process.stdin.isTTY) {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    if (input.session_id) sessionId = String(input.session_id).replace(/[^a-zA-Z0-9-]/g, '');
  }
} catch { /* manual run or malformed stdin — treat as fresh session */ }

const s = readState(), g = git();
const stateHash = crypto.createHash('md5').update(JSON.stringify(s)).digest('hex').slice(0, 12);
const MARKER = path.join('/tmp', `rehydrate-${sessionId}.json`);
let marker = { n: 0, h: '' };
try { marker = JSON.parse(fs.readFileSync(MARKER, 'utf8')); } catch { /* first prompt */ }
marker.n += 1;
const FULL_EVERY = 10;
const full = marker.n === 1 || (marker.n - 1) % FULL_EVERY === 0 || marker.h !== stateHash;
if (full) marker.h = stateHash;
try { fs.writeFileSync(MARKER, JSON.stringify(marker)); } catch { /* /tmp unwritable — emit full next time too */ }

const changedCount = g.diff === 'clean' ? 0 : g.diff.split('\n').length;
const truncLine = (l, max = 100) => l.length > max ? l.slice(0, max - 3) + '...' : l;

if (full) {
  const active = [
    s.working?.length     && `Working: ${s.working.join(', ')}`,
    s.in_progress?.length && `In progress: ${s.in_progress.join(', ')}`,
    s.blocked?.length     && `Blocked: ${s.blocked.join(', ')}`,
  ].filter(Boolean);

  console.log(`\n🔄 TRADEDASH | Phase: ${s.phase} | Next: ${(s.next||[]).slice(0,3).join(', ')||'tbd'}`);
  if (active.length) console.log(active.join(' | '));
  if (s.last_session) console.log(`Last: ${s.last_session}`);
  console.log(`Git: ${truncLine(g.log.split('\n')[0])} ${g.diff !== 'clean' ? `| Changes: ${g.diff}` : '| clean'}`);
  if (g.log.includes('\n')) console.log(`     ${truncLine(g.log.split('\n')[1])}`);
  if (s.instincts?.length) console.log(`Instincts: ${s.instincts.join(' · ')}`);

  try {
    const status = execSync('codegraph status 2>/dev/null', { cwd:ROOT }).toString();
    const f = status.match(/Files:\s+([\d,]+)/)?.[1] ?? '?';
    const n = status.match(/Nodes:\s+([\d,]+)/)?.[1] ?? '?';
    console.log(`Codegraph: ${f} files · ${n} nodes · ${status.includes('up to date') ? 'up to date ✓' : 'synced'}`);
  } catch { console.log(`Codegraph: unavailable`); }
} else {
  // Minimal: one line. Full state was injected ≤9 prompts ago and is unchanged.
  console.log(`\n🔄 ${s.phase} | Next: ${(s.next||[])[0]||'tbd'} | Changes: ${changedCount} files`);
}

// Playwright probe disabled — user verifies UI manually via Replit preview, so
// this per-prompt check (fs probe + cache file) is dead weight. Re-enable by
// restoring from git history if automated /verify comes back into use.

// API probe + self-heal: ALWAYS runs, even on minimal prompts — this is a
// side effect (supervisor restart), not just context.
try {
  const http = require('http');
  const req = http.get('http://localhost:8080/api/daily-brief', { timeout: 2000 }, (res) => {
    console.log(`API: ✓ HTTP ${res.statusCode}\n`);
  });
  req.on('error', () => {
    // start.sh already runs an infinite crash-restart loop under the Replit
    // workflow supervisor — a failed probe here is often just the ordinary 2s
    // gap between a crash and its own restart, not a dead process. Spawning
    // unconditionally on every failed probe (this hook fires on EVERY prompt)
    // created duplicate orphaned supervisors that crash-loop forever on
    // EADDRINUSE once the real one comes back (incident: 2026-07-10). Only
    // spawn if no supervisor is running at all.
    const { spawn } = require('child_process');
    let alreadyRunning = false;
    try {
      execSync('pgrep -f "artifacts/api-server/start.sh"', { stdio: 'pipe' });
      alreadyRunning = true;
    } catch { /* pgrep exit 1 = no match found */ }
    if (alreadyRunning) {
      console.log(`API: ✗ unreachable, supervisor already running — self-healing\n`);
    } else {
      const child = spawn('bash', ['/home/runner/workspace/artifacts/api-server/start.sh'], { detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`API: ✗ down, starting supervisor (PID ${child.pid})\n`);
    }
  });
  req.on('timeout', () => req.destroy());
} catch (e) { console.log(`API: check failed\n`); }
