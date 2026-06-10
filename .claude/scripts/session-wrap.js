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
console.log(`✅ State saved at ${now}`);
console.log(JSON.stringify(next, null, 2));
