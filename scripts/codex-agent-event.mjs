#!/usr/bin/env node
// Codex lifecycle adapter: metadata only. Never persist prompts, commands, results or paths.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
try {
  const p = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const events = { SessionStart: 'session-start', UserPromptSubmit: 'prompt', PreToolUse: 'tool', PostToolUse: 'tool', PermissionRequest: 'waiting', Stop: 'stop', SessionEnd: 'session-end', Interrupt: 'stop', SubagentStart: 'sub-start', SubagentStop: 'sub-stop' };
  const event = events[p.hook_event_name];
  if (event) {
    const tool = String(p.tool_name ?? '');
    const command = String(p.tool_input?.command ?? p.tool_input?.cmd ?? '');
    const kind = /apply_patch|^(Edit|Write)$/.test(tool) ? 'code'
      : /WebSearch|WebFetch|web.*run/.test(tool) ? 'web'
      : /^(Read|Grep|Glob|LS)$|codegraph/.test(tool) || /^\s*(cat|head|tail|rg|ls|sed|find)\b/.test(command) ? 'reading'
      : 'other';
    const session = createHash('sha256').update(String(p.session_id ?? p.thread_id ?? 'unknown')).digest('hex').slice(0, 20);
    const row = { t: new Date().toISOString(), agent: 'codex', event, session,
      ...(event === 'tool' ? { kind, tool: kind === 'code' ? 'Edit' : kind === 'reading' ? 'Read' : 'Codex tool', detail: `${kind} action` } : { detail: event === 'prompt' ? 'Working on the requested task' : event }) };
    // Only completion events count as actions; pre-tool keeps long calls observable without double-counting.
    if (p.hook_event_name === 'PreToolUse') row.event = 'activity';
    if (event === 'sub-start' || event === 'sub-stop') {
      // Parent session remains shared; the helper identifier must not be persisted raw.
      row.sub = createHash('sha256').update(`${session}:${String(p.agent_id ?? 'unknown')}`).digest('hex').slice(0, 20);
      row.subType = 'Codex helper';
    }
    const response = p.tool_response;
    if (p.hook_event_name === 'PostToolUse' && response && typeof response === 'object'
      && (response.isError === true || response.is_error === true
        || (typeof response.exit_code === 'number' && response.exit_code !== 0))) row.event = 'fail';
    const dir = join(homedir(), '.fildi');
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, 'agent-events.jsonl'), JSON.stringify(row) + '\n');
  }
} catch { /* Observability must not interrupt work. */ }
// Stop hooks accept a JSON object; never return a permission decision.
process.stdout.write('{}\n');
