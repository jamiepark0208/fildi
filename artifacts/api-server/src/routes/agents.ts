/**
 * Agents view (Claude, user 2026-10-15): who did what, how much, at what token cost — from real records only.
 * GET /api/agents/overview (admin) → { agents, events, asOf }
 *   - commits: git log (last 7 d). Attribution: `Agent:` trailer if present; else Co-Authored-By Claude → claude;
 *     GitHub noreply author → muse (it commits from the cloud); other local commits → cursor. Method shown in the UI tooltip.
 *   - hand-offs: research/common/ASKS.md index rows (from → to, status) — each row is one message between agents.
 *   - tokens: Claude Code session logs (~/.claude/projects/<repo>/*.jsonl, usage per API request, deduped by requestId).
 *     Cursor plan pool: scripts/cursor-usage-snap.mjs → ~/.fildi/cursor-limits.json (DashboardService). Muse: no meter.
 *   - live: hook events (.agents/hooks/agent-event.mjs → ~/.fildi/agent-events.jsonl): working now = event < 2 min, not stopped.
 *   - windows: Claude output tokens per 5-hour window (plan limits reset per 5 h; the plan's cap isn't exposed → compare to own peak).
 *   - rules: .agents/rules.md (curated one-liners) · skills: .claude/skills/*.md + loads in the last 7 d.
 *   - ideas: Muse → Cursor ASKS rows (lifecycle phase + Context blurb) for Settings › Agents › Ideas cubes.
 *   - procs: long-running scripts (one ps + lsof stdout tail for n/N progress → ETA; else median of past runs in ~/.fildi/proc-durations.json).
 * Commits/tokens cached 10 min; live events read fresh. Writes only ~/.fildi/proc-durations.json.
 */
import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, createReadStream, appendFileSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { requireAdmin } from "../middleware/requireAdmin.js";

const router = Router();
const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const LOGS = join(homedir(), ".claude/projects", ROOT.replace(/[/.]/g, "-"));
type AgentId = "muse" | "claude" | "cursor" | "jamie" | "grok";
type Ev = { t: string; from: AgentId; to: AgentId | "repo"; kind: "commit" | "ask"; text: string; ref?: string };

const NAMES: Record<string, AgentId> = { muse: "muse", claude: "claude", cursor: "cursor", jamie: "jamie", user: "jamie", grok: "grok" };
const who = (s: string): AgentId | null => NAMES[s.trim().toLowerCase()] ?? null;

async function commits(since = "7 days ago"): Promise<Ev[]> {
  const { stdout } = await run("git", ["log", `--since=${since}`, "--format=%H%x1f%aI%x1f%ae%x1f%s%x1f%(trailers:key=Agent,valueonly)%x1f%(trailers:key=Co-Authored-By,valueonly)%x1e"],
    { cwd: ROOT, maxBuffer: 8 << 20 });
  return stdout.split("\x1e").map((r) => r.trim()).filter(Boolean).map((r) => {
    const [sha, t, email, subject, agentTrailer, coauthor] = r.split("\x1f");
    const from = who(agentTrailer ?? "") ?? (/claude/i.test(coauthor ?? "") ? "claude" : /users\.noreply\.github\.com$/.test(email) ? "muse" : "cursor");
    return { t, from, to: "repo" as const, kind: "commit" as const, text: subject, ref: sha.slice(0, 7) };
  });
}

type Idea = {
  id: string; date: string; from: AgentId; to: AgentId; title: string; status: string;
  phase: string; quant: boolean; blurb: string;
  /** Latest agent touch (ASKS status note / Reviews line), YYYY-MM-DD. */
  touchedAt: string | null;
  touchedBy: AgentId | null;
  /** accepted/partial / explicit in-progress — cube pulses until it leaves this state. */
  inProgress: boolean;
  /** Same calendar day as the newest touch across the board → "this wave" glow. */
  hot: boolean;
};

function ideaBlurb(id: string): string {
  try {
    const txt = readFileSync(resolve(ROOT, `research/common/asks/${id}.md`), "utf8");
    const m = txt.match(/## Context\s*\n([\s\S]*?)(?=\n## |\n*$)/);
    return (m?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 480);
  } catch {
    return "";
  }
}

function ideaPhase(status: string): string {
  const s = status.trim().toLowerCase();
  if (s.startsWith("verified")) return "verified";
  if (s.startsWith("done")) return "done";
  if (s.startsWith("declined") || s.startsWith("deferred")) return "parked";
  if (s.startsWith("accepted") || s.startsWith("partial")) return "building";
  if (s.startsWith("planned")) return "reviewed";
  if (/needs jamie|user call/.test(s)) return "needs you";
  return "filed";
}

function normalizeTouchDate(raw: string, fallbackYear: number): string | null {
  const full = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (full) return `${full[1]}-${full[2]}-${full[3]}`;
  const short = raw.match(/^(\d{1,2})-(\d{1,2})$/);
  if (!short) return null;
  const mm = short[1]!.padStart(2, "0");
  const dd = short[2]!.padStart(2, "0");
  return `${fallbackYear}-${mm}-${dd}`;
}

/** Latest Cursor/Claude/Muse/Jamie stamp in the ask file + index status cell. */
function ideaTouch(id: string, status: string, filed: string): { at: string | null; by: AgentId | null } {
  const year = Number((filed.match(/^(\d{4})/) ?? [])[1]) || new Date().getFullYear();
  let bestAt: string | null = null;
  let bestBy: AgentId | null = null;
  const consider = (rawDate: string, whoRaw: string) => {
    const at = normalizeTouchDate(rawDate, year);
    const by = who(whoRaw);
    if (!at || !by) return;
    if (!bestAt || at > bestAt) { bestAt = at; bestBy = by; }
  };
  for (const m of status.matchAll(/\b(Cursor|Claude|Muse|Jamie)\s+(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2})\b/gi)) {
    consider(m[2]!, m[1]!);
  }
  try {
    const txt = readFileSync(resolve(ROOT, `research/common/asks/${id}.md`), "utf8");
    // **Cursor 2026-10-16:** / **Claude plan 2026-10-15:** / **Muse review abc:**
    for (const m of txt.matchAll(/\*\*(Cursor|Claude|Muse|Jamie)\b[^*]{0,40}?\b(\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2})\b[^*]*\*\*/gi)) {
      consider(m[2]!, m[1]!);
    }
  } catch { /* missing file */ }
  return { at: bestAt, by: bestBy };
}

/** ASKS index → hand-offs (7d) + Muse idea board (all open/active rows). */
function asks(): { ev: Ev[]; queue: Record<AgentId, number>; ideas: Idea[] } {
  const queue: Record<AgentId, number> = { muse: 0, claude: 0, cursor: 0, jamie: 0, grok: 0 };
  const ev: Ev[] = [];
  const ideas: Idea[] = [];
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
    // Muse idea cubes: Muse → Cursor rows still on the board (not archived)
    if (from === "muse" && dest === "cursor") {
      const st = status.trim();
      const phase = ideaPhase(st);
      const touch = ideaTouch(id!, st, d!);
      const inProgress = phase === "building" || /\bin progress\b/i.test(st);
      ideas.push({
        id: id!, date: d!, from, to: dest,
        title: title!.replace(/\[quant\]\s*/i, "").trim().slice(0, 140),
        status: st,
        phase,
        quant: /\[quant\]/i.test(title!),
        blurb: ideaBlurb(id!),
        touchedAt: touch.at,
        touchedBy: touch.by,
        inProgress,
        hot: false,
      });
    }
  }
  // Rolling wave: newest touch day among ideas → those cubes glow until a newer wave appears.
  const wave = ideas.reduce<string | null>((best, i) => (i.touchedAt && (!best || i.touchedAt > best) ? i.touchedAt : best), null);
  if (wave) for (const i of ideas) i.hot = i.touchedAt === wave;

  const rank: Record<string, number> = {
    "needs you": 0, filed: 1, reviewed: 2, building: 3, done: 4, verified: 5, parked: 6,
  };
  // Jamie's to-dos (.agents/needs-jamie.md: "## J# title" + steps) → NEEDS YOU cubes
  try {
    const txt = readFileSync(resolve(ROOT, ".agents/needs-jamie.md"), "utf8");
    for (const block of txt.split(/\n(?=## )/).filter((b) => b.startsWith("## "))) {
      const [head, ...body] = block.split("\n");
      const m = head.match(/^## (J\d+) (.+)$/);
      if (m) ideas.push({
        id: m[1]!, date: "", from: "claude", to: "jamie", title: m[2]!.trim(), status: "needs you",
        phase: "needs you", quant: false, blurb: body.join("\n").trim(),
        touchedAt: null, touchedBy: null, inProgress: false, hot: false,
      });
    }
  } catch { /* none */ }
  ideas.sort((a, b) => (rank[a.phase] ?? 9) - (rank[b.phase] ?? 9) || b.date.localeCompare(a.date));
  return { ev, queue, ideas };
}

/** Claude token use per day from session logs (dedupe streamed blocks by requestId). */
const hourly = new Map<number, { out: number; inp: number; req: number }>(); // epoch hour → Claude tokens (5-hour windows)
const skillUse = new Map<string, number>(); // skill file name → times loaded in the last 7 d
async function claudeTokens(): Promise<{ day: string; input: number; cacheRead: number; cacheWrite: number; output: number; requests: number }[]> {
  hourly.clear(); skillUse.clear();
  const days = new Map<string, { input: number; cacheRead: number; cacheWrite: number; output: number; requests: number }>();
  const seen = new Set<string>();
  const since = Date.now() - 7 * 864e5;
  let files: string[] = [];
  try { files = readdirSync(LOGS).filter((f) => f.endsWith(".jsonl")).map((f) => join(LOGS, f)).filter((f) => statSync(f).mtimeMs >= since); } catch { return []; }
  for (const f of files) {
    const rl = createInterface({ input: createReadStream(f), crlfDelay: Infinity });
    for await (const line of rl) {
      const sk = line.match(/\.claude\/skills\/([\w-]+)\.md/);
      if (sk && line.includes('"tool_use"')) skillUse.set(sk[1], (skillUse.get(sk[1]) ?? 0) + 1);
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
        const hr = Math.floor(Date.parse(o.timestamp) / 36e5);
        const hb = hourly.get(hr) ?? { out: 0, inp: 0, req: 0 };
        hb.out += u.output_tokens ?? 0; hb.inp += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0); hb.req += 1;
        hourly.set(hr, hb);
      } catch { /* partial line */ }
    }
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, d]) => ({ day, ...d }));
}

type LiveEv = { t: string; agent: string; event: string; kind?: string; tool?: string; session?: string; detail?: string; sub?: string; subType?: string; sig?: string };

/** Background agents (Claude Code subagents/forks): events carry `sub` (agent_id). Description = the parent session's latest
 *  Agent-tool call before the subagent's first event. Running until SubagentStop, or idle > 10 min without one. */
function subagents(live: LiveEv[], nowMs: number) {
  const by = new Map<string, LiveEv[]>();
  for (const e of live) if (e.sub) by.set(e.sub, [...(by.get(e.sub) ?? []), e]);
  return [...by.entries()].map(([id, evs]) => {
    const first = evs[0], last = evs[evs.length - 1];
    const launch = [...live].reverse().find((e) => e.session === first.session && !e.sub && e.tool === "Agent" && e.t <= first.t
      && Date.parse(first.t) - Date.parse(e.t) < 5 * 60_000);
    const stopped = evs.some((e) => e.event === "sub-stop");
    const running = !stopped && nowMs - Date.parse(last.t) < 10 * 60_000;
    return { id, agent: first.agent, session: first.session ?? null, type: first.subType ?? null, task: launch?.detail ?? "background task",
      startedAt: first.t, lastAt: last.t, actions: evs.filter((e) => e.event === "tool" || e.event === "fail").length, running };
  })
    // Claude Code also runs short internal helpers (no type, no tool calls, stop-only) — not user-visible background agents
    .filter((s) => s.actions > 0 || s.type)
    .filter((s) => s.running || nowMs - Date.parse(s.lastAt) < 30 * 60_000);
}

/** Working vs waiting-for-you minutes today (Pacific): gaps ≤ 5 min between actions count as working; a "waiting" event counts
 *  as waiting until the next prompt/action (capped at 60 min). */
function timeSplit(mine: LiveEv[], nowMs: number) {
  const today = new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  // main-session events only: background agents' actions don't end a "waiting for you" stretch
  const evs = mine.filter((e) => !e.sub && new Date(e.t).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) === today);
  let working = 0, waiting = 0;
  for (let i = 0; i < evs.length; i++) {
    const a = Date.parse(evs[i].t), b = i + 1 < evs.length ? Date.parse(evs[i + 1].t) : nowMs, gap = (b - a) / 6e4;
    if (evs[i].event === "waiting") waiting += Math.min(gap, 60);
    else if (!["stop", "session-end"].includes(evs[i].event) && gap <= 5) working += gap;
  }
  return { workingMin: Math.round(working), waitingMin: Math.round(waiting) };
}
const KINDS = ["web", "database", "api", "code", "reading", "other"] as const;
/** Fallback for events logged before the hook classified them (hook has the full command; this only sees the label). */
function kindOf(e: LiveEv): string | undefined {
  if (e.kind) return e.kind;
  if (e.event !== "tool" && e.event !== "edit") return undefined;
  const t = e.tool ?? "";
  if (/^(WebSearch|WebFetch)$/.test(t)) return "web";
  if (e.event === "edit" || /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(t)) return "code";
  if (/^(Read|Grep|Glob|LS)$/.test(t) || /codegraph/i.test(t)) return "reading";
  if (/^mcp__/.test(t)) return "api";
  return "other";
}
/** Hook events (Claude Code + Cursor hooks → ~/.fildi/agent-events.jsonl), last 24 h. Read fresh each call (small). */
function liveEvents(): LiveEv[] {
  try {
    const txt = readFileSync(join(homedir(), ".fildi/agent-events.jsonl"), "utf8");
    const since = new Date(Date.now() - 864e5).toISOString();
    const evs = txt.slice(-4_000_000).split("\n").filter(Boolean)
      .flatMap((l) => { try { return [JSON.parse(l) as LiveEv]; } catch { return []; } })
      .filter((e) => e.t >= since);
    // Cursor also fires .claude hooks (logged as "claude"); any session that ever logs as cursor is Cursor's.
    const cursorSessions = new Set(evs.filter((e) => e.agent === "cursor" && e.session).map((e) => e.session));
    return evs.map((e) => ({ ...(e.session && cursorSessions.has(e.session) ? { ...e, agent: "cursor" } : e), kind: kindOf(e) }));
  } catch { return []; }
}

/** 5-hour windows (Claude plan limits reset on 5 h windows): current window vs the busiest window in 7 d. */
function windows() {
  const now = Math.floor(Date.now() / 36e5);
  const sum = (end: number) => { let out = 0, inp = 0, req = 0; for (let h = end - 4; h <= end; h++) { const b = hourly.get(h); if (b) { out += b.out; inp += b.inp; req += b.req; } } return { out, inp, req }; };
  const cur = sum(now);
  let peak = { out: 0, inp: 0, req: 0 };
  for (let h = now - 7 * 24; h <= now; h++) { const w = sum(h); if (w.out > peak.out) peak = w; }
  const hours = Array.from({ length: 48 }, (_, i) => { const h = now - 47 + i; const b = hourly.get(h); return { t: new Date(h * 36e5).toISOString(), out: b?.out ?? 0, req: b?.req ?? 0 }; });
  return { current: cur, peak, hours };
}

/** Curated one-line rules (.agents/rules.md): "## Group" headings + "- rule" lines. */
function rules(): { group: string; title: string }[] {
  const out: { group: string; title: string }[] = [];
  let group = "";
  try {
    for (const line of readFileSync(resolve(ROOT, ".agents/rules.md"), "utf8").split("\n")) {
      if (line.startsWith("## ")) group = line.slice(3).trim();
      else if (line.startsWith("- ") && group) out.push({ group, title: line.slice(2).trim() });
    }
  } catch { /* missing → empty */ }
  return out;
}

function skills(): { name: string; about: string; uses7d: number }[] {
  const dir = resolve(ROOT, ".claude/skills");
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => {
      const txt = readFileSync(join(dir, f), "utf8");
      const about = (txt.match(/^description:\s*(.+)$/m)?.[1] ?? txt.split("\n").find((l) => l.trim() && !l.startsWith("---") && !l.startsWith("#")) ?? "").replace(/^["'>\s]+|["']$/g, "").slice(0, 140);
      const name = f.replace(/\.md$/, "");
      return { name, about, uses7d: skillUse.get(name) ?? 0 };
    }).sort((a, b) => b.uses7d - a.uses7d || a.name.localeCompare(b.name));
  } catch { return []; }
}

let cache: { at: number; body: unknown } | null = null;
/** Jamie's dismissed ideas (Settings › Agents › Ideas → Dismiss). Claude marks those ASKS rows declined at session start. */
let dismissDdl = false;
async function dismissed(): Promise<Set<string>> {
  try {
    if (!dismissDdl) {
      await db.execute(sql`CREATE TABLE IF NOT EXISTS watchlist_sync.agent_idea_dismissals (id text PRIMARY KEY, dismissed_at timestamptz DEFAULT now())`);
      dismissDdl = true;
    }
    const r = (await db.execute(sql`SELECT id FROM watchlist_sync.agent_idea_dismissals`)) as unknown as { id: string }[] | { rows?: { id: string }[] };
    return new Set((Array.isArray(r) ? r : r.rows ?? []).map((x) => x.id));
  } catch { return new Set(); }
}
const withoutDismissed = (body: object, gone: Set<string>) => {
  const b = body as { ideas?: { id: string }[] };
  return gone.size && b.ideas ? { ...b, ideas: b.ideas.filter((i) => !gone.has(i.id)) } : body;
};

router.post("/agents/ideas/:id/dismiss", requireAdmin, async (req, res) => {
  const id = String(req.params.id ?? "");
  if (!/^A\d+$/.test(id)) return res.status(400).json({ error: "bad id" });
  await dismissed(); // ensures the table exists
  await db.execute(sql`INSERT INTO watchlist_sync.agent_idea_dismissals (id) VALUES (${id}) ON CONFLICT (id) DO NOTHING`);
  return res.json({ ok: true, id });
});

/**
 * NEEDS YOU threads (user 2026-10-15): Jamie ↔ agents comments on J#/A# items. Token-cheap: no AI polling — Claude sees unread
 * Jamie comments only when its own UserPromptSubmit/SessionStart hook injects them (.agents/hooks/needs-inbox.mjs); agents
 * reply with .agents/hooks/needs-reply.mjs. Table created on first use.
 */
let commentsDdl = false;
async function ensureComments() {
  if (commentsDdl) return;
  await db.execute(sql`CREATE TABLE IF NOT EXISTS watchlist_sync.needs_comments (id serial PRIMARY KEY, item text NOT NULL,
    author text NOT NULL CHECK (author IN ('jamie','claude','cursor','muse')), body text NOT NULL CHECK (length(body) <= 2000),
    created_at timestamptz NOT NULL DEFAULT now(), read_by_claude boolean NOT NULL DEFAULT false)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_needs_comments_item ON watchlist_sync.needs_comments (item, created_at)`);
  commentsDdl = true;
}
const ITEM = /^(J|A)\d+$/;
type CRow = { id: number; item: string; author: string; body: string; created_at: string };
const crows = <T,>(r: unknown): T[] => (Array.isArray(r) ? r : (r as { rows?: T[] }).rows ?? []) as T[];

/** Per item: Jamie's comments Claude hasn't read yet (gold "message waiting" dot on the Claude orb). */
async function jamieUnread(): Promise<Record<string, number>> {
  try {
    await ensureComments();
    const r = crows<{ item: string; n: number }>(await db.execute(sql`SELECT item, count(*)::int AS n FROM watchlist_sync.needs_comments
      WHERE author = 'jamie' AND NOT read_by_claude GROUP BY item`));
    return Object.fromEntries(r.map((x) => [x.item, x.n]));
  } catch { return {}; }
}

/** Per item: agent replies newer than Jamie's latest comment (badge on the cube). */
async function needsUnread(): Promise<Record<string, number>> {
  try {
    await ensureComments();
    const r = crows<{ item: string; n: number }>(await db.execute(sql`
      SELECT c.item, count(*)::int AS n FROM watchlist_sync.needs_comments c
      WHERE c.author <> 'jamie' AND c.created_at > COALESCE((SELECT max(j.created_at) FROM watchlist_sync.needs_comments j
        WHERE j.item = c.item AND j.author = 'jamie'), 'epoch') GROUP BY c.item`));
    return Object.fromEntries(r.map((x) => [x.item, x.n]));
  } catch { return {}; }
}

router.get("/agents/needs/:item/comments", requireAdmin, async (req, res) => {
  const item = String(req.params.item ?? "");
  if (!ITEM.test(item)) return res.status(400).json({ error: "bad item" });
  await ensureComments();
  const comments = crows<CRow>(await db.execute(sql`SELECT id, item, author, body, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at
    FROM watchlist_sync.needs_comments WHERE item = ${item} ORDER BY created_at, id LIMIT 200`));
  return res.json({ item, comments });
});

router.post("/agents/needs/:item/comments", requireAdmin, async (req, res) => {
  const item = String(req.params.item ?? "");
  const body = String((req.body as { body?: unknown })?.body ?? "").trim();
  if (!ITEM.test(item)) return res.status(400).json({ error: "bad item" });
  if (!body || body.length > 2000) return res.status(400).json({ error: "body must be 1–2000 chars" });
  await ensureComments();
  await db.execute(sql`INSERT INTO watchlist_sync.needs_comments (item, author, body) VALUES (${item}, 'jamie', ${body})`);
  try { // Stage map: You → Claude beam (Jamie is the sender here)
    mkdirSync(join(homedir(), ".fildi"), { recursive: true });
    appendFileSync(join(homedir(), ".fildi/agent-events.jsonl"), JSON.stringify({ t: new Date().toISOString(), agent: "jamie", event: "comment", detail: item }) + "\n");
  } catch { /* logging never blocks the post */ }
  return res.json({ ok: true });
});

/** Claude plan limits: ~/.claude/statusline.sh saves Claude Code's statusline `rate_limits` (5-hour / 7-day used %, reset time). */
function claudeLimits(): { at: string; fiveHour: { pct: number | null; resetsAt: string | null }; sevenDay: { pct: number | null; resetsAt: string | null } } | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), ".fildi/claude-limits.json"), "utf8")) as { at: string; rate_limits?: Record<string, { used_percentage?: number; resets_at?: string | number }> | null };
    const rl = j.rate_limits;
    if (!rl) return null;
    const one = (k: string) => {
      const r = rl[k];
      const ra = r?.resets_at;
      const iso = ra == null ? null : typeof ra === "number" ? new Date(ra < 1e12 ? ra * 1000 : ra).toISOString() : String(ra);
      return { pct: r?.used_percentage ?? null, resetsAt: iso };
    };
    return { at: j.at, fiveHour: one("five_hour"), sevenDay: one("seven_day") };
  } catch { return null; }
}

/** Muse weekly usage: Muse's heartbeat events carry usage_pct + usage_resets (from subscription-status). */
function museUsage(): { at: string; pct: number | null; resetsAt: string | null } | null {
  try {
    const lines = readFileSync(join(homedir(), ".fildi/agent-events.jsonl"), "utf8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as { agent?: string; t?: string; usage_pct?: number; usage_resets?: string };
        if (e.agent === "muse" && typeof e.usage_pct === "number")
          return { at: e.t ?? new Date().toISOString(), pct: e.usage_pct, resetsAt: e.usage_resets ?? null };
      } catch { /* skip malformed line */ }
    }
    return null;
  } catch { return null; }
}

type CursorLimits = {
  at: string; plan: string | null;
  totalPct: number | null; autoPct: number | null; apiPct: number | null;
  resetsAt: string | null; spendUsd: number | null; limitUsd: number | null; error: string | null;
};
/** Cursor plan limits: `scripts/cursor-usage-snap.mjs` → ~/.fildi/cursor-limits.json (DashboardService GetCurrentPeriodUsage). */
function cursorLimits(): CursorLimits | null {
  try {
    const j = JSON.parse(readFileSync(join(homedir(), ".fildi/cursor-limits.json"), "utf8")) as {
      at: string; plan?: string; totalPercentUsed?: number | null; autoPercentUsed?: number | null; apiPercentUsed?: number | null;
      billingCycleEnd?: string | number | null; totalSpendCents?: number | null; limitCents?: number | null; error?: string | null;
    };
    const end = j.billingCycleEnd;
    let resetsAt: string | null = null;
    if (end != null && end !== "") {
      const n = typeof end === "number" ? end : Number(end);
      resetsAt = Number.isFinite(n) ? new Date(n < 1e12 ? n * 1000 : n).toISOString() : String(end);
    }
    return {
      at: j.at, plan: j.plan ?? null,
      totalPct: j.totalPercentUsed ?? null, autoPct: j.autoPercentUsed ?? null, apiPct: j.apiPercentUsed ?? null,
      resetsAt, spendUsd: j.totalSpendCents != null ? j.totalSpendCents / 100 : null,
      limitUsd: j.limitCents != null ? j.limitCents / 100 : null, error: j.error ?? null,
    };
  } catch { return null; }
}

/** Refresh Cursor usage snap when file missing or older than 5 min (fire-and-forget; never blocks overview). */
function maybeRefreshCursorLimits(): void {
  try {
    const p = join(homedir(), ".fildi/cursor-limits.json");
    let stale = true;
    try { stale = Date.now() - statSync(p).mtimeMs > 5 * 60_000; } catch { stale = true; }
    if (!stale) return;
    const script = join(ROOT, "scripts/cursor-usage-snap.mjs");
    void run("node", [script], { timeout: 20_000 }).catch(() => { /* next poll retries */ });
  } catch { /* ignore */ }
}

let museCache: { at: number; running: boolean } | null = null;
/** Muse is a desktop app (process "Muse"); it keeps no local session/token logs, so only "app open" is knowable here. */
async function museRunning(): Promise<boolean> {
  if (museCache && Date.now() - museCache.at < 30_000) return museCache.running;
  let running = false;
  try { await run("pgrep", ["-x", "Muse"]); running = true; } catch { running = false; }
  museCache = { at: Date.now(), running };
  return running;
}

type MuseLive = { working: boolean; detail: string | null; t: string | null; source: "hooks" | "file" | null; ageMin: number | null };
/** A122: Muse "working" from hook events (device write) or `.agents/live/muse.json` fallback. 10-min window. */
function museLiveStatus(live: LiveEv[], nowMs: number): MuseLive {
  const WIN = 10 * 60_000;
  const fromHook = [...live].reverse().find((e) => e.agent === "muse");
  let best: MuseLive = { working: false, detail: null, t: null, source: null, ageMin: null };
  if (fromHook) {
    const age = nowMs - Date.parse(fromHook.t);
    const working = fromHook.event === "working" && age < WIN && !["stop", "session-end"].includes(fromHook.event);
    best = { working, detail: fromHook.detail ?? null, t: fromHook.t, source: "hooks", ageMin: Math.max(0, Math.round(age / 60_000)) };
  }
  try {
    const j = JSON.parse(readFileSync(join(ROOT, ".agents/live/muse.json"), "utf8")) as { event?: string; detail?: string; t?: string };
    if (j.t) {
      const age = nowMs - Date.parse(j.t);
      const working = j.event === "working" && age < WIN;
      // Prefer fresher of hooks vs file
      if (!best.t || Date.parse(j.t) > Date.parse(best.t)) {
        best = { working, detail: j.detail ?? null, t: j.t, source: "file", ageMin: Math.max(0, Math.round(age / 60_000)) };
      }
    }
  } catch { /* no heartbeat file yet */ }
  return best;
}

/** OpenJev (local calibrated-probability model, A129): running = its server process is up (batch runs load → answer → unload)
 *  or an "openjev" hook-format event < 2 min old that isn't a stop; ping = latest batch event (UI flashes once per new one);
 *  last = newest openjev_runs row, else /tmp/fildi-logs/openjev-last.json. Cached 15 s (one pgrep + one small query). */
let ojCache: { at: number; body: unknown } | null = null;
async function openjevStatus(live: LiveEv[], nowMs: number) {
  if (ojCache && Date.now() - ojCache.at < 15_000) return ojCache.body;
  let proc = false;
  try { await run("pgrep", ["-f", "python -m openjev"]); proc = true; } catch { proc = false; }
  const evs = live.filter((e) => e.agent === "openjev");
  const lastEv = evs.at(-1) ?? null;
  const evLive = !!lastEv && nowMs - Date.parse(lastEv.t) < 2 * 60_000 && !["stop", "session-end"].includes(lastEv.event);
  const ping = [...evs].reverse().find((e) => e.event !== "stop" && e.event !== "start") ?? null;
  let last: { at: string; ok: boolean; detail: string | null; answered: number | null; questions: number | null; peakGb: number | null; totalS: number | null } | null = null;
  try {
    const r = (await db.execute(sql`SELECT run_at, ok, detail, answered, questions, peak_gb, total_s FROM watchlist_sync.openjev_runs ORDER BY run_at DESC LIMIT 1`)) as unknown as Record<string, unknown>[] | { rows?: Record<string, unknown>[] };
    const row = (Array.isArray(r) ? r : r.rows ?? [])[0];
    if (row) last = { at: new Date(row.run_at as string).toISOString(), ok: !!row.ok, detail: (row.detail as string) ?? null, answered: row.answered as number ?? null,
      questions: row.questions as number ?? null, peakGb: row.peak_gb == null ? null : Number(row.peak_gb), totalS: row.total_s == null ? null : Number(row.total_s) };
  } catch { /* table not created yet */ }
  if (!last) {
    try {
      const j = JSON.parse(readFileSync("/tmp/fildi-logs/openjev-last.json", "utf8"));
      last = { at: new Date(j.ts).toISOString(), ok: !!j.ok, detail: j.detail ?? null, answered: j.answered ?? null, questions: j.questions ?? null, peakGb: j.peak_gb ?? null, totalS: j.total_s ?? null };
    } catch { /* never ran */ }
  }
  const body = { running: proc || evLive, proc, doing: evLive ? lastEv?.detail ?? lastEv?.event ?? null : null,
    pingAt: ping?.t ?? null, pingWhat: ping?.detail ?? ping?.event ?? null, last };
  ojCache = { at: Date.now(), body };
  return body;
}

/** Fildi's own scheduled jobs (not agents), read-only and cheap: one ps call, one small api_usage query, the
 *  /tmp/fildi-logs/*-last.json run stamps. Active = process running now, or an API source / run stamp updated < 2 min ago. */
const JOB_PROCS: [RegExp, string][] = [
  [/analysis\/option_history\.py/, "option history"], [/pm_alerts\.py/, "pm alerts"], [/transcripts\.py/, "transcripts"],
  [/maintain\.mjs/, "maintain"], [/daily\.py/, "model list daily"], [/intraday\.py/, "model list intraday"],
  [/nightly-enrichment/, "nightly enrichment"], [/merge-trusted/, "merge trusted"], [/scoreboard\.py/, "scoreboard"],
];
type Proc = { pid: number; ppid: number; secs: number; cmd: string };
/** One `ps` per refresh, shared by jobs() and runningProcs(). etime = [[dd-]hh:]mm:ss → seconds. */
async function psAll(): Promise<Proc[]> {
  try {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,etime=,command="], { maxBuffer: 8 << 20 });
    return stdout.split("\n").flatMap((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) return [];
      const p = m[3].split(/[-:]/).map(Number);
      const secs = m[3].includes("-") ? p[0] * 86400 + p[1] * 3600 + p[2] * 60 + p[3]
        : p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + (p[1] ?? 0);
      return [{ pid: +m[1], ppid: +m[2], secs, cmd: m[4] }];
    });
  } catch { return []; }
}

/** Long-running scripts started by agents (Claude's Bash shells source ~/.claude/shell-snapshots; Cursor's live under Cursor.app)
 *  or by launchd (scheduled jobs). Visible between hook events, which only fire when a command starts/ends. */
const SCRIPT_RE = /(analysis\/[\w-]+\.py|[\w-]+\.py|scripts\/[\w./-]+\.(?:mjs|ts)|maintain\.mjs|nightly-enrichment|merge-trusted)/;
const SKIP_RE = /agent-event\.mjs|codegraph|--watch|api-server\/src\/index|\btsc\b|vitest|statusline|mcp|pip |site-packages|ps -axo/;
const scriptInfo = new Map<string, { db: boolean; sources: string[] }>();
function readScript(token: string) {
  if (scriptInfo.has(token)) return scriptInfo.get(token)!;
  let txt = "";
  for (const base of [ROOT, resolve(ROOT, "scripts/watchlist_sync"), resolve(ROOT, "artifacts/api-server"), ""]) {
    try { txt = readFileSync(base ? resolve(base, token) : token, "utf8"); break; } catch { /* try next */ }
  }
  const sources = ["polygon", "schwab", "finnhub", "alphavantage", "anthropic", "lseg", "fmp", "yahoo"].filter((s) =>
    new RegExp(s === "alphavantage" ? "alphavantage|alpha_vantage" : s, "i").test(txt));
  const v = { db: /connect\(|psycopg|DATABASE_URL|@workspace\/db|db\.execute/.test(txt), sources };
  scriptInfo.set(token, v);
  return v;
}
const DUR_FILE = join(homedir(), ".fildi/proc-durations.json");
const seenProcs = new Map<number, { name: string; secs: number }>();
function durations(): Record<string, number[]> { try { return JSON.parse(readFileSync(DUR_FILE, "utf8")); } catch { return {}; } }
/** Progress "n/N" from the process's stdout log (lsof → file path → last 8 KB). */
async function progressOf(pid: number): Promise<{ n: number; N: number; file: string } | null> {
  try {
    const { stdout } = await run("lsof", ["-p", String(pid), "-a", "-d", "1", "-Fn"], { timeout: 2000 });
    const file = stdout.split("\n").find((l) => l.startsWith("n/") && !l.startsWith("n/dev/"))?.slice(1);
    if (!file) return null;
    const size = statSync(file).size;
    const fd = openSync(file, "r"), len = Math.min(size, 8192), buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len); closeSync(fd);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim()).reverse();
    for (const l of lines.slice(0, 40)) {
      const all = [...l.matchAll(/(?<![\d/-])(\d+)\s*\/\s*(\d+)(?![\d/-])/g)].map((m) => ({ n: +m[1], N: +m[2] })).filter((x) => x.N >= 2 && x.n <= x.N);
      if (all.length) return { ...all[all.length - 1], file };
    }
    return null;
  } catch { return null; }
}
async function runningProcs(ps: Proc[], nowMs: number) {
  const byPid = new Map(ps.map((p) => [p.pid, p]));
  const owner = (p: Proc, name: string): "claude" | "cursor" | "jobs" => {
    for (let q = byPid.get(p.ppid), i = 0; q && i < 12; q = byPid.get(q.ppid), i++) {
      if (q.cmd.includes(".claude/shell-snapshots")) return "claude";
      if (/Cursor(\.app| Helper)/.test(q.cmd)) return "cursor";
    }
    if (JOB_PROCS.some(([re]) => re.test(p.cmd))) return "jobs";
    return /analysis\//.test(name) ? "claude" : "jobs"; // nohup'd agent scripts re-parent to launchd
  };
  const out = [];
  const live = new Set<number>();
  for (const p of ps) {
    if (!/(python|node|tsx)/.test(p.cmd) || SKIP_RE.test(p.cmd) || p.secs < 20) continue;
    const m = p.cmd.match(SCRIPT_RE);
    if (!m) continue;
    const token = m[1], name = token.split("/").pop()!.replace(/\.(py|mjs|ts)$/, "");
    live.add(p.pid);
    seenProcs.set(p.pid, { name, secs: p.secs });
    const info = readScript(token);
    const prog = await progressOf(p.pid);
    const hist = (durations()[name] ?? []).slice().sort((a, b) => a - b);
    let etaS: number | null = null, etaMethod: "from progress" | "typical run" | "unknown" = "unknown";
    if (prog && prog.n > 0) { etaS = Math.round((p.secs * (prog.N - prog.n)) / prog.n); etaMethod = "from progress"; }
    else if (hist.length) { etaS = Math.max(0, hist[Math.floor(hist.length / 2)] - p.secs); etaMethod = "typical run"; }
    out.push({ pid: p.pid, name, script: token, owner: owner(p, token), secs: p.secs, startedAt: new Date(nowMs - p.secs * 1000).toISOString(),
      links: { db: info.db, api: info.sources.length > 0 }, sources: info.sources, progress: prog ? { n: prog.n, N: prog.N } : null, etaS, etaMethod });
  }
  // finished since last scan → remember its duration (median of the last 10 runs = "typical run")
  const done = [...seenProcs.entries()].filter(([pid]) => !live.has(pid));
  if (done.length) {
    const d = durations();
    for (const [pid, v] of done) { (d[v.name] ??= []).push(v.secs); d[v.name] = d[v.name].slice(-10); seenProcs.delete(pid); }
    try { mkdirSync(join(homedir(), ".fildi"), { recursive: true }); writeFileSync(DUR_FILE, JSON.stringify(d)); } catch { /* best effort */ }
  }
  return out;
}

async function jobs(nowMs: number, ps: Proc[]) {
  const running: { name: string; mins: number }[] = [];
  for (const p of ps) {
    const hit = JOB_PROCS.find(([re]) => re.test(p.cmd));
    if (!hit || /grep|ps -axo/.test(p.cmd)) continue;
    if (!running.some((r) => r.name === hit[1])) running.push({ name: hit[1], mins: Math.floor(p.secs / 60) });
  }
  const ran: { name: string; at: string; ok: boolean }[] = [];
  try {
    for (const f of readdirSync("/tmp/fildi-logs").filter((x) => x.endsWith("-last.json"))) {
      try {
        const j = JSON.parse(readFileSync(join("/tmp/fildi-logs", f), "utf8"));
        const at = j.ts ?? j.finishedAt ?? j.at;
        if (at && nowMs - Date.parse(at) < 36e5) ran.push({ name: f.replace(/-last\.json$/, "").replace(/-/g, " "), at, ok: j.ok !== false });
      } catch { /* partial file */ }
    }
  } catch { /* no log dir */ }
  let sources: { source: string; calls: number; at: string }[] = [];
  try {
    const r = (await db.execute(sql`SELECT source, calls_made::int AS calls,
      to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS at FROM api_usage
      WHERE date >= current_date - 1 AND updated_at > now() - interval '1 hour' ORDER BY updated_at DESC`)) as unknown as typeof sources | { rows?: typeof sources };
    sources = Array.isArray(r) ? r : r.rows ?? [];
  } catch { sources = []; }
  // Only attribute API traffic to Jobs when a scheduled job is actually running —
  // otherwise browsing the app (or any process) writing api_usage lights Jobs→APIs
  // and looks like "a second job". Same for DB: a *-last.json stamp is "just finished",
  // not a live Jobs→Database beam.
  const activeSources = running.length > 0
    ? sources.filter((s) => nowMs - Date.parse(s.at) < 2 * 60_000).map((s) => s.source)
    : [];
  const recentRun = ran.some((r) => nowMs - Date.parse(r.at) < 2 * 60_000);
  return {
    running, ran, sources, activeSources, recentRun,
    links: { api: running.length > 0 && activeSources.length > 0, db: running.length > 0 },
  };
}

router.get("/agents/overview", requireAdmin, async (_req, res) => {
  const gone = await dismissed();
  const live = liveEvents();
  const nowMs = Date.now();
  const ended = new Set(live.filter((e) => e.event === "session-end" && e.session).map((e) => e.session));
  const status = (agent: string) => {
    const mine = live.filter((e) => e.agent === agent);
    const last = mine[mine.length - 1];
    const recent = mine.filter((e) => nowMs - Date.parse(e.t) < 10 * 60_000 && !(e.session && ended.has(e.session)));
    // Waiting is per main session: background agents (events with sub = agent_id) share the session id but must not clear it;
    // only the user's next prompt or a main-session event does. Any open session still waiting (≤ 60 min) → agent waiting.
    const lastMain = new Map<string, LiveEv>();
    for (const e of mine) if (!e.sub && e.session && !ended.has(e.session)) lastMain.set(e.session, e);
    const waiting = [...lastMain.values()].some((e) => e.event === "waiting" && nowMs - Date.parse(e.t) < 60 * 60_000);
    const working = !waiting && !!last && nowMs - Date.parse(last.t) < 2 * 60_000 && !["stop", "waiting", "session-end"].includes(last.event);
    const lastKind = [...mine].reverse().find((e) => e.kind)?.kind ?? null;
    const errors1h = mine.filter((e) => e.event === "fail" && nowMs - Date.parse(e.t) < 36e5).length;
    // loop: same tool + same full input ≥ 5× within 10 min (signature hashed by the hook)
    const sigs = new Map<string, number>();
    for (const e of mine) if (e.sig && nowMs - Date.parse(e.t) < 10 * 60_000) sigs.set(e.sig, (sigs.get(e.sig) ?? 0) + 1);
    const looping = [...sigs.values()].some((n) => n >= 5);
    const subs = subagents(mine, nowMs).filter((s) => s.running);
    const prompt = [...mine].reverse().find((e) => e.event === "prompt" && !e.sub && nowMs - Date.parse(e.t) < 12 * 36e5);
    const doing = subs[0]?.task ? `background: ${subs[0].task}` : prompt?.detail ? prompt.detail.slice(0, 60) : last?.detail ?? null;
    return { working, waiting, looping, errors1h, doing, lastKind, lastEvent: last ?? null, ...timeSplit(mine, nowMs),
      sessions10m: new Set(recent.map((e) => e.session).filter(Boolean)).size,
      tools24h: mine.filter((e) => e.event === "tool" || e.event === "edit").length };
  };
  const hourAgo = nowMs - 36e5;
  const activity1h: Record<string, Record<string, number>> = {};
  for (const e of live) {
    if (!e.kind || Date.parse(e.t) < hourAgo) continue;
    (activity1h[e.kind] ??= {})[e.agent] = ((activity1h[e.kind] ??= {})[e.agent] ?? 0) + 1;
  }
  const fresh = {
    live: live.filter((e) => !(e.session && ended.has(e.session)) || e.event !== "tool").slice(-300),
    endedSessions: [...ended],
    subagents: subagents(live, nowMs),
    status: { claude: status("claude"), cursor: status("cursor") },
    activity1h, kinds: KINDS,
    limits: (() => { maybeRefreshCursorLimits(); return { claude: claudeLimits(), cursor: cursorLimits(), muse: museUsage() }; })(),
    needsUnread: await needsUnread(),
    jamieUnread: await jamieUnread(),
    muse: { running: await museRunning(), live: museLiveStatus(live, nowMs) },
    openjev: await openjevStatus(live, nowMs),
    ...(await (async () => { const ps = await psAll(); return { jobs: await jobs(nowMs, ps), procs: await runningProcs(ps, nowMs) }; })()),
    // GitHub node: commits in the last hour (fresh, one git log); pushes come from hook events (git: ["push"]) + Muse's cloud commits
    gitHour: (await commits("1 hour ago").catch((): Ev[] => [])).map((c) => ({ t: c.t, agent: c.from, text: c.text.slice(0, 70) })),
  };
  if (cache && Date.now() - cache.at < 10 * 60_000) return res.json({ ...withoutDismissed(cache.body as object, gone), ...fresh, windows: windows() });
  const [cm, tok] = await Promise.all([commits().catch((): Ev[] => []), claudeTokens()]);
  const { ev, queue, ideas } = asks();
  const day = Date.now() - 864e5;
  const agents = (["muse", "claude", "cursor", "grok", "jamie"] as AgentId[]).map((id) => {
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
  cache = { at: Date.now(), body: { agents, events, ideas, asOf: new Date().toISOString(), rules: rules(), skills: skills() } };
  return res.json({ ...withoutDismissed(cache.body as object, gone), ...fresh, windows: windows() });
});

export default router;
