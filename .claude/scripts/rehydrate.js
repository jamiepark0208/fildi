#!/usr/bin/env node
const fs   = require('fs');
const path = require('path');
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
      diff: execSync('git status --short 2>/dev/null', { cwd:ROOT })
              .toString().split('\n').filter(l => l.match(/^[MADR]/)).join('\n').trim() || 'clean'
    };
  } catch { return { log:'no git', diff:'clean' }; }
}

const s = readState(), g = git();
const active = [
  s.working?.length    && `Working: ${s.working.join(', ')}`,
  s.in_progress?.length && `In progress: ${s.in_progress.join(', ')}`,
  s.blocked?.length    && `Blocked: ${s.blocked.join(', ')}`,
].filter(Boolean);

console.log(`\n🔄 TRADEDASH | Phase: ${s.phase} | Next: ${(s.next||[]).slice(0,3).join(', ')||'tbd'}`);
if (active.length) console.log(active.join(' | '));
if (s.last_session) console.log(`Last: ${s.last_session}`);
console.log(`Git: ${g.log.split('\n')[0]} ${g.diff !== 'clean' ? `| Changes: ${g.diff}` : '| clean'}`);
if (g.log.includes('\n')) console.log(`     ${g.log.split('\n')[1]}`);
if (s.instincts?.length) console.log(`Instincts: ${s.instincts.join(' · ')}`);

try {
  const status = execSync('codegraph status 2>/dev/null', { cwd:ROOT }).toString();
  const f = status.match(/Files:\s+([\d,]+)/)?.[1] ?? '?';
  const n = status.match(/Nodes:\s+([\d,]+)/)?.[1] ?? '?';
  console.log(`Codegraph: ${f} files · ${n} nodes · ${status.includes('up to date') ? 'up to date ✓' : 'synced'}`);
} catch { console.log(`Codegraph: unavailable`); }

try {
  const http = require('http');
  const req = http.get('http://localhost:8080/api/daily-brief', { timeout: 2000 }, (res) => {
    console.log(`API: ✓ HTTP ${res.statusCode}\n`);
  });
  req.on('error', () => {
    const { spawn } = require('child_process');
    const child = spawn('bash', ['/home/runner/workspace/artifacts/api-server/start.sh'], { detached: true, stdio: 'ignore' });
    child.unref();
    console.log(`API: ✗ starting (PID ${child.pid})\n`);
  });
  req.on('timeout', () => req.destroy());
} catch (e) { console.log(`API: check failed\n`); }
