/**
 * Agents view (Claude, user 2026-10-15): who did what, how much, at what token cost — from real records only.
 * GET /api/agents/overview (admin) → { agents, events, asOf }
 *   - commits: git log (last 7 d). Attribution: `Agent:` trailer if present; else Co-Authored-By Claude → claude;
 *     GitHub noreply author → muse (it commits from the cloud); other local commits → cursor. Method shown in the UI tooltip.
 *   - hand-offs: research/common/ASKS.md index rows (from → to, status) — each row is one message between agents.
 *   - tokens: Claude Code session logs (~/.claude/projects/<repo>/*.jsonl, usage per API request, deduped by requestId).
 *     Cursor/Muse token use isn't recorded locally → "not tracked".
 * Cached 10 min; reads only, never writes.
 */
import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();
const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LOGS = join(homedir(), ".claude/projects", ROOT.replace(/[/.]/g, "-"));
type AgentId = "muse" | "claude" | "cursor" | "jamie";
type Ev = { t: string; from: AgentId; to: AgentId | "repo"; kind: "commit" | "ask"; text: string; ref?: string };

const NAMES: Record<string, AgentId> = { muse: "muse", claude: "claude", cursor: "cursor", jamie: "jamie", user: "jamie" };
const who = (s: string): AgentId | null => NAMES[s.trim().toLowerCase()] ?? null;

async function commits(): Promise<Ev[]> {
  const { stdout } = await run("git", ["log", "--since=7 days ago", "--format=%H%x1f%aI%x1f%ae%x1f%s%x1f%(trailers:key=Agent,valueonly)%x1f%(trailers:key=Co-Authored-By,valueonly)%x1e"],
    { cwd: ROOT, maxBuffer: 8 << 20 });
  return stdout.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, t, email, subject, agentTrailer, coauthor] = r.split("\x1f");
    const from = who(agentTrailer ?? "") ?? (/claude/i.test(coauthor ?? "") ? "claude" : /users\.noreply\.github\.com$/.test(email) ? "muse" : "cursor");
    return { t, from, to: "repo" as const, kind: "commit" as const, text: subject, ref: sha.slice(0, 7) };
  });
}

/** ASKS index rows → hand-off events; date comes from the row (day precision), time from the commit that added it if known. */
function asks(): { ev: Ev[]; queue: Record<AgentId, number> } {
  const queue: Record<AgentId, number> = { muse: 0, claude: 0, cursor: 0, jamie: 0 };
  const ev: Ev[] = [];
  const since = Date.now() - 7 * 864e5;
  for (const line of readFileSync(resolve(ROOT, "research/common/ASKS.md"), "utf8").split("\n")) {
    const m = line.match(/^\| \[(A\d+)\][^|]*\| (\d{4}-\d{2}-\d{2}) \| (\w+) → (\w+) \| (.*) \| ([^|]*) \|$/);
    if (!m) continue;
    const [, id, d, f, to, title, status] = m;
    const from = who(f), dest = who(to);
    if (!from || !dest) continue;
    if (/^(open|planned|accepted|partial)/i.test(status.trim())) queue[dest] += 1;
    if (/needs jamie|user call/i.test(status)) queue.jamie += 1;
    if (Date.parse(d) >= since) ev.push({ t: `${d}T12:00:00`, from, to: dest, kind: "ask", text: `${id} ${title.replace(/\[quant\] /, "")}`.slice(0, 120), ref: id });
  }
  return { ev, queue };
}

/** Claude token use per day from session logs (dedupe streamed blocks by requestId). */
async function claudeTokens(): Promise<{ day: string; input: number; cacheRead: number; cacheWrite: number; output: number; requests: number }[]> {
  const days = new Map<string, { input: number; cacheRead: number; cacheWrite: number; output: number; requests: number }>();
  const seen = new Set<string>();
  const since = Date.now() - 7 * 864e5;
  let files: string[] = [];
  try { files = readdirSync(LOGS).filter((f) => f.endsWith(".jsonl")).map((f) => join(LOGS, f)).filter((f) => statSync(f).mtimeMs >= since); } catch { return []; }
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"usage"')) continue;
      try {
        const o = JSON.parse(line);
        const u = o.message?.usage, id = o.requestId ?? o.uuid;
        if (!u || !o.timestamp || seen.has(id) || Date.parse(o.timestamp) < since) continue;
        seen.add(id);
        const day = new Date(o.timestamp).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
        const d = days.get(day) ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, requests: 0 };
        d.input += u.input_tokens ?? 0; d.cacheRead += u.cache_read_input_tokens ?? 0; d.cacheWrite += u.cache_creation_input_tokens ?? 0;
        d.output += u.output_tokens ?? 0; d.requests += 1;
        days.set(day, d);
      } catch { /* partial line */ }
    }
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d }));
}

let cache: { at: number; body: unknown } | null = null;
router.get("/agents/overview", requireAdmin, async (_req, res) => {
  if (cache && Date.now() - cache.at < 10 * 60_000) return res.json(cache.body);
  const [cm, tok] = await Promise.all([commits().catch((): Ev[] => []), claudeTokens()]);
  const { ev, queue } = asks();
  const day = Date.now() - 864e5;
  const agents = (["muse", "claude", "cursor", "jamie"] as AgentId[]).map((id) => {
    const mine = cm.filter((c) => c.from === id);
    return {
      id,
      commits24h: mine.filter((c) => Date.parse(c.t) >= day).length,
      commits7d: mine.length,
      lastActive: mine[0]?.t ?? null,
      queue: queue[id],
      sent7d: ev.filter((e) => e.from === id).length,
      received7d: ev.filter((e) => e.to === id).length,
      tokens: id === "claude" ? tok : null,
    };
  });
  const events = [...cm, ...ev].sort((a, b) => b.t.localeCompare(a.t)).slice(0, 150);
  cache = { at: Date.now(), body: { agents, events, asOf: new Date().toISOString() } };
  return res.json(cache.body);
});

export default router;
