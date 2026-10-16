#!/usr/bin/env node
// Agent event log (user 2026-10-15): one JSON line per agent action → ~/.fildi/agent-events.jsonl → Settings › Agents
// ("working now", activity, per-session tool counts). Called by Claude Code + Cursor hooks:  agent-event.mjs <agent> <event>
// Never blocks, never prints (some hook stdout is fed back to the agent), always exits 0.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
try {
  const [argAgent = "unknown", event = "event"] = process.argv.slice(2);
  // Cursor also runs .claude/settings hooks → it arrives as "claude"; detect Cursor by env / transcript path.
  const inCursor = Object.keys(process.env).some((k) => k.startsWith("CURSOR_")) || /\/\.cursor\//.test(String(process.env.CLAUDE_TRANSCRIPT_PATH ?? ""));
  let p = {};
  try { p = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
  const agent = inCursor || /\/\.cursor\//.test(String(p.transcript_path ?? "")) || p.cursor_version ? "cursor" : argAgent;
  const file = p.tool_input?.file_path ?? p.file_path ?? p.tool_input?.path;
  // Prefer short human labels — never dump raw shell (Settings › Agents was unreadable).
  const desc = p.tool_input?.description ?? p.description;
  const cmd = p.tool_input?.command ?? p.command;
  let detail = desc || (file ? String(file).split("/").slice(-2).join("/") : undefined);
  if (!detail && cmd) {
    const c = String(cmd).replace(/\s+/g, " ").trim();
    detail = c.length > 60 || /\n|&&|\|/.test(c) ? "ran a command" : c;
  }
  const row = {
    t: new Date().toISOString(), agent, event,
    tool: p.tool_name ?? p.hook_event_name ?? undefined,
    session: p.session_id ?? p.conversation_id ?? undefined,
    detail: detail ? String(detail).replace(/\s+/g, " ").slice(0, 100) : undefined,
    transcript: event === "stop" || event === "session-start" ? p.transcript_path : undefined,
  };
  const dir = join(homedir(), ".fildi");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "agent-events.jsonl"), JSON.stringify(row) + "\n");
} catch { /* logging must never break an agent */ }
process.exit(0);
