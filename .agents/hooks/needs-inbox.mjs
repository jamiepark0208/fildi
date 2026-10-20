#!/usr/bin/env node
// NEEDS YOU inbox (A153): any agent can surface unanswered Jamie comments.
// Claude Code UserPromptSubmit/SessionStart: claim + print (marks read_by_claude).
// Cursor / Muse / Grok / CLI: print unanswered (no agent reply after Jamie's comment); do not claim.
// Cap ~10 lines / ~1,500 chars. Never blocks or fails (≤1 s, exit 0).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const INBOX_BUDGET = 1500;
const AGENTS = new Set(["claude", "cursor", "muse", "grok", "codex"]);

/** Rows are already claimed. Only lines that fit the stdout budget count as delivered. */
export function splitInboxDelivery(rows, budget = INBOX_BUDGET) {
  const delivered = [];
  const undelivered = [];
  let left = budget;
  let open = true;
  for (const row of rows) {
    const body = String(row.body ?? "");
    const line = `[NEEDS YOU ${row.item}] Jamie: ${body.slice(0, 300)}`;
    if (!open || line.length > left) {
      open = false;
      undelivered.push(row);
      continue;
    }
    left -= line.length;
    delivered.push({ ...row, line });
  }
  return { delivered, undelivered };
}

/** Detect which agent is reading the inbox. Exported for tests. */
export function detectInboxAgent(env = process.env, stdinPayload = {}, argv = process.argv) {
  const flag = argv.find((a) => a.startsWith("--agent="))?.slice(8)
    ?? (argv.includes("--agent") ? argv[argv.indexOf("--agent") + 1] : null);
  if (flag && AGENTS.has(flag)) return flag;
  const envAgent = String(env.FILDI_AGENT ?? "").toLowerCase();
  if (AGENTS.has(envAgent)) return envAgent;
  const inCursor = Object.keys(env).some((k) => k.startsWith("CURSOR_"))
    || /\/\.cursor\//.test(String(stdinPayload.transcript_path ?? ""))
    || !!stdinPayload.cursor_version;
  if (inCursor) return "cursor";
  return "claude";
}

function runningAsCli() {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    try {
      return import.meta.url === pathToFileURL(resolve(arg)).href;
    } catch {
      return false;
    }
  }
}

function psqlBin() {
  return [process.env.HOME + "/Applications/Postgres.app/Contents/Versions/16/bin/psql",
    "/Applications/Postgres.app/Contents/Versions/latest/bin/psql",
    "/opt/homebrew/bin/psql", "/usr/local/bin/psql"].find((x) => existsSync(x)) ?? "psql";
}

function dbUrl(root) {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const env = join(root, ".env.local");
    if (existsSync(env)) url = readFileSync(env, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
  }
  return url;
}

function parseRows(out) {
  const rows = [];
  for (const l of out.split("\n").filter(Boolean)) {
    const [id, item, body = ""] = l.split("\t");
    if (!/^\d+$/.test(id ?? "") || !item) continue;
    rows.push({ id, item, body });
  }
  return rows;
}

function main() {
  try {
    let p = {};
    try { p = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch { /* no stdin */ }
    const agent = detectInboxAgent(process.env, p, process.argv);
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const url = dbUrl(root);
    if (!url) process.exit(0);
    const psql = psqlBin();
    // Claude hook: claim unread (legacy read_by_claude). Others: unanswered only (no mark).
    const claimClaude = agent === "claude";
    const q = claimClaude
      ? `WITH u AS (UPDATE watchlist_sync.needs_comments SET read_by_claude = true WHERE id IN (
          SELECT id FROM watchlist_sync.needs_comments WHERE author = 'jamie' AND NOT read_by_claude ORDER BY created_at LIMIT 10)
        RETURNING id, item, body, created_at)
        SELECT id::text || E'\\t' || item || E'\\t' || regexp_replace(body, E'\\\\s+', ' ', 'g') FROM u ORDER BY created_at`
      : `SELECT c.id::text || E'\\t' || c.item || E'\\t' || regexp_replace(c.body, E'\\\\s+', ' ', 'g')
         FROM watchlist_sync.needs_comments c
         WHERE c.author = 'jamie'
           AND NOT EXISTS (
             SELECT 1 FROM watchlist_sync.needs_comments r
             WHERE r.item = c.item
               AND r.author IN ('claude','cursor','muse','grok','codex')
               AND r.created_at > c.created_at
           )
         ORDER BY c.created_at LIMIT 10`;
    const out = execFileSync(psql, [url, "-At", "-v", "ON_ERROR_STOP=1", "-c", q], {
      timeout: 800, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8",
    });
    const rows = parseRows(out);
    const { delivered, undelivered } = splitInboxDelivery(rows);
    if (claimClaude && undelivered.length) {
      const ids = undelivered.map((r) => r.id).join(",");
      const undo = `UPDATE watchlist_sync.needs_comments SET read_by_claude = false WHERE id IN (${ids})`;
      execFileSync(psql, [url, "-At", "-v", "ON_ERROR_STOP=1", "-c", undo], {
        timeout: 400, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8",
      });
    }
    if (delivered.length) {
      process.stdout.write(
        delivered.map((r) => r.line).join("\n")
          + `\n(Reply: node .agents/hooks/needs-reply.mjs <item> "text" ${agent}; owner works the item; resolved → delete from .agents/needs-jamie.md)\n`,
      );
    }
  } catch { /* table missing / DB down / timeout: stay silent */ }
  process.exit(0);
}

if (runningAsCli()) main();
