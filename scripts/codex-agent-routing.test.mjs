import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { detectInboxAgent } from '../.agents/hooks/needs-inbox.mjs';
// Exercise the real route's pure parsing functions, without booting the API or connecting to portfolio DB.
const source = readFileSync('artifacts/api-server/src/routes/agents.ts', 'utf8');
const ast = ts.createSourceFile('agents.ts', source, ts.ScriptTarget.Latest, true);
const names = new Set(['sessionActivity', 'subagents', 'NAMES', 'who', 'ideaAssignee', 'ideaPhase', 'ideaBlurb', 'ideaReviews', 'normalizeTouchDate', 'ideaTouch', 'asks']);
const selected = ast.statements.filter(n => names.has(n.name?.text) || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.has(d.name.getText(ast)))).map(n => n.getText(ast)).join('\n');
const fixtures = '| [A999](asks/A999.md) | 2026-10-19 | Claude → Codex | Integration | accepted (Codex 10-19: in progress) |\n| [A998](asks/A998.md) | 2026-10-19 | Muse → Cursor | Existing | open |';
const context = vm.createContext({ ROOT: '.', resolve: (...parts) => parts.join('/'), readFileSync: path => path.endsWith('ASKS.md') ? fixtures : '', Date });
vm.runInContext(ts.transpile(selected, { target: ts.ScriptTarget.ES2022 }), context);
test('Codex ideas retain their owner; existing Muse review routing stays intact', () => {
  const data = vm.runInContext('asks()', context);
  assert.equal(data.ideas.find(i => i.id === 'A999').assignee, 'codex');
  assert.equal(data.ideas.find(i => i.id === 'A999').touchedBy, 'codex');
  assert.equal(data.ideas.find(i => i.id === 'A998').assignee, 'claude');
  assert.equal(data.queue.codex, 1);
  assert.equal(vm.runInContext('who("CODEX")', context), 'codex');
});
test('explicit Codex inbox identity never claims Claude inbox', () => {
  assert.equal(detectInboxAgent({CURSOR_TEST:'1'}, {}, ['node', 'x', '--agent=codex']), 'codex');
  assert.equal(detectInboxAgent({FILDI_AGENT:'codex'}, {}, ['node', 'x']), 'codex');
});

test('one session ending cannot hide another session working or waiting', () => {
  context.now = Date.now();
  context.events = [
    {session:'a', event:'tool', t:new Date(context.now-1000).toISOString()},
    {session:'b', event:'stop', t:new Date(context.now).toISOString()},
  ];
  assert.equal(vm.runInContext('sessionActivity(events, now).working', context), true);
  context.events.push({session:'c', event:'waiting', t:new Date(context.now).toISOString()});
  assert.equal(vm.runInContext('sessionActivity(events, now).waiting', context), true);
  assert.equal(vm.runInContext('sessionActivity(events, now).working', context), true);
  context.events.push({session:'a', event:'session-end', t:new Date(context.now).toISOString()});
  assert.equal(vm.runInContext('sessionActivity(events, now).working', context), false);
  context.events.push({session:'c', sub:'helper', event:'tool', t:new Date(context.now).toISOString()});
  assert.equal(vm.runInContext('sessionActivity(events, now).waiting', context), true);
});
test('Codex helper lifecycle appears and stops in Stage data', () => {
  context.now = Date.now();
  context.events = [{agent:'codex', session:'parent', sub:'hashed-id', subType:'Codex helper', event:'sub-start', t:new Date(context.now).toISOString()}];
  assert.equal(vm.runInContext('subagents(events, now)[0].running', context), true);
  context.events.push({...context.events[0], event:'sub-stop'});
  assert.equal(vm.runInContext('subagents(events, now)[0].running', context), false);
});
