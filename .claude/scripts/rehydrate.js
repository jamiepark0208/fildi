#!/usr/bin/env node
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const ROOT  = path.resolve(__dirname, '../../');
const STATE = path.join(ROOT, '.claude/state.json');
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch { return { phase:'scaffold', working:[], in_progress:[], blocked:[], next:['replit-setup','data-layer','watchlist-ui'], last_session:null, instincts:[] }; }
}
function git() {
  try {
    return {
      log:  execSync('git log --oneline -5 2>/dev/null', { cwd:ROOT }).toString().trim(),
      diff: execSync('git status --short 2>/dev/null', { cwd:ROOT }).toString().trim() || 'clean'
    };
  } catch { return { log:'no git', diff:'' }; }
}
const s = readState(), g = git(), D = '─'.repeat(52);
console.log(`\n${D}\n🔄  TRADEDASH SESSION RESTORED\n${D}`);
console.log(`Phase:       ${s.phase}`);
console.log(`Working:     ${(s.working||[]).join(', ')||'none'}`);
console.log(`In progress: ${(s.in_progress||[]).join(', ')||'none'}`);
console.log(`Blocked:     ${(s.blocked||[]).join(', ')||'none'}`);
console.log(`Next:        ${(s.next||[]).join(', ')||'tbd'}`);
if (s.last_session) console.log(`Last:        ${s.last_session}`);
console.log(`${D}\nGit:\n${g.log}\nTree: ${g.diff}`);
if (s.instincts?.length) { console.log(`${D}\nInstincts:`); s.instincts.forEach(i => console.log(`  • ${i}`)); }
console.log(`${D}`);
console.log(`Skills  → cat .claude/skills/<name>.md`);
console.log(`Models  → haiku=data  sonnet=logic/UI  opus=/opus only`);
console.log(`Agents  → verifier | data-agent | ui-agent`);
console.log(`${D}`);
// Sync codegraph index and show status
try {
  const status = execSync('codegraph status 2>/dev/null', { cwd:ROOT }).toString();
  const filesLine  = status.match(/Files:\s+([\d,]+)/);
  const nodesLine  = status.match(/Nodes:\s+([\d,]+)/);
  const edgesLine  = status.match(/Edges:\s+([\d,]+)/);
  const upToDate   = status.includes('up to date');
  console.log(`Codegraph: ${filesLine?.[1]??'?'} files · ${nodesLine?.[1]??'?'} nodes · ${edgesLine?.[1]??'?'} edges · ${upToDate ? 'up to date ✓' : 'synced'}`);
  console.log(`Next:      codegraph context "<task>" — get relevant files before reading anything`);
} catch {
  console.log(`Codegraph: not available (run: codegraph sync)`);
}
// Auto-start API server if not running
try {
  const http = require('http');
  const req = http.get('http://localhost:8080/api/daily-brief', { timeout: 2000 }, (res) => {
    console.log(`API server: ✓ running (HTTP ${res.statusCode})`);
    console.log(`${D}\n`);
  });
  req.on('error', () => {
    console.log(`API server: ✗ not running — starting now...`);
    const { spawn } = require('child_process');
    const child = spawn('bash', ['/home/runner/workspace/artifacts/api-server/start.sh'], {
      detached: true, stdio: 'ignore'
    });
    child.unref();
    console.log(`API server: started (PID ${child.pid}) — check /tmp/api-server.log`);
    console.log(`${D}\n`);
  });
  req.on('timeout', () => {
    req.destroy();
  });
} catch (e) {
  console.log(`API server check failed: ${e.message}`);
  console.log(`${D}\n`);
}
