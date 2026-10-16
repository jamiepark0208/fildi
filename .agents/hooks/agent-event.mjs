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
  // Activity kind (classified here, where the full command is visible): web · database · api · code · reading · other
  const tool = String(p.tool_name ?? "");
  const full = String(cmd ?? "");
  const kind = event !== "tool" && event !== "edit" && event !== "fail" ? undefined
    : /^(WebSearch|WebFetch)$/.test(tool) ? "web"
    : event === "edit" || /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) ? "code"
    : /^(Read|Grep|Glob|LS)$/.test(tool) || /codegraph/i.test(tool) ? "reading"
    : /^mcp__/.test(tool) ? "api"
    : tool === "Bash" && /\bpsql\b|build_plan|connect\(|\.venv\/bin\/python|analysis\/|SELECT |INSERT |UPDATE |prices_historical|optlab|watchlist_sync\./i.test(full) ? "database"
    : tool === "Bash" && /\bcurl\b|https?:\/\/|wget|fetch\(|polygon|schwab|yahoo|lseg|finnhub|alphavantage/i.test(full) ? "api"
    : tool === "Bash" && /^\s*(cat|head|tail|grep|rg|ls|sed -n|find|wc)\b/.test(full) ? "reading"
    : "other";
  // Git ops in a Bash command (Stage › Code Repo / GitHub links): commit · push · pull/fetch, in order; commit subject if inline
  const git = tool === "Bash" && event !== "fail" ? [...full.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?(commit|push|pull|fetch)\b/g)].map((m) => (m[1] === "fetch" ? "pull" : m[1])) : [];
  const gitMsg = git.includes("commit") ? (full.match(/-m\s+["']([^"'\n]{1,200})/)?.[1] ?? "").slice(0, 60) || undefined : undefined;
  // Prompt / notification text = "what it's doing" / "why it's waiting" (local file only; first 80 chars).
  if (event === "prompt" && p.prompt) detail = String(p.prompt);
  if (event === "waiting" && p.message) detail = String(p.message);
  if (event === "fail") detail = `${detail || tool || "action"} failed${p.error ? `: ${String(p.error).split("\n")[0]}` : ""}`;
  // Loop signature: tool + full input, hashed (labels like "ran a command" collapse distinct commands).
  let sig;
  if (event === "tool" || event === "fail") {
    const s = `${tool}|${JSON.stringify(p.tool_input ?? {})}`;
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    sig = (h >>> 0).toString(36);
  }
  const row = {
    t: new Date().toISOString(), agent, event, kind: event === "fail" ? kind ?? "other" : kind,
    tool: p.tool_name ?? p.hook_event_name ?? undefined,
    session: p.session_id ?? p.conversation_id ?? undefined,
    // background agents (Claude Code subagents/forks): their own tool events carry agent_id/agent_type
    sub: p.agent_id ?? undefined, subType: p.agent_type || undefined, sig,
    git: git.length ? [...new Set(git)] : undefined, gitMsg,
    detail: detail ? String(detail).replace(/\s+/g, " ").slice(0, 100) : undefined,
    transcript: event === "stop" || event === "session-start" ? p.transcript_path : undefined,
  };
  const dir = join(homedir(), ".fildi");
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "agent-events.jsonl"), JSON.stringify(row) + "\n");
} catch { /* logging must never break an agent */ }
process.exit(0);
