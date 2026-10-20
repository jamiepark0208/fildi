#!/usr/bin/env node
// Agent reply on a NEEDS YOU thread (Settings › Agents › Ideas):  node .agents/hooks/needs-reply.mjs J4 "text" [claude|cursor|muse|grok|codex]
// Inserts into watchlist_sync.needs_comments; Jamie sees it in the cube's thread (badge on the cube).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const [item, text, author = "claude"] = process.argv.slice(2);
if (!/^(J|A)\d+$/.test(item ?? "") || !text?.trim() || !["claude", "cursor", "muse", "grok", "codex"].includes(author)) {
  console.error('usage: needs-reply.mjs J4 "text" [claude|cursor|muse|grok|codex]');
  process.exit(1);
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let url = process.env.DATABASE_URL;
const env = join(root, ".env.local");
if (!url && existsSync(env)) url = readFileSync(env, "utf8").match(/^DATABASE_URL=(.+)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "");
const psql = [process.env.HOME + "/Applications/Postgres.app/Contents/Versions/16/bin/psql", "/Applications/Postgres.app/Contents/Versions/latest/bin/psql",
  "/opt/homebrew/bin/psql", "/usr/local/bin/psql"].find((x) => existsSync(x)) ?? "psql";
const ddl = `CREATE TABLE IF NOT EXISTS watchlist_sync.needs_comments (id serial PRIMARY KEY, item text NOT NULL,
  author text NOT NULL CHECK (author IN ('jamie','claude','cursor','muse','grok','codex','codex')), body text NOT NULL CHECK (length(body) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(), read_by_claude boolean NOT NULL DEFAULT false);
  DO $$ BEGIN
    ALTER TABLE watchlist_sync.needs_comments DROP CONSTRAINT IF EXISTS needs_comments_author_check;
    ALTER TABLE watchlist_sync.needs_comments ADD CONSTRAINT needs_comments_author_check
      CHECK (author IN ('jamie','claude','cursor','muse','grok','codex','codex'));
  EXCEPTION WHEN others THEN NULL; END $$`;
// SQL via stdin so psql's :'var' quoting applies (-c skips variable interpolation) — the text is never spliced into SQL.
execFileSync(psql, [url, "-q", "-v", "ON_ERROR_STOP=1", "-v", `item=${item}`, "-v", `body=${text.trim().slice(0, 2000)}`, "-v", `author=${author}`, "-f", "-"],
  { input: `${ddl};\nINSERT INTO watchlist_sync.needs_comments (item, author, body) VALUES (:'item', :'author', :'body');\n`, stdio: ["pipe", "inherit", "inherit"], timeout: 10_000 });
console.log(`replied on ${item}`);
