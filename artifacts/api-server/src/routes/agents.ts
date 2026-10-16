/**
 * Agents view (Claude, user 2026-10-15): who did what, how much, at what token cost — from real records only.
 * GET /api/agents/overview (admin) → { agents, events, asOf }
 *   - commits: git log (last 7 d). Attribution: `Agent:` trailer if present; else Co-Authored-By Claude → claude;
 *     GitHub noreply author → muse (it commits from the cloud); other local commits → cursor. Method shown in the UI tooltip.
 *   - hand-offs: research/common/ASKS.md index rows (from → to, status) — each row is one message between agents.
 *   - tokens: Claude Code session logs (~/.claude/projects/<repo>/*.jsonl, usage per API request, deduped by requestId).
 *     Cursor/Muse token use isn't recorded locally → "not tracked".
 *   - live: hook events (.agents/hooks/agent-event.mjs → ~/.fildi/agent-events.jsonl): working now = event < 2 min, not stopped.
 *   - windows: Claude output tokens per 5-hour window (plan limits reset per 5 h; the plan's cap isn't exposed → compare to own peak).
 *   - rules: .agents/rules.md (curated one-liners) · skills: .claude/skills/*.md + loads in the last 7 d.
 *   - ideas: Muse → Cursor ASKS rows (lifecycle phase + Context blurb) for Settings › Agents › Ideas cubes.
 * Commits/tokens cached 10 min; live events read fresh. Reads only, never writes.
 */
import { Router } from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
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

type Idea = {
  id: string; date: string; from: AgentId; to: AgentId; title: string; status: string;
  phase: string; quant: boolean; blurb: string;
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

/** ASKS index → hand-offs (7d) + Muse idea board (all open/active rows). */
function asks(): { ev: Ev[]; queue: Record<AgentId, number>; ideas: Idea[] } {
  const queue: Record<AgentId, number> = { muse: 0, claude: 0, cursor: 0, jamie: 0 };
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
      ideas.push({
        id, date: d, from, to: dest,
        title: title.replace(/\[quant\]\s*/i, "").trim().slice(0, 140),
        status: status.trim(),
        phase: ideaPhase(status),
        quant: /\[quant\]/i.test(title),
        blurb: ideaBlurb(id),
      });
    }
  }
  const rank: Record<string, number> = {
    "needs you": 0, filed: 1, reviewed: 2, building: 3, done: 4, verified: 5, parked: 6,
  };
  // Jamie's to-dos (.agents/needs-jamie.md: "## J# title" + steps) → NEEDS YOU cubes
  try {
    const txt = readFileSync(resolve(ROOT, ".agents/needs-jamie.md"), "utf8");
    for (const block of txt.split(/\n(?=## )/).filter((b) => b.startsWith("## "))) {
      const [head, ...body] = block.split("\n");
      const m = head.match(/^## (J\d+) (.+)$/);
      if (m) ideas.push({ id: m[1], date: "", from: "claude", to: "jamie", title: m[2].trim(), status: "needs you", phase: "needs you", quant: false, blurb: body.join("\n").trim() });
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
  const evs = mine.filter((e) => new Date(e.t).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }) === today);
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

let museCache: { at: number; running: boolean } | null = null;
/** Muse is a desktop app (process "Muse"); it keeps no local session/token logs, so only "app open" is knowable here. */
async function museRunning(): Promise<boolean> {
  if (museCache && Date.now() - museCache.at < 30_000) return museCache.running;
  let running = false;
  try { await run("pgrep", ["-x", "Muse"]); running = true; } catch { running = false; }
  museCache = { at: Date.now(), running };
  return running;
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
    const waiting = !!last && last.event === "waiting";
    const working = !!last && nowMs - Date.parse(last.t) < 2 * 60_000 && !["stop", "waiting", "session-end"].includes(last.event);
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
    limits: { claude: claudeLimits() },
    muse: { running: await museRunning() },
  };
  if (cache && Date.now() - cache.at < 10 * 60_000) return res.json({ ...withoutDismissed(cache.body as object, gone), ...fresh, windows: windows() });
  const [cm, tok] = await Promise.all([commits().catch((): Ev[] => []), claudeTokens()]);
  const { ev, queue, ideas } = asks();
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
  cache = { at: Date.now(), body: { agents, events, ideas, asOf: new Date().toISOString(), rules: rules(), skills: skills() } };
  return res.json({ ...withoutDismissed(cache.body as object, gone), ...fresh, windows: windows() });
});

export default router;
