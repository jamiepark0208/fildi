#!/usr/bin/env node
// NEEDS YOU inbox (user 2026-10-15): Claude Code UserPromptSubmit + SessionStart hook. Prints Jamie's unread comments on NEEDS YOU
// items (Settings › Agents › Ideas) to stdout — Claude Code injects hook stdout into Claude's context, so Claude sees them with
// zero extra tool calls and no polling. Marks them read. Cap ~10 lines / ~1,500 chars. Never blocks or fails (≤1 s, exit 0).
// Cursor also runs .claude hooks → skip there (only Claude reads this inbox).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
try {
  let p = {};
  try { p = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
  const inCursor = Object.keys(process.env).some((k) => k.startsWith("CURSOR_")) || /\/\.cursor\//.test(String(p.transcript_path ?? "")) || p.cursor_version;
  if (inCursor) process.exit(0);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  let url = process.env.DATABASE_URL;
  if (!url) {
    const env = join(root, ".env.local");
    if (existsSync(env)) url = readFileSync(env, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  }
  if (!url) process.exit(0);
  const psql = [process.env.HOME + "/Applications/Postgres.app/Contents/Versions/16/bin/psql", "/Applications/Postgres.app/Contents/Versions/latest/bin/psql",
    "/opt/homebrew/bin/psql", "/usr/local/bin/psql"].find((x) => existsSync(x)) ?? "psql";
  const q = `WITH u AS (UPDATE watchlist_sync.needs_comments SET read_by_claude = true WHERE id IN (
      SELECT id FROM watchlist_sync.needs_comments WHERE author = 'jamie' AND NOT read_by_claude ORDER BY created_at LIMIT 10)
    RETURNING item, body, created_at)
    SELECT item || E'\\t' || regexp_replace(body, E'\\\\s+', ' ', 'g') FROM u ORDER BY created_at`;
  const out = execFileSync(psql, [url, "-At", "-v", "ON_ERROR_STOP=1", "-c", q], { timeout: 1000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  let budget = 1500;
  const lines = [];
  for (const l of out.split("\n").filter(Boolean)) {
    const [item, body = ""] = l.split("\t");
    const line = `[NEEDS YOU ${item}] Jamie: ${body.slice(0, 300)}`;
    if (line.length > budget) break;
    budget -= line.length;
    lines.push(line);
  }
  if (lines.length) {
    process.stdout.write(lines.join("\n") + "\n(Reply: node .agents/hooks/needs-reply.mjs <item> \"text\"; resolved → delete the item from .agents/needs-jamie.md)\n");
  }
} catch { /* table missing / DB down / timeout: stay silent */ }
process.exit(0);
