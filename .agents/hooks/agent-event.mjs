#!/usr/bin/env node
// Agent event log (user 2026-10-15): one JSON line per agent action → ~/.fildi/agent-events.jsonl → Settings › Agents
// ("working now", activity, per-session tool counts). Called by Claude Code + Cursor hooks:  agent-event.mjs <agent> <event>
// Never blocks, never prints (some hook stdout is fed back to the agent), always exits 0.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
try {
  const [agent = "unknown", event = "event"] = process.argv.slice(2);
  let p = {};
  try { p = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
  const file = p.tool_input?.file_path ?? p.file_path ?? p.tool_input?.path;
  const detail = p.tool_input?.command ?? p.tool_input?.description ?? p.command ?? (file ? String(file).split("/").slice(-2).join("/") : undefined);
  const row = {
    t: new Date().toISOString(), agent, event,
    tool: p.tool_name ?? p.hook_event_name ?? undefined,
    session: p.session_id ?? p.conversation_id ?? undefined,
    detail: detail ? String(detail).replace(/\s+/g, " ").slice(0, 140) : undefined,
    transcript: event === "stop" || event === "session-start" ? p.transcript_path : undefined,
  };
  const dir = join(homedir(), ".fildi");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "agent-events.jsonl"), JSON.stringify(row) + "\n");
} catch { /* logging must never break an agent */ }
process.exit(0);
