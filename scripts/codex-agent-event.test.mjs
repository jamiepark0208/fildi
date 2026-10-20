import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('Codex events retain lifecycle and identity without sensitive payloads', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-events-'));
  try {
    for (const hook_event_name of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Stop']) {
      const result = spawnSync(process.execPath, ['scripts/codex-agent-event.mjs'], { env: { ...process.env, HOME: home, CURSOR_TEST: '1' }, input: JSON.stringify({ hook_event_name, session_id: 'private-session', tool_name: 'apply_patch', prompt: 'PRIVATE PORTFOLIO', tool_input: { command: 'PRIVATE SECRET' }, tool_response: 'PRIVATE OUTPUT' }) });
      assert.equal(result.status, 0);
    }
    const raw = readFileSync(join(home, '.fildi/agent-events.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /PRIVATE|private-session/);
    const rows = raw.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r => r.event), ['prompt', 'activity', 'tool', 'waiting', 'stop']);
    assert.ok(rows.every(r => r.agent === 'codex'));
    assert.equal(rows[2].kind, 'code');
    assert.equal(new Set(rows.map(r => r.session)).size, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('helper identifiers and failure payloads remain private', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-events-'));
  try {
    for (const payload of [
      {hook_event_name:'SubagentStart', agent_id:'PRIVATE-ID', agent_type:'PRIVATE-TASK'},
      {hook_event_name:'PostToolUse', tool_name:'mcp__local__read', tool_response:{exit_code:1, text:'PRIVATE-OUTPUT'}},
      {hook_event_name:'SubagentStop', agent_id:'PRIVATE-ID', last_assistant_message:'PRIVATE-ANSWER'},
    ]) {
      const result = spawnSync(process.execPath, ['scripts/codex-agent-event.mjs'], {env:{...process.env, HOME:home}, input:JSON.stringify({...payload,session_id:'PRIVATE-SESSION'})});
      assert.equal(result.status, 0);
      assert.deepEqual(JSON.parse(result.stdout.toString()), {});
    }
    const raw = readFileSync(join(home, '.fildi/agent-events.jsonl'), 'utf8');
    assert.doesNotMatch(raw, /PRIVATE/);
    const rows = raw.trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(r=>r.event), ['sub-start','fail','sub-stop']);
    assert.equal(rows[0].sub, rows[2].sub);
    assert.equal(rows[0].subType, 'Codex helper');
    assert.equal(rows[1].kind, 'other');
  } finally { rmSync(home, {recursive:true, force:true}); }
});
