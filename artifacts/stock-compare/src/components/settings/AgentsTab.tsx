/**
 * Settings › Agents (Claude + Cursor styling, user 2026-10-15). Real records only: hook events (Claude Code + Cursor →
 * ~/.fildi/agent-events.jsonl), commits (git), hand-offs + Muse ideas (ASKS rows), Claude tokens (session logs).
 * Team / Ideas = zoomable maps (scroll = zoom, drag = pan, click = details): 3D orbs for agents, 3D cubes for ideas.
 * Beams and spinning rings only for actions in the last 2 min. Tables use the shared Rankings grid look.
 * Data: GET /api/agents/overview.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bar, BarChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";

type Id = "muse" | "claude" | "cursor" | "jamie";
type Tok = { day: string; input: number; cacheRead: number; cacheWrite: number; output: number; requests: number };
type Agent = { id: Id; commits24h: number; commits7d: number; lastActive: string | null; queue: number; sent7d: number; received7d: number; tokens: Tok[] | null };
type Ev = { t: string; from: Id; to: Id | "repo"; kind: "commit" | "ask"; text: string; ref?: string };
type Live = { t: string; agent: string; event: string; kind?: string; tool?: string; session?: string; detail?: string; sub?: string; git?: string[]; gitMsg?: string };
type Jobs = { running: { name: string; mins: number }[]; ran: { name: string; at: string; ok: boolean }[];
  sources: { source: string; calls: number; at: string }[]; activeSources: string[]; links: { api: boolean; db: boolean } };
type Status = {
  working: boolean; waiting?: boolean; looping?: boolean; errors1h?: number; doing?: string | null; workingMin?: number; waitingMin?: number;
  lastKind?: string | null; lastEvent: Live | null; sessions10m: number; tools24h: number;
};
type Proc = { pid: number; name: string; script: string; owner: "claude" | "cursor" | "jobs"; secs: number; startedAt: string;
  links: { db: boolean; api: boolean }; sources: string[]; progress: { n: number; N: number } | null; etaS: number | null; etaMethod: string };
type Seg = { a: { x: number; y: number }; b: { x: number; y: number }; title: string; what: string; startedAt?: string; etaS?: number | null; etaMethod?: string; c: string };
const dur = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m` : s >= 60 ? `${Math.round(s / 60)}m` : `${Math.max(1, Math.round(s))}s`);
/** Script name → plain words for tooltips. */
const NICE: Record<string, string> = { s021_pricing: "S021 price check", option_history: "Option history load", option_derive: "Option history tables",
  pm_alerts: "Portfolio alerts", transcripts: "Call transcripts", scoreboard: "Scoreboard", daily: "Model List build", intraday: "Model List re-check", maintain: "Daily maintenance" };
const nice = (n: string) => NICE[n] ?? (/^s0\d\d/.test(n) ? `${n.slice(0, 4).toUpperCase()} study` : n.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase()));
type Sub = { id: string; agent: string; session: string | null; type: string | null; task: string; startedAt: string; lastAt: string; actions: number; running: boolean };
/** Agent needs a look: waiting on you (yellow), or looping / failing (red). */
const attention = (st?: Status) => (st?.waiting ? "#fde047" : st?.looping || (st?.errors1h ?? 0) > 0 ? "#f87171" : undefined);
type Limit = { pct: number | null; resetsAt: string | null };
type Win = { out: number; inp: number; req: number };
type Idea = { id: string; date: string; from: Id; to: Id; title: string; status: string; phase: string; quant: boolean; blurb: string };
type Data = {
  needsUnread?: Record<string, number>;
  agents: Agent[]; events: Ev[]; live: Live[]; ideas?: Idea[];
  status: Record<"claude" | "cursor", Status>;
  windows: { current: Win; peak: Win; hours: { t: string; out: number; req: number }[] };
  rules: { group: string; title: string }[]; skills: { name: string; about: string; uses7d: number }[];
  activity1h?: Record<string, Record<string, number>>; endedSessions?: string[];
  limits?: { claude: { at: string; fiveHour: Limit; sevenDay: Limit } | null }; muse?: { running: boolean };
  subagents?: Sub[]; jobs?: Jobs; procs?: Proc[]; gitHour?: { t: string; agent: string; text: string }[];
};
/** Where an agent's work goes on the Stage map, and the ring colour it gives the agent while working. */
const KIND: Record<string, { label: string; color: string; node?: string }> = {
  web: { label: "web research", color: "#fb923c", node: "web" },
  database: { label: "database", color: "#60a5fa", node: "db" },
  api: { label: "external APIs", color: "#a78bfa", node: "api" },
  code: { label: "writing code", color: "#4ade80", node: "repo" },
  reading: { label: "reading code", color: "#ffffff", node: "repo" },
  other: { label: "other", color: "#a1a1aa" },
};
const NODES: Record<string, { label: string; row: number; kinds: string[] }> = { // left-side stack, top → bottom
  repo: { label: "Code Repo", row: 0, kinds: ["code", "reading"] },
  github: { label: "GitHub", row: 1, kinds: [] },
  db: { label: "Database", row: 2, kinds: ["database"] },
  api: { label: "APIs", row: 3, kinds: ["api"] },
  web: { label: "Web", row: 4, kinds: ["web"] },
};
const GITHUB = "#a5b4fc", JOBS = "#f59e0b";
const WAIT = "#fde047";
type View = { z: number; x: number; y: number };

const META: Record<Id, { label: string; role: string; color: string; ang: number }> = {
  jamie: { label: "You", role: "decide", color: "#fde047", ang: 0 },
  muse: { label: "Muse", role: "ideas", color: "#e879f9", ang: -150 },
  claude: { label: "Claude", role: "review · research", color: "#38e1ff", ang: -30 },
  cursor: { label: "Cursor", role: "build", color: "#4ade80", ang: 90 },
};
const PHASES = ["needs you", "filed", "reviewed", "building", "done", "parked"] as const;
const PHASE_COLOR: Record<string, string> = {
  "needs you": "#fde047", filed: "#e879f9", reviewed: "#38e1ff", building: "#4ade80", done: "#fbbf24", verified: "#4ade80", parked: "#a1a1aa",
};
const LIVE_MS = 2 * 60_000;
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const ago = (t: string | null | undefined) => {
  if (!t) return "—";
  const m = (Date.now() - Date.parse(t)) / 6e4;
  return m < 1 ? "now" : m < 60 ? `${Math.round(m)}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const TIP = "max-w-[340px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug";
const SUB_TABS = ["Stage", "Ideas", "Usage", "Rules", "Skills"] as const;

function InfoTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild><button type="button" className="text-white/40 hover:text-white"><Info className="w-3.5 h-3.5" /></button></TooltipTrigger>
      <TooltipContent side="bottom" className={TIP}>{children}</TooltipContent>
    </Tooltip>
  );
}

/** Hook payload → short plain English (hide raw shell). (Cursor) */
/** Stable display names (user 10-15): per agent, the oldest live main session = "Claude"; every other session and background
 * agent = "Claude2", "Claude3"… in start order over the 24 h event window. Keys: `s:<sessionId>` / `b:<subagentId>`. */
function agentNames(d: Data): (key: string, agent?: string) => string {
  const out = new Map<string, string>();
  const ended = new Set(d.endedSessions ?? []);
  for (const agent of ["claude", "cursor"]) {
    const first = new Map<string, number>(), last = new Map<string, number>();
    for (const e of d.live) {
      if (e.agent !== agent || !e.session || e.sub) continue;
      const t = Date.parse(e.t);
      if (!first.has(e.session) || t < first.get(e.session)!) first.set(e.session, t);
      if (!last.has(e.session) || t > last.get(e.session)!) last.set(e.session, t);
    }
    const items: { key: string; t: number }[] = [...first].map(([sid, t]) => ({ key: `s:${sid}`, t }));
    for (const k of d.subagents ?? []) if (k.agent === agent) items.push({ key: `b:${k.id}`, t: Date.parse(k.startedAt) });
    const live = [...first.keys()].filter((sid) => !ended.has(sid) && Date.now() - (last.get(sid) ?? 0) < 10 * 60_000);
    const main = (live.length ? live : [...first.keys()]).sort((a, b) => first.get(a)! - first.get(b)!)[0];
    const label = META[agent as Id].label;
    let n = 1;
    if (main) out.set(`s:${main}`, label);
    for (const it of items.sort((a, b) => a.t - b.t)) if (!out.has(it.key)) out.set(it.key, `${label}${++n}`);
  }
  return (key, agent) => out.get(key) ?? (agent ? META[agent as Id]?.label ?? agent : key);
}
/** Name for one hook event: its background agent, else its session. */
const evName = (nm: ReturnType<typeof agentNames>, e: Live) => (e.sub ? nm(`b:${e.sub}`, e.agent) : e.session ? nm(`s:${e.session}`, e.agent) : META[e.agent as Id]?.label ?? e.agent);

function humanAction(e: Live): string {
  const tool = (e.tool ?? e.event ?? "action").replace(/^(PreToolUse|PostToolUse|Tool)/i, "").trim() || "action";
  const d = (e.detail ?? "").trim();
  const looksShell = !!d && (/^(cd |ls |git |npm |pnpm |node |python|curl |rg |grep |cat |head |tail |psql |wc |chmod |mkdir |echo |export |source |\.\/)/i.test(d)
    || /&&|\|\||\n|; sudo/.test(d) || (d.length > 72 && /[|<>]/.test(d)));
  if (looksShell) return `${tool} · ran a command`;
  if (!d) return tool;
  if (d.includes("/")) return `${tool} · ${d.split("/").filter(Boolean).slice(-2).join("/").slice(0, 72)}`;
  return `${tool} · ${d.slice(0, 80)}`;
}

// ── canvas primitives ────────────────────────────────────────────────────────────────────────────────────────────────
function drawOrb(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string, o: { working?: boolean; selected?: boolean; now: number; reduce: boolean; ring?: string; pulse?: string }) {
  if (o.pulse) { // waiting for you: soft yellow pulse
    const k = o.reduce ? 0.6 : 0.5 + 0.5 * Math.sin(o.now / 300);
    ctx.strokeStyle = o.pulse; ctx.globalAlpha = 0.35 + 0.5 * k; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, r + 6 + 4 * k, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
  }
  const glow = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * (o.working ? 2.8 : 2));
  glow.addColorStop(0, c + (o.working ? "bb" : "66")); glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r * 2.8, 0, 7); ctx.fill();
  const body = ctx.createRadialGradient(x - r * 0.36, y - r * 0.44, r * 0.05, x, y, r); // 3D sphere, light from top-left
  body.addColorStop(0, "#ffffff"); body.addColorStop(0.12, c); body.addColorStop(0.55, c + "aa"); body.addColorStop(1, "#06080c");
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  ctx.strokeStyle = o.selected ? "#ffffff" : c; ctx.lineWidth = o.selected ? 2 : 1; ctx.stroke();
  const spec = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, 0, x - r * 0.35, y - r * 0.45, r * 0.45);
  spec.addColorStop(0, "rgba(255,255,255,0.75)"); spec.addColorStop(1, "transparent");
  ctx.fillStyle = spec; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill();
  if (o.working && !o.reduce) {
    const a = o.now / 380;
    const rc = o.ring ?? c;
    ctx.strokeStyle = rc; ctx.lineWidth = 2.5; ctx.shadowColor = rc; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(x, y, r + 7, a, a + 1.7); ctx.stroke(); ctx.shadowBlur = 0;
  }
}

/** Soft glow behind a node, same as the orbs'. */
function nodeGlow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
  const g = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.2);
  g.addColorStop(0, c + "66"); g.addColorStop(1, "transparent");
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r * 2.2, 0, 7); ctx.fill();
}

/** 3D cylinder (Database node): lit top ellipse + body shaded left→right, light from top-left like the orbs. */
function drawCylinder(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
  const w = r, h = r * 1.5, ry = r * 0.36, top = y - h / 2, bot = y + h / 2;
  nodeGlow(ctx, x, y, r * 1.1, c);
  const body = ctx.createLinearGradient(x - w, 0, x + w, 0);
  body.addColorStop(0, "#ffffff"); body.addColorStop(0.18, c); body.addColorStop(0.7, c + "aa"); body.addColorStop(1, "#06080c");
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.moveTo(x - w, top); ctx.lineTo(x - w, bot); ctx.ellipse(x, bot, w, ry, 0, Math.PI, 0, true); ctx.lineTo(x + w, top);
  ctx.ellipse(x, top, w, ry, 0, 0, Math.PI, false); ctx.closePath(); ctx.fill();
  ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke();
  const lid = ctx.createRadialGradient(x - w * 0.4, top - ry * 0.4, 0, x, top, w);
  lid.addColorStop(0, "#ffffff"); lid.addColorStop(0.3, c); lid.addColorStop(1, c + "99");
  ctx.fillStyle = lid; ctx.beginPath(); ctx.ellipse(x, top, w, ry, 0, 0, 7); ctx.fill(); ctx.stroke();
  ctx.strokeStyle = c + "77"; ctx.beginPath(); ctx.ellipse(x, y, w, ry, 0, 0, Math.PI); ctx.stroke(); // band
}

/** 3D box (APIs node): isometric lit top + two shaded faces, glossy edge highlight. */
function drawBox(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
  const s = r * 0.95, d = s * 0.5;
  nodeGlow(ctx, x, y, r * 1.1, c);
  const T = [[x - s, y - s + d * 0.2], [x, y - s - d * 0.6], [x + s, y - s + d * 0.2], [x, y - s + d]];
  const L = [[x - s, y - s + d * 0.2], [x, y - s + d], [x, y + s], [x - s, y + s - d * 0.8]];
  const R = [[x + s, y - s + d * 0.2], [x, y - s + d], [x, y + s], [x + s, y + s - d * 0.8]];
  const face = (pts: number[][], fill: string | CanvasGradient) => {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke();
  };
  const g = ctx.createLinearGradient(x - s, y - s, x + s, y - s + d);
  g.addColorStop(0, "#ffffff"); g.addColorStop(0.3, c); g.addColorStop(1, c + "aa");
  const l = ctx.createLinearGradient(x - s, y, x, y);
  l.addColorStop(0, c); l.addColorStop(1, c + "88");
  face(T, g); face(L, l); face(R, c + "44");
}

/** 3D folder with a </> mark (Code Repo node): back tab + glossy front panel, lit from top-left. */
/** GitHub node: glossy 3D octagon (same lighting as the orbs) with a small branch mark. */
function drawOctagon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
  const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2);
  glow.addColorStop(0, c + "55"); glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y, r * 2, 0, 7); ctx.fill();
  const pts = Array.from({ length: 8 }, (_, i) => { const a = Math.PI / 8 + (i * Math.PI) / 4; return [x + Math.cos(a) * r, y + Math.sin(a) * r]; });
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.45, r * 0.05, x, y, r * 1.1);
  g.addColorStop(0, "#ffffff"); g.addColorStop(0.15, c); g.addColorStop(0.6, c + "aa"); g.addColorStop(1, "#06080c");
  ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath();
  ctx.fillStyle = g; ctx.fill(); ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.55)"; ctx.lineWidth = 1.4; // branch mark, top of the shape
  const bx = x + r * 0.42, by = y - r * 0.55;
  ctx.beginPath(); ctx.moveTo(bx - 4, by + 7); ctx.lineTo(bx - 4, by - 3); ctx.moveTo(bx - 4, by + 2); ctx.quadraticCurveTo(bx + 3, by + 2, bx + 3, by - 3); ctx.stroke();
}

function drawRepo(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string) {
  const w = r * 1.05, h = r * 0.8, d = r * 0.22;
  nodeGlow(ctx, x, y, r * 1.1, c);
  ctx.fillStyle = c + "88"; ctx.strokeStyle = c; ctx.lineWidth = 1; // back panel + tab
  ctx.beginPath(); ctx.moveTo(x - w + d, y - h - d); ctx.lineTo(x - w * 0.25 + d, y - h - d); ctx.lineTo(x - w * 0.1 + d, y - h + d * 0.2);
  ctx.lineTo(x + w + d, y - h + d * 0.2); ctx.lineTo(x + w + d, y + h - d); ctx.lineTo(x - w + d, y + h - d); ctx.closePath(); ctx.fill(); ctx.stroke();
  const g = ctx.createLinearGradient(x - w, y - h, x + w, y + h); // front panel
  g.addColorStop(0, "#ffffff"); g.addColorStop(0.22, c); g.addColorStop(0.75, c + "aa"); g.addColorStop(1, "#06080c");
  ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(x - w, y - h + d); ctx.lineTo(x + w, y - h + d); ctx.lineTo(x + w, y + h); ctx.lineTo(x - w, y + h); ctx.closePath(); ctx.fill(); ctx.stroke();
  const spec = ctx.createLinearGradient(x, y - h + d, x, y - h * 0.2); // glossy top edge
  spec.addColorStop(0, "rgba(255,255,255,0.45)"); spec.addColorStop(1, "transparent");
  ctx.fillStyle = spec; ctx.fillRect(x - w + 1, y - h + d + 1, w * 2 - 2, h * 0.7);
}

function drawCube(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, c: string, o: { selected?: boolean; dim?: boolean }) {
  // isometric cube: top rhombus (lit) + left/right faces (shaded), light from top-left like the orbs
  const T = [[x, y - s * 0.6], [x + s, y - s * 0.1], [x, y + s * 0.4], [x - s, y - s * 0.1]];
  const L = [[x - s, y - s * 0.1], [x, y + s * 0.4], [x, y + s * 1.3], [x - s, y + s * 0.8]];
  const R = [[x + s, y - s * 0.1], [x, y + s * 0.4], [x, y + s * 1.3], [x + s, y + s * 0.8]];
  const glow = ctx.createRadialGradient(x, y + s * 0.3, s * 0.3, x, y + s * 0.3, s * 2.2);
  glow.addColorStop(0, c + (o.dim ? "22" : "66")); glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(x, y + s * 0.3, s * 2.2, 0, 7); ctx.fill();
  const face = (pts: number[][], fill: string | CanvasGradient) => {
    ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath();
    ctx.fillStyle = fill; ctx.fill();
  };
  const g = ctx.createLinearGradient(x - s, y - s * 0.6, x + s, y + s * 0.4);
  g.addColorStop(0, "#ffffff"); g.addColorStop(0.25, c); g.addColorStop(1, c + "99");
  face(T, g);
  face(L, c + (o.dim ? "44" : "88"));
  face(R, c + (o.dim ? "22" : "55"));
  ctx.strokeStyle = o.selected ? "#ffffff" : c; ctx.lineWidth = o.selected ? 1.6 : 0.8;
  for (const pts of [T, L, R]) { ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1]); ctx.closePath(); ctx.stroke(); }
}

/** Zoom/pan canvas. draw() works in world coords (0,0 = centre); hit() maps a world point to an item id. */
type Box = { x0: number; x1: number; y0: number; y1: number };
/** View that shows the whole box at the canvas size (never zooms in past 1.1×). */
const fitView = (b: Box, w: number, h: number): View => {
  const z = Math.min(1.1, w / (b.x1 - b.x0), h / (b.y1 - b.y0));
  return { z, x: -((b.x0 + b.x1) / 2) * z, y: -((b.y0 + b.y1) / 2) * z };
};

function ZoomCanvas({ height, draw, hit, onPick, grid = true, tip, fit }: {
  height: number; grid?: boolean; tip?: (id: string) => React.ReactNode; fit?: Box;
  draw: (ctx: CanvasRenderingContext2D, now: number, v: View, w: number, h: number) => void;
  hit: (x: number, y: number, w: number, h: number, z: number) => string | null; onPick: (id: string | null) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ z: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const fitRef = useRef(fit);
  fitRef.current = fit;
  const fitted = useRef(false);
  const gridRef = useRef(grid);
  gridRef.current = grid;
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    const loop = (now: number) => {
      const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      if (fitRef.current && !fitted.current && w > 0) { view.current = fitView(fitRef.current, w, h); fitted.current = true; }
      const v = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      bg.addColorStop(0, "#0b1220"); bg.addColorStop(1, "#03050a");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, dpr * (w / 2 + v.x), dpr * (h / 2 + v.y));
      if (gridRef.current) {
        ctx.strokeStyle = "rgba(56,225,255,0.07)"; ctx.lineWidth = 1 / v.z; // map grid
        const step = 40, ext = 2000;
        for (let gx = -ext; gx <= ext; gx += step) { ctx.beginPath(); ctx.moveTo(gx, -ext); ctx.lineTo(gx, ext); ctx.stroke(); }
        for (let gy = -ext; gy <= ext; gy += step) { ctx.beginPath(); ctx.moveTo(-ext, gy); ctx.lineTo(ext, gy); ctx.stroke(); }
      }
      drawRef.current(ctx, now, v, w, h);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    // gentle zoom: ~5 % per mouse-wheel notch, proportional for trackpads (user: 12 %/notch was too fast)
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const v = view.current; v.z = Math.min(5, Math.max(0.4, v.z * Math.exp(-Math.max(-60, Math.min(60, e.deltaY)) * 0.0009))); };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => { cancelAnimationFrame(raf); cv.removeEventListener("wheel", onWheel); };
  }, []);
  const world = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), v = view.current;
    return { x: (e.clientX - r.left - r.width / 2 - v.x) / v.z, y: (e.clientY - r.top - r.height / 2 - v.y) / v.z, w: r.width, h: r.height, z: v.z };
  };
  return (
    <div className="relative">
      <canvas ref={ref} style={{ height }} className="w-full rounded-lg border border-cyan-300/15 cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
        onMouseMove={(e) => {
          const d = drag.current;
          if (!d) {
            if (!tip) return;
            const p = world(e), id = hit(p.x, p.y, p.w, p.h, p.z), r = e.currentTarget.getBoundingClientRect();
            setHover(id ? { id, x: e.clientX - r.left, y: e.clientY - r.top } : null);
            return;
          }
          setHover(null);
          const v = view.current; v.x += e.clientX - d.x; v.y += e.clientY - d.y;
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 2) d.moved = true;
          d.x = e.clientX; d.y = e.clientY;
        }}
        onMouseUp={(e) => { const d = drag.current; drag.current = null; if (d && !d.moved) { const p = world(e); onPick(hit(p.x, p.y, p.w, p.h, p.z)); } }}
        onMouseLeave={() => { drag.current = null; setHover(null); }} />
      {hover && tip && (
        <div className="pointer-events-none absolute z-10 max-w-[300px] rounded-lg border border-[#d4af37]/40 bg-zinc-950/95 px-3 py-2 text-[12px] leading-snug text-white shadow-xl shadow-black/60"
          style={{ left: Math.min(hover.x + 14, 9999), top: hover.y + 14 }}>
          {tip(hover.id)}
        </div>
      )}
      <div className="absolute top-2 right-2 flex gap-1">
        {([["+", 1.25], ["−", 0.8]] as const).map(([l, k]) => (
          <button key={l} type="button" onClick={() => { const v = view.current; v.z = Math.min(5, Math.max(0.4, v.z * k)); }}
            className="w-7 h-7 rounded-md bg-black/70 border border-white/15 text-white text-sm hover:border-cyan-300/50">{l}</button>
        ))}
        <button type="button" onClick={() => { const cv = ref.current; view.current = fit && cv ? fitView(fit, cv.clientWidth, cv.clientHeight) : { z: 1, x: 0, y: 0 }; }}
          className="px-2 h-7 rounded-md bg-black/70 border border-white/15 text-white/80 text-[11px] hover:border-cyan-300/50">reset</button>
      </div>
    </div>
  );
}

// ── Team ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function TeamMap({ d, sel, onSel }: { d: Data; sel: Id | "all"; onSel: (id: Id | "all") => void }) {
  const sessions = useMemo(() => {
    const ended = new Set(d.endedSessions ?? []);
    const by = new Map<string, { agent: string; last: Live }>();
    for (const e of d.live) if (e.session && !ended.has(e.session) && Date.now() - Date.parse(e.t) < 10 * 60_000) by.set(e.session, { agent: e.agent, last: e });
    return [...by.values()].filter((s) => s.last.event !== "session-end");
  }, [d.live, d.endedSessions]);
  const nm = useMemo(() => agentNames(d), [d]);
  const seen = useRef(new Set<string>());
  const beams = useRef<{ from: { x: number; y: number }; to: { x: number; y: number }; c: string; t0: number }[]>([]);
  const sessPos = useRef<{ key: string; x: number; y: number; s: { agent: string; last: Live } }[]>([]);
  const subPos = useRef<{ key: string; x: number; y: number; k: Sub }[]>([]);
  const links = useRef(new Map<string, { node: string; c: string; src: string; on: boolean; off: number }>()); // live agent→node links
  const gitSeen = useRef(new Map<string, { t0: number; ops: string[]; src: string }>()); // git ops → Code Repo / GitHub links
  const segs = useRef<Seg[]>([]); // every link drawn this frame → hover tooltip (what's running, elapsed, time left)
  const procPos = useRef<{ key: string; x: number; y: number; p: Proc }[]>([]);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // compact layout (~20 % smaller): resource stack at x = NX on the left, agents on a ring around You to its right
  const R = 118, CX = 70, NX = -230, NGAP = 66, NR = 22;
  const JP = { x: -125, y: 75 }; // Fildi's own scheduled jobs, just right of the resource stack
  const pos = (id: Id) => { if (id === "jamie") return { x: CX, y: 0 }; const a = (META[id].ang * Math.PI) / 180; return { x: CX + Math.cos(a) * R, y: Math.sin(a) * R }; };
  const npos = (n: string) => ({ x: NX, y: (NODES[n].row - 1.5) * NGAP });
  /** Hover info for an agent → node link: who, latest action, start of this streak, and a script's ETA if one is running for it. */
  const agentSeg = (src: string, node: string): Omit<Seg, "a" | "b" | "c"> => {
    const sub = src.startsWith("b:") ? src.slice(2) : null, agent = sub ? (d.subagents ?? []).find((k) => k.id === sub)?.agent ?? "claude" : src;
    const evs = d.live.filter((e) => (sub ? e.sub === sub : e.agent === src && !e.sub) && e.kind && KIND[e.kind]?.node === node);
    const last = evs[evs.length - 1];
    let start = last ? Date.parse(last.t) : Date.now();
    for (let i = evs.length - 2; i >= 0; i--) { const t = Date.parse(evs[i].t); if (start - t > LIVE_MS) break; start = t; }
    const proc = (d.procs ?? []).find((p) => p.owner === agent && (node === "db" ? p.links.db : node === "api" ? p.links.api : false));
    const who = sub ? nm(`b:${sub}`, agent) : nm(`s:${d.live.filter((e) => e.agent === src && !e.sub && e.session).at(-1)?.session ?? ""}`, src);
    return { title: `${who} → ${NODES[node]?.label ?? node}`, what: proc ? nice(proc.name) : last ? humanAction(last) : "working",
      startedAt: proc?.startedAt ?? new Date(start).toISOString(), etaS: proc?.etaS ?? null, etaMethod: proc?.etaMethod ?? "unknown" };
  };
  const draw = (ctx: CanvasRenderingContext2D, now: number, v: View) => {
    segs.current = [];
    for (const e of d.live) {
      const k = `${e.t}|${e.agent}|${e.event}|${e.tool}|${e.detail}`;
      if (seen.current.has(k)) continue;
      seen.current.add(k);
      const age = Date.now() - Date.parse(e.t);
      if (reduce || age >= LIVE_MS || !(e.agent in META)) continue;
      const a = pos(e.agent as Id), col = META[e.agent as Id].color, t0 = now - Math.min(age, 800);
      if (e.event === "prompt") beams.current.push({ from: pos("jamie"), to: a, c: META.jamie.color, t0 }); // you → agent
      else if (e.event === "stop" || e.event === "waiting") beams.current.push({ from: a, to: pos("jamie"), c: col, t0 }); // reply to you
      // database / API / web / code work is drawn as persistent live links below, not one-shot beams
    }
    beams.current = beams.current.filter((b) => now - b.t0 < 1100).slice(-40);
    for (const id of ["muse", "claude", "cursor"] as Id[]) {
      const p = pos(id), j = pos("jamie");
      ctx.strokeStyle = META[id].color + "30"; ctx.lineWidth = 1.2 / v.z;
      ctx.beginPath(); ctx.moveTo(j.x, j.y); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    for (const n of Object.keys(NODES)) { // resource nodes: Database · Web · APIs · Repo
      const p = npos(n), c0 = n === "github" ? GITHUB : KIND[NODES[n].kinds[0]].color, c = c0 === "#ffffff" ? "#cbd5e1" : c0;
      if (n === "db") drawCylinder(ctx, p.x, p.y, NR, c); // shapes: Database = cylinder, APIs = box, Code Repo = folder, Web = orb
      else if (n === "api") drawBox(ctx, p.x, p.y, NR, c);
      else if (n === "repo") drawRepo(ctx, p.x, p.y, NR, c);
      else if (n === "github") drawOctagon(ctx, p.x, p.y, NR, c);
      else drawOrb(ctx, p.x, p.y, NR, c, { now, reduce });
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.shadowColor = "rgba(0,0,0,0.95)"; ctx.shadowBlur = 5; ctx.fillStyle = "#ffffff";
      const words = n === "repo" ? ["</>", "Code Repo"] : [NODES[n].label];
      let fs = 12; ctx.font = `700 ${fs}px ui-sans-serif`;
      while (fs > 11 && Math.max(...words.map((t) => ctx.measureText(t).width)) > NR * 2.1) { fs -= 0.5; ctx.font = `700 ${fs}px ui-sans-serif`; }
      const cy = n === "api" ? p.y + NR * 0.25 : n === "db" ? p.y + NR * 0.12 : n === "repo" ? p.y + NR * 0.2 : p.y;
      words.forEach((t, i) => ctx.fillText(t, p.x, cy + (i - (words.length - 1) / 2) * (fs + 2)));
      ctx.shadowBlur = 0; ctx.textBaseline = "alphabetic";
    }
    // Waiting for you: one slow signal agent → You every ~3 s until you reply
    if (!reduce) for (const id of ["claude", "cursor"] as const) {
      if (!d.status[id]?.waiting) continue;
      const k = (now % 3000) / 2000;
      if (k > 1) continue;
      const a = pos(id), j = pos("jamie");
      ctx.fillStyle = WAIT; ctx.shadowColor = WAIT; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(a.x + (j.x - a.x) * k, a.y + (j.y - a.y) * k, 3.2, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }
    for (const b of beams.current) {
      const k = Math.min(1, (now - b.t0) / 850);
      ctx.fillStyle = b.c; ctx.shadowColor = b.c; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(b.from.x + (b.to.x - b.from.x) * k, b.from.y + (b.to.y - b.from.y) * k, 3, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }
    // Live links: an agent (or background agent) whose latest event of a kind is < 2 min old and not followed by a stop keeps a
    // line to that node with pulses travelling along it; when the activity ends the link fades out over ~1 s.
    const lastKind = new Map<string, { t: number; node: string; c: string; src: string }>();
    const stopAt = new Map<string, number>();
    const running = new Set((d.subagents ?? []).filter((k) => k.running).map((k) => k.id));
    for (const e of d.live) {
      const t = Date.parse(e.t), src = e.sub ? `b:${e.sub}` : e.agent;
      if (e.event === "stop" || e.event === "session-end" || e.event === "waiting") { stopAt.set(e.agent, t); continue; }
      const node = e.kind ? KIND[e.kind]?.node : undefined;
      if (!node || !(e.agent in META)) continue;
      const key = `${src}|${node}`, prev = lastKind.get(key);
      if (!prev || t > prev.t) lastKind.set(key, { t, node, c: KIND[e.kind!].color, src });
    }
    const nowMs = Date.now();
    for (const l of links.current.values()) l.on = false;
    for (const [key, v] of lastKind) {
      const agent = v.src.startsWith("b:") ? null : v.src;
      const active = nowMs - v.t < LIVE_MS && (agent ? (stopAt.get(agent) ?? 0) < v.t : running.has(v.src.slice(2)));
      if (!active) continue;
      const l = links.current.get(key) ?? { node: v.node, c: v.c, src: v.src, on: true, off: 0 };
      l.on = true; l.c = v.c; l.off = 0; links.current.set(key, l);
    }
    for (const [key, l] of links.current) {
      if (!l.on && !l.off) l.off = now;
      const fade = l.on ? 1 : Math.max(0, 1 - (now - l.off) / 1000);
      if (fade <= 0) { links.current.delete(key); continue; }
      const from = l.src.startsWith("b:") ? subPos.current.find((b) => b.key === l.src) : l.src in META ? pos(l.src as Id) : null;
      if (!from) continue;
      const to = npos(l.node), alpha = Math.round(fade * 160).toString(16).padStart(2, "0");
      if (l.on) segs.current.push({ a: from, b: to, c: l.c, ...agentSeg(l.src, l.node) });
      ctx.strokeStyle = l.c + alpha; ctx.lineWidth = 1.6 / v.z; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
      if (!reduce) for (let i = 0; i < 3; i++) { // signal pulses
        const k = ((now / 4200 + i / 3) % 1);
        ctx.globalAlpha = fade; ctx.fillStyle = l.c; ctx.shadowColor = l.c; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(from.x + (to.x - from.x) * k, from.y + (to.y - from.y) * k, 2.8, 0, 7); ctx.fill();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
    }
    const pulseLink = (a: { x: number; y: number }, b: { x: number; y: number }, c: string, alpha = 1, info?: Omit<Seg, "a" | "b" | "c">) => {
      if (info) segs.current.push({ a, b, c, ...info });
      ctx.strokeStyle = c + Math.round(alpha * 160).toString(16).padStart(2, "0"); ctx.lineWidth = 1.6 / v.z;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      if (!reduce) for (let i = 0; i < 3; i++) {
        const k = (now / 4200 + i / 3) % 1;
        ctx.globalAlpha = alpha; ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 12;
        ctx.beginPath(); ctx.arc(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, 2.8, 0, 7); ctx.fill();
        ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }
    };
    // Fildi's scheduled jobs: Jobs → APIs while a vendor source is being called, Jobs → Database while a job runs
    const jb = d.jobs, jobsActive = !!jb && (jb.running.length > 0 || jb.links.api || jb.links.db);
    const jobProcs = (d.procs ?? []).filter((p) => p.owner === "jobs");
    const jobInfo = (to: string) => {
      const p = jobProcs.find((x) => (to === "api" ? x.links.api : x.links.db));
      return p ? { title: `Jobs → ${to === "api" ? "APIs" : "Database"}`, what: nice(p.name), startedAt: p.startedAt, etaS: p.etaS, etaMethod: p.etaMethod }
        : { title: `Jobs → ${to === "api" ? "APIs" : "Database"}`, what: to === "api" ? `calling ${jb?.activeSources.join(", ") || "vendor APIs"}` : (jb?.running.map((r) => r.name).join(", ") || "job wrote its run file"), etaMethod: "unknown", etaS: null };
    };
    if (jb?.links.api) pulseLink(JP, npos("api"), JOBS, 1, jobInfo("api"));
    if (jb?.links.db) pulseLink(JP, npos("db"), JOBS, 1, jobInfo("db"));
    drawOrb(ctx, JP.x, JP.y, 17, JOBS, { working: jobsActive, now, reduce });
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.shadowColor = "rgba(0,0,0,0.9)"; ctx.shadowBlur = 4;
    ctx.fillStyle = "#ffffff"; ctx.font = "700 11px ui-sans-serif"; ctx.fillText("Jobs", JP.x, JP.y);
    ctx.shadowBlur = 0; ctx.textBaseline = "alphabetic";
    // Git: commit → Code Repo pulse · push → agent → Code Repo → GitHub · pull → GitHub → Code Repo (each ~10 s from first sight);
    // Muse commits from the cloud (last 2 min) → GitHub → Code Repo
    const nowMs2 = Date.now();
    for (const e of d.live) {
      if (!e.git?.length || nowMs2 - Date.parse(e.t) > 90_000) continue;
      const key = `${e.t}|${e.session}|${e.sub ?? ""}`;
      if (!gitSeen.current.has(key)) gitSeen.current.set(key, { t0: now, ops: e.git, src: e.sub ? `b:${e.sub}` : e.agent });
    }
    for (const c of d.gitHour ?? []) {
      if (c.agent !== "muse" || nowMs2 - Date.parse(c.t) > 2 * 60_000) continue;
      const key = `muse|${c.t}`;
      if (!gitSeen.current.has(key)) gitSeen.current.set(key, { t0: now, ops: ["pull"], src: "muse" });
    }
    const repoP = npos("repo"), ghP = npos("github");
    for (const [key, g] of gitSeen.current) {
      const age = now - g.t0;
      if (age > 10_000) { if (age > 120_000) gitSeen.current.delete(key); continue; }
      const alpha = age > 9_000 ? Math.max(0, 1 - (age - 9_000) / 1000) : 1;
      const from = g.src.startsWith("b:") ? subPos.current.find((b) => b.key === g.src) : g.src in META ? pos(g.src as Id) : null;
      const col = g.src in META ? META[g.src as Id].color : "#38e1ff";
      if (g.ops.includes("commit")) {
        const q = (age % 1200) / 1200;
        ctx.strokeStyle = KIND.code.color + Math.round((1 - q) * alpha * 200).toString(16).padStart(2, "0"); ctx.lineWidth = 2 / v.z;
        ctx.beginPath(); ctx.arc(repoP.x, repoP.y, NR + 4 + q * 16, 0, 7); ctx.stroke();
      }
      const who = g.src.startsWith("b:") ? nm(g.src) : META[g.src as Id]?.label ?? g.src;
      if (g.ops.includes("push")) { if (from) pulseLink(from, repoP, col, alpha, { title: `${who} → Code Repo`, what: "git push", etaMethod: "unknown", etaS: null });
        pulseLink(repoP, ghP, GITHUB, alpha, { title: "Code Repo → GitHub", what: `push by ${who}`, etaS: Math.max(0, Math.round((10_000 - age) / 1000)), etaMethod: "link shown ~10 s" }); }
      if (g.ops.includes("pull")) pulseLink(ghP, repoP, GITHUB, alpha, { title: "GitHub → Code Repo", what: g.src === "muse" ? "Muse commit from the cloud" : `pull by ${who}`, etaS: Math.max(0, Math.round((10_000 - age) / 1000)), etaMethod: "link shown ~10 s" });
    }
    sessPos.current = [];
    subPos.current = [];
    const byAgent = new Map<string, typeof sessions>();
    for (const s of sessions) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);
    for (const [agent, list] of byAgent) {
      if (!(agent in META)) continue;
      const c = pos(agent as Id), col = META[agent as Id].color;
      list.forEach((s, i) => {
        const a = (i / list.length) * Math.PI * 2 - Math.PI / 2; // fixed, evenly spaced (no orbit)
        const sx = c.x + Math.cos(a) * 46, sy = c.y + Math.sin(a) * 46;
        const live = Date.now() - Date.parse(s.last.t) < LIVE_MS;
        ctx.strokeStyle = col + "50"; ctx.lineWidth = 1 / v.z; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sx, sy); ctx.stroke();
        drawOrb(ctx, sx, sy, live ? 6 : 4.5, col, { working: false, now, reduce });
        sessPos.current.push({ key: `s:${agent}:${i}`, x: sx, y: sy, s });
        // background agents launched from this session: small "running" orbs hanging off it
        const kids = (d.subagents ?? []).filter((k) => k.running && k.session && k.session === s.last.session);
        kids.forEach((k, j) => {
          const ang = a + (j - (kids.length - 1) / 2) * 0.6, kx = sx + Math.cos(ang) * 22, ky = sy + Math.sin(ang) * 22;
          ctx.strokeStyle = col + "70"; ctx.lineWidth = 1 / v.z; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(kx, ky); ctx.stroke();
          drawOrb(ctx, kx, ky, 4, col, { working: true, now, reduce });
          subPos.current.push({ key: `b:${k.id}`, x: kx, y: ky, k });
        });
      });
    }
    // Long-running scripts (between hook events): a "running" mini-orb under whoever launched it, linked to Database / APIs
    procPos.current = [];
    const byOwner = new Map<string, Proc[]>();
    for (const p of d.procs ?? []) byOwner.set(p.owner, [...(byOwner.get(p.owner) ?? []), p]);
    for (const [ow, list] of byOwner) {
      const c = ow === "jobs" ? JP : pos(ow as Id), col = ow === "jobs" ? JOBS : META[ow as Id].color;
      list.forEach((p, i) => {
        const ang = Math.PI / 2 + (i - (list.length - 1) / 2) * 0.55, rr = ow === "jobs" ? 32 : 40;
        const x = c.x + Math.cos(ang) * rr, y = c.y + Math.sin(ang) * rr;
        ctx.strokeStyle = col + "70"; ctx.lineWidth = 1 / v.z; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(x, y); ctx.stroke();
        const info = { what: nice(p.name), startedAt: p.startedAt, etaS: p.etaS, etaMethod: p.etaMethod };
        if (p.links.db) pulseLink({ x, y }, npos("db"), col, 0.9, { title: "→ Database", ...info });
        if (p.links.api) pulseLink({ x, y }, npos("api"), col, 0.9, { title: `→ APIs${p.sources.length ? ` (${p.sources.join(", ")})` : ""}`, ...info });
        drawOrb(ctx, x, y, 5, col, { working: true, now, reduce });
        procPos.current.push({ key: `p:${p.pid}`, x, y, p });
      });
    }
    for (const id of Object.keys(META) as Id[]) {
      const p = pos(id), st = id === "claude" || id === "cursor" ? d.status[id] : null;
      const r = id === "jamie" ? 25 : 21;
      const museOff = id === "muse" && d.muse && !d.muse.running;
      drawOrb(ctx, p.x, p.y, r, museOff ? "#71717a" : META[id].color, {
        working: !!st?.working, selected: sel === id, now, reduce,
        ring: st?.lastKind ? KIND[st.lastKind]?.color : undefined, pulse: attention(st ?? undefined),
      });
      const label = META[id].label; // name inside the orb, sized to fit
      let fs = 14;
      ctx.font = `700 ${fs}px ui-sans-serif`;
      while (fs > 7 && ctx.measureText(label).width > r * 1.7) { fs -= 0.5; ctx.font = `700 ${fs}px ui-sans-serif`; }
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.shadowColor = "rgba(0,0,0,0.85)"; ctx.shadowBlur = 4;
      ctx.fillStyle = "#ffffff"; ctx.fillText(label, p.x, p.y);
      ctx.shadowBlur = 0; ctx.textBaseline = "alphabetic";
    }
  };
  const hit = (x: number, y: number, _w: number, _h: number, z: number) => {
    for (const id of Object.keys(META) as Id[]) { const p = pos(id); if (Math.hypot(p.x - x, p.y - y) < 28) return id; }
    for (const n of Object.keys(NODES)) { const p = npos(n); if (Math.hypot(p.x - x, p.y - y) < 28) return `n:${n}`; }
    if (Math.hypot(JP.x - x, JP.y - y) < 22) return "jobs";
    for (const bp of subPos.current) if (Math.hypot(bp.x - x, bp.y - y) < 8) return bp.key;
    for (const sp of sessPos.current) if (Math.hypot(sp.x - x, sp.y - y) < 10) return sp.key;
    for (const pp of procPos.current) if (Math.hypot(pp.x - x, pp.y - y) < 9) return pp.key;
    let best = -1, bd = 6 / z; // links: within ~6 screen px of the segment
    segs.current.forEach((g, i) => {
      const dx = g.b.x - g.a.x, dy = g.b.y - g.a.y, L = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((x - g.a.x) * dx + (y - g.a.y) * dy) / L));
      const dd = Math.hypot(g.a.x + t * dx - x, g.a.y + t * dy - y);
      if (dd < bd) { bd = dd; best = i; }
    });
    return best >= 0 ? `l:${best}` : null;
  };
  // Tooltips: 2–3 very short lines — what · time · (optional) one count. "~" = estimate, "?" = unknown.
  const left = (s: number | null | undefined) => (s != null ? `~${dur(s)} left` : "? left");
  const Lines = ({ a, b, c, color }: { a: React.ReactNode; b?: React.ReactNode; c?: React.ReactNode; color?: string }) => (
    <><div className="font-semibold" style={color ? { color } : undefined}>{a}</div>{b && <div className="text-white/85">{b}</div>}{c && <div className="text-white/60">{c}</div>}</>
  );
  const tip = (id: string) => {
    if (id.startsWith("l:")) {
      const g = segs.current[+id.slice(2)];
      if (!g) return null;
      const el = g.startedAt ? (Date.now() - Date.parse(g.startedAt)) / 1000 : null;
      return <Lines color={g.c} a={g.what} b={`${el != null ? `${dur(el)} in · ` : ""}${left(g.etaS)}`} c={g.title} />;
    }
    if (id.startsWith("p:")) {
      const p = procPos.current.find((x) => x.key === id)?.p;
      if (!p) return null;
      return <Lines a={nice(p.name)} b={`${dur(p.secs)} in · ${left(p.etaS)}`} c={p.owner === "jobs" ? "scheduled job" : `started by ${META[p.owner as Id]?.label}`} />;
    }
    if (id === "jobs") {
      const jb = d.jobs;
      const now = (d.procs ?? []).filter((p) => p.owner === "jobs").map((p) => nice(p.name));
      const calls = (jb?.sources ?? []).reduce((s, x) => s + x.calls, 0);
      return <Lines color={JOBS} a="Scheduled jobs" b={now.length ? `running: ${now.join(", ")}` : jb?.ran.length ? `last ran ${ago(jb.ran[0].at)} ago` : "idle"} c={calls ? `${calls} API calls today` : undefined} />;
    }
    if (id === "n:github") {
      const n = (d.gitHour ?? []).length;
      return <Lines color={GITHUB} a="GitHub" b={n ? `${n} commit${n > 1 ? "s" : ""} in the last hour` : "quiet"} />;
    }
    if (id.startsWith("n:")) {
      const n = NODES[id.slice(2)];
      const tot = n.kinds.reduce((s, k) => s + Object.values(d.activity1h?.[k] ?? {}).reduce((a, b) => a + b, 0), 0);
      const busy = n.kinds.flatMap((k) => Object.keys(d.activity1h?.[k] ?? {})).map((a) => META[a as Id]?.label ?? a);
      return <Lines a={n.label} b={tot ? `${tot} actions in the last hour` : "quiet"} c={busy.length ? [...new Set(busy)].join(", ") : undefined} />;
    }
    if (id.startsWith("b:")) {
      const k = subPos.current.find((x) => x.key === id)?.k;
      if (!k) return null;
      return <Lines color={META[k.agent as Id]?.color} a={`${nm(id, k.agent)} · ${k.task.slice(0, 40)}`} b={`${dur((Date.now() - Date.parse(k.startedAt)) / 1000)} in`} c={`${k.actions} actions`} />;
    }
    if (id.startsWith("s:")) {
      const sp = sessPos.current.find((x) => x.key === id);
      if (!sp) return null;
      const sid = sp.s.last.session, evs = d.live.filter((e) => e.session === sid && !e.sub);
      const prompt = [...evs].reverse().find((e) => e.event === "prompt" && e.detail);
      const who = nm(`s:${sid}`, sp.s.agent);
      return <Lines color={META[sp.s.agent as Id]?.color} a={prompt?.detail ? `${who} · ${prompt.detail.slice(0, 40)}` : who} b={`${humanAction(sp.s.last)} · ${ago(sp.s.last.t)} ago`} />;
    }
    const m = META[id as Id], a = d.agents.find((x) => x.id === id);
    const st = id === "claude" || id === "cursor" ? d.status[id] : null;
    if (id === "jamie") return <Lines color={m.color} a="You" b="approve scores, trades, agents" />;
    const state = st ? (st.waiting ? "waiting for you" : st.looping ? "repeating itself?" : st.working ? "working" : `idle ${ago(st.lastEvent?.t)}`)
      : id === "muse" ? (d.muse?.running ? "app open" : "app closed") : `last commit ${ago(a?.lastActive)}`;
    return <Lines color={m.color} a={st?.doing ? `${m.label} · ${st.doing.slice(0, 40)}` : m.label} b={state}
      c={st && (st.errors1h ?? 0) > 0 ? `${st.errors1h} errors this hour` : `${a?.commits24h ?? 0} commits today`} />;
  };
  return (
    <div className="space-y-1">
      <ZoomCanvas height={380} grid={false} fit={{ x0: NX - NR - 30, x1: CX + R + 21 + 70, y0: -2 * NGAP - NR - 22, y1: 2 * NGAP + NR + 22 }} draw={draw} hit={hit} tip={tip} onPick={(id) => { if (!id || id.startsWith("s:") || id.startsWith("n:") || id.startsWith("b:")) { if (!id) onSel("all"); return; } onSel(id as Id); }} />
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-white/70">
        {(["web", "database", "api", "code", "reading"] as const).map((k) => (
          <span key={k} className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: KIND[k].color }} />{KIND[k].label}</span>
        ))}
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: WAIT }} />waiting for you</span>
        <span className="inline-flex items-center gap-1"><span className="w-2 h-2 rounded-full" style={{ background: "#f87171" }} />looping / errors</span>
      </div>
    </div>
  );
}

/** Plan headroom. Claude: statusline rate_limits (5-hour / 7-day used %) saved by ~/.claude/statusline.sh. */
function Available({ id, d }: { id: Id; d: Data }) {
  const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "—");
  const cell = (text: React.ReactNode, tip: React.ReactNode, cls = "text-white/60") => (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild><span className={cn("cursor-default", cls)}>{text}</span></TooltipTrigger>
      <TooltipContent side="bottom" className={TIP}>{tip}</TooltipContent>
    </Tooltip>
  );
  if (id === "claude") {
    const l = d.limits?.claude;
    if (!l || l.fiveHour.pct == null) return cell("see /usage", "Claude Code shares plan limits with its status line; the number appears here after the next status-line refresh in a Claude session. Until then type /usage in Claude.");
    const left = Math.max(0, 100 - l.fiveHour.pct);
    return cell(<>{Math.round(left)}% left · resets {hm(l.fiveHour.resetsAt)}</>,
      <>5-hour window: {Math.round(l.fiveHour.pct)}% used, resets {hm(l.fiveHour.resetsAt)}.{l.sevenDay.pct != null && <> Weekly: {Math.round(l.sevenDay.pct)}% used{l.sevenDay.resetsAt ? `, resets ${new Date(l.sevenDay.resetsAt).toLocaleDateString()}` : ""}.</>} As of {hm(l.at)}.</>,
      left < 20 ? "text-red-300 font-semibold" : left < 50 ? "text-amber-200" : "text-emerald-300");
  }
  if (id === "cursor") return cell("n/a", "Cursor dashboard only (cursor.com/dashboard): Cursor doesn't record usage on this Mac.");
  return cell("n/a", "Muse is a desktop app that keeps no usage logs on this Mac; only whether the app is open is visible.");
}

/** Step timeline: an agent's last 30 actions in order, activity colour, time, plain-English action, gap since the previous step. */
function Timeline({ d, agent }: { d: Data; agent: Id }) {
  const steps = d.live.filter((e) => e.agent === agent && !["session-start", "session-end"].includes(e.event)).slice(-30);
  const nm = useMemo(() => agentNames(d), [d]);
  const hms = (t: string) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  const gap = (ms: number) => (ms < 6e4 ? `+${Math.round(ms / 1000)}s` : `+${Math.round(ms / 6e4)}m`);
  return (
    <div className="space-y-1">
      <div className="text-[11px] uppercase tracking-widest text-[#d4af37]">{META[agent].label} · last {steps.length} steps</div>
      {steps.length === 0 ? <p className="text-[12px] text-white/50">No logged steps in the last 24 h.</p> : (
        <div className={cn(GRID_WRAP, "max-h-[320px] overflow-y-auto")}>
          <table className="w-full border-collapse"><tbody>{steps.map((e, i) => {
            const c = e.event === "waiting" ? WAIT : e.event === "fail" ? "#f87171" : e.event === "prompt" ? META.jamie.color : KIND[e.kind ?? "other"]?.color ?? "#a1a1aa";
            const what = e.event === "prompt" ? `you: ${e.detail ?? ""}` : e.event === "stop" ? "replied to you" : e.event === "waiting" ? `waiting: ${e.detail ?? "needs you"}` : e.event === "sub-start" ? `started ${e.sub ? nm(`b:${e.sub}`, e.agent) : "a helper"}` : e.event === "sub-stop" ? `${e.sub ? nm(`b:${e.sub}`, e.agent) : "helper"} finished` : humanAction(e);
            return (
              <tr key={`${e.t}-${i}`} className={gridRow(i)}>
                <td className={cn(GRID_TD, "w-6")}><span className="inline-block w-2 h-2 rounded-full" style={{ background: c }} /></td>
                <td className={cn(GRID_TD, "text-white/60 whitespace-nowrap w-24")}>{hms(e.t)}</td>
                <td className={cn(GRID_TD, "text-white/45 whitespace-nowrap w-14 text-right")}>{i ? gap(Date.parse(e.t) - Date.parse(steps[i - 1].t)) : ""}</td>
                <td className={cn(GRID_TD, "text-white/90 truncate max-w-0 w-full")} title={what}><span className="text-white/45">{evName(nm, e)} · </span>{what}</td>
              </tr>
            );
          })}</tbody></table>
        </div>
      )}
    </div>
  );
}

function TeamPanel({ d }: { d: Data }) {
  const [focus, setFocus] = useState<Id | "all">("all");
  const rows = useMemo(() => {
    const nm = agentNames(d);
    const live = d.live.map((e) => ({ t: e.t, agent: e.agent, name: evName(nm, e), what: humanAction(e) }));
    const ev = d.events.map((e) => ({ t: e.t, agent: e.from, name: META[e.from as Id]?.label ?? e.from, what: e.kind === "ask" ? `→ ${META[e.to as Id]?.label ?? e.to}: ${e.text}` : `commit · ${e.text}` }));
    return [...live, ...ev].filter((r) => focus === "all" || r.agent === focus).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 150);
  }, [d, focus]);
  return (
    <div className="space-y-3">
      <TeamMap d={d} sel={focus} onSel={setFocus} />
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left")}>Agent</th><th className={cn(GRID_TH, "text-left")}>Status</th>
            <th className={cn(GRID_TH, "text-right")}>Errors 1h</th>
            <th className={cn(GRID_TH, "text-right")}>Tokens used</th><th className={cn(GRID_TH, "text-right")}>Available</th>
            <th className={cn(GRID_TH, "text-right")}>Commits 24h / 7d</th><th className={cn(GRID_TH, "text-right")}>Queue</th>
            <th className={cn(GRID_TH, "text-right")}>Actions 24h</th><th className={cn(GRID_TH, "text-left")}>Last action</th>
          </tr></thead>
          <tbody>{d.agents.filter((a) => a.id !== "jamie").map((a, i) => {
            const st = a.id === "claude" || a.id === "cursor" ? d.status[a.id] : undefined;
            return (
              <tr key={a.id} className={cn(gridRow(i), "cursor-pointer", focus === a.id && "bg-white/[0.06]")} onClick={() => setFocus(focus === a.id ? "all" : a.id)}>
                <td className={cn(GRID_TD, "font-semibold")} style={{ color: META[a.id].color }}>{META[a.id].label}</td>
                <td className={cn(GRID_TD, "whitespace-nowrap", st?.waiting ? "text-yellow-300" : st?.looping ? "text-red-300" : st?.working ? "text-emerald-300" : "text-white/70")}>
                  {st ? (st.waiting ? "● waiting for you" : st.looping ? "● looping?" : st.working ? `● ${KIND[st.lastKind ?? "other"]?.label ?? "working"}` : `idle ${ago(st.lastEvent?.t)}`)
                    : a.id === "muse" ? `${d.muse?.running ? "app open" : "app closed"} · ${ago(a.lastActive)}` : `last commit ${ago(a.lastActive)}`}
                </td>
                <td className={cn(GRID_TD, "text-right", (st?.errors1h ?? 0) > 0 ? "text-red-300 font-semibold" : "text-white/50")}>{st ? st.errors1h ?? 0 : "—"}</td>
                <td className={cn(GRID_TD, "text-right text-white whitespace-nowrap")}>
                  {a.id === "claude" ? <>{fmt(d.windows.current.out)} <span className="text-white/50">5h</span> · {fmt(a.tokens?.at(-1)?.output ?? 0)} <span className="text-white/50">today</span></> : "—"}
                </td>
                <td className={cn(GRID_TD, "text-right whitespace-nowrap")}><Available id={a.id} d={d} /></td>
                <td className={cn(GRID_TD, "text-right text-white")}>{a.commits24h} / {a.commits7d}</td>
                <td className={cn(GRID_TD, "text-right", a.queue > 20 ? "text-red-300" : "text-white")}>{a.queue}</td>
                <td className={cn(GRID_TD, "text-right text-white/80")}>{st ? st.tools24h : "—"}</td>
                <td className={cn(GRID_TD, "text-white/70 truncate max-w-[280px]")}>{st?.lastEvent ? humanAction(st.lastEvent) : "—"}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      {focus !== "all" && <Timeline d={d} agent={focus} />}
      <div className="flex items-center gap-2 text-[12px] text-white/60">
        Activity {focus === "all" ? "· all agents" : `· ${META[focus].label}`}
        {focus !== "all" && <button type="button" onClick={() => setFocus("all")} className="text-[#d4af37] hover:underline">show all</button>}
      </div>
      <div className={cn(GRID_WRAP, "max-h-[420px] overflow-y-auto")}>
        <table className="w-full border-collapse">
          <thead className="sticky top-0"><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left w-16")}>When</th><th className={cn(GRID_TH, "text-left w-20")}>Agent</th><th className={cn(GRID_TH, "text-left")}>What</th>
          </tr></thead>
          <tbody>{rows.length === 0 ? (
            <tr><td colSpan={3} className={cn(GRID_TD, "text-white/50")}>No recent activity.</td></tr>
          ) : rows.map((r, i) => (
            <tr key={`${r.t}-${i}`} className={gridRow(i)}>
              <td className={cn(GRID_TD, "text-white/55")}>{ago(r.t)}</td>
              <td className={cn(GRID_TD, "font-medium")} style={{ color: META[r.agent as Id]?.color ?? "#d4d4d8" }}>{r.name}</td>
              <td className={cn(GRID_TD, "text-white/85 truncate max-w-0 w-full")} title={r.what}>{r.what}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ── Ideas ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function IdeasPanel({ ideas, unread = {} }: { ideas: Idea[]; unread?: Record<string, number> }) {
  const [sel, setSel] = useState<string | null>(null);
  const [showParked, setShowParked] = useState(false);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Declutter: by default only open stages + done rows filed ≤ 7 days ago (no done-date in ASKS; filing date is the proxy).
  const recent = (d: string) => !!d && Date.now() - Date.parse(d) <= 7 * 864e5;
  const shown = ideas.filter((i) => showParked || (i.phase !== "parked" && i.phase !== "verified" && (i.phase !== "done" || recent(i.date))));
  const cols = PHASES.filter((p) => shown.some((i) => i.phase === p) || ["needs you", "filed", "reviewed", "building"].includes(p));
  const visible = shown.filter((i) => cols.includes(i.phase as (typeof PHASES)[number]));
  const dismiss = async (id: string) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/agents/ideas/${encodeURIComponent(id)}/dismiss`, { method: "POST", credentials: "include" });
      if (r.ok) { setSel(null); await qc.invalidateQueries({ queryKey: ["agents-overview"] }); }
    } finally { setBusy(false); }
  };
  const active = ideas.find((i) => i.id === sel) ?? null;
  const COLW = 130, S = 13, ROWH = 46, PER = 3; // cubes per row inside a phase column
  const layout = useMemo(() => {
    const out: { idea: Idea; x: number; y: number }[] = [];
    const x0 = -((cols.length - 1) * COLW) / 2;
    cols.forEach((ph, ci) => {
      shown.filter((i) => i.phase === ph).forEach((idea, k) => {
        out.push({ idea, x: x0 + ci * COLW + ((k % PER) - (PER - 1) / 2) * 36, y: -110 + Math.floor(k / PER) * ROWH });
      });
    });
    return out;
  }, [shown.map((i) => i.id).join(), cols.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const draw = (ctx: CanvasRenderingContext2D, _now: number, v: View) => {
    const x0 = -((cols.length - 1) * COLW) / 2;
    cols.forEach((ph, ci) => {
      const n = shown.filter((i) => i.phase === ph).length;
      ctx.fillStyle = PHASE_COLOR[ph]; ctx.font = "600 12px ui-sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${ph.toUpperCase()} · ${n}`, x0 + ci * COLW, -150);
      ctx.strokeStyle = PHASE_COLOR[ph] + "25"; ctx.lineWidth = 1 / v.z;
      ctx.beginPath(); ctx.moveTo(x0 + ci * COLW + COLW / 2, -165); ctx.lineTo(x0 + ci * COLW + COLW / 2, 400); ctx.stroke();
    });
    for (const { idea, x, y } of layout) {
      drawCube(ctx, x, y, S, PHASE_COLOR[idea.phase] ?? "#e879f9", { selected: sel === idea.id, dim: idea.phase === "parked" });
      const n = unread[idea.id] ?? 0;
      if (n > 0) { // agent replied since Jamie's last comment
        const bx = x + S * 0.95, by = y - S * 0.75;
        ctx.fillStyle = "#d4af37"; ctx.shadowColor = "#d4af37"; ctx.shadowBlur = 8;
        ctx.beginPath(); ctx.arc(bx, by, 6.5, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        ctx.fillStyle = "#000"; ctx.font = "700 9px ui-sans-serif"; ctx.textAlign = "center"; ctx.fillText(n > 9 ? "9+" : String(n), bx, by + 3);
      }
    }
  };
  const tip = (id: string) => {
    const i = ideas.find((x) => x.id === id);
    if (!i) return null;
    return (
      <>
        <div className="flex items-baseline gap-2"><span className="font-semibold">{i.id}</span>
          <span style={{ color: PHASE_COLOR[i.phase] }}>{i.phase}</span>{i.date && <span className="text-white/50">{i.date.slice(5)}</span>}</div>
        <div className="mt-0.5">{i.title}</div>
        <div className="mt-1 text-[11px] text-white/50">{unread[i.id] ? `${unread[i.id]} new repl${unread[i.id] > 1 ? "ies" : "y"} · ` : ""}click for details</div>
      </>
    );
  };
  const hit = (x: number, y: number) => layout.find((p) => Math.abs(p.x - x) < S + 2 && y > p.y - S && y < p.y + S * 1.4)?.idea.id ?? null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[12px] text-white">
        <span>Muse ideas by stage · {visible.length} shown</span>
        <InfoTip>Each cube = one Muse → Cursor row in research/common/ASKS.md, grouped by where it is: needs you → filed → reviewed (Claude)
          → building (Cursor) → done. Zoom in for IDs and titles; click a cube for the full context.</InfoTip>
        <button type="button" onClick={() => setShowParked((v) => !v)} className="ml-auto text-[11px] border border-white/15 rounded-md px-2 py-1 text-white/80 hover:border-[#d4af37]/50">
          {showParked ? "Hide done / parked" : "Show done / parked"}
        </button>
      </div>
      <ZoomCanvas height={380} draw={draw} hit={hit} tip={tip} onPick={setSel} />
      {active && (
        <div className="rounded-lg border px-3 py-2.5 space-y-1.5" style={{ borderColor: (PHASE_COLOR[active.phase] ?? "#e879f9") + "66", background: (PHASE_COLOR[active.phase] ?? "#e879f9") + "0d" }}>
          <div className="flex flex-wrap items-baseline gap-2 text-[12px]">
            <span className="font-semibold text-white">{active.id}</span>
            <span style={{ color: PHASE_COLOR[active.phase] }}>{active.phase}</span>
            <span className="text-white/80">{active.phase === "needs you" ? "for you" : `${active.date} · Muse → Cursor${active.quant ? " · quant" : ""}`}</span>
          </div>
          <p className="text-[14px] text-white font-medium leading-snug">{active.title}</p>
          <p className="text-[13px] text-white leading-relaxed whitespace-pre-line">{active.blurb || "No Context section in the ask file yet."}</p>
          <div className="flex items-center gap-2">
            <p className="text-[11px] text-white/80">Status: {active.status}</p>
            {/^A\d+$/.test(active.id) && active.phase !== "needs you" && (
              <button type="button" disabled={busy} onClick={() => dismiss(active.id)}
                className="ml-auto rounded-md border border-white/20 px-2.5 py-1 text-[11px] text-white hover:border-red-300/60 hover:text-red-200 disabled:opacity-50">
                {busy ? "Dismissing…" : "Dismiss"}
              </button>
            )}
          </div>
          {active.phase === "needs you" && <NeedsThread item={active.id} />}
        </div>
      )}
    </div>
  );
}

type Comment = { id: number; item: string; author: string; body: string; created_at: string };
const AUTHOR_COLOR: Record<string, string> = { claude: META.claude.color, cursor: META.cursor.color, muse: META.muse.color };

/** Jamie ↔ agents thread on a NEEDS YOU item. No AI cost: Claude reads Jamie's comments only via its prompt hook (needs-inbox.mjs). */
function NeedsThread({ item }: { item: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const { data } = useQuery({
    queryKey: ["needs-comments", item],
    queryFn: async (): Promise<Comment[]> => {
      const r = await fetch(`/api/agents/needs/${encodeURIComponent(item)}/comments`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).comments;
    },
    refetchInterval: 30_000,
  });
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      const r = await fetch(`/api/agents/needs/${encodeURIComponent(item)}/comments`, {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }),
      });
      if (r.ok) {
        setText("");
        await Promise.all([qc.invalidateQueries({ queryKey: ["needs-comments", item] }), qc.invalidateQueries({ queryKey: ["agents-overview"] })]);
      }
    } finally { setSending(false); }
  };
  const when = (t: string) => new Date(t).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
  return (
    <div className={cn(GRID_WRAP, "p-2.5 space-y-2")}>
      <div className="text-[11px] uppercase tracking-widest text-[#d4af37]">Thread</div>
      <div className="max-h-[260px] overflow-y-auto space-y-1.5">
        {(data ?? []).length === 0 && <p className="text-[12px] text-white/60">No replies yet. Claude sees your message the next time you talk to it.</p>}
        {(data ?? []).map((c) => c.author === "jamie" ? (
          <div key={c.id} className="flex justify-end">
            <div className="max-w-[80%] rounded-lg border border-[#d4af37]/40 bg-[#d4af37]/10 px-2.5 py-1.5">
              <div className="text-[13px] text-white whitespace-pre-wrap">{c.body}</div>
              <div className="text-[10px] text-[#d4af37]/80 text-right mt-0.5">You · {when(c.created_at)}</div>
            </div>
          </div>
        ) : (
          <div key={c.id} className="flex justify-start">
            <div className="max-w-[80%] rounded-lg border bg-white/[0.04] px-2.5 py-1.5" style={{ borderColor: (AUTHOR_COLOR[c.author] ?? "#a1a1aa") + "55" }}>
              <div className="text-[13px] text-white whitespace-pre-wrap">{c.body}</div>
              <div className="text-[10px] mt-0.5" style={{ color: AUTHOR_COLOR[c.author] ?? "#a1a1aa" }}>{c.author[0].toUpperCase() + c.author.slice(1)} · {when(c.created_at)}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="flex items-end gap-2">
        <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} rows={2} placeholder="Reply…"
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }}
          className="flex-1 resize-y rounded-md border border-white/15 bg-black/60 px-2 py-1.5 text-[13px] text-white placeholder:text-white/40 focus:outline-none focus:border-[#d4af37]/60" />
        <button type="button" disabled={sending || !text.trim()} onClick={() => void send()}
          className="rounded-md bg-[#d4af37] px-3 py-1.5 text-[12px] font-semibold text-black disabled:opacity-40">{sending ? "Sending…" : "Send"}</button>
      </div>
    </div>
  );
}

// ── Usage / Rules / Skills ───────────────────────────────────────────────────────────────────────────────────────────
function Usage({ d }: { d: Data }) {
  const { current, peak, hours } = d.windows;
  const pct = peak.out ? Math.round((current.out / peak.out) * 100) : 0;
  const claude = d.agents.find((a) => a.id === "claude")?.tokens ?? [];
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-widest text-[#d4af37]">Claude · this 5-hour window</div>
          <div className="text-2xl font-semibold text-white tabular-nums">{fmt(current.out)} <span className="text-sm font-normal text-white/60">tokens out · {current.req} calls</span></div>
        </div>
        <div className="flex-1">
          <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
            <div className={cn("h-full rounded-full", pct > 80 ? "bg-red-400" : pct > 50 ? "bg-amber-300" : "bg-cyan-300")} style={{ width: `${Math.min(100, pct)}%` }} />
          </div>
          <div className="text-[12px] text-white/60 mt-1">{pct}% of your busiest 5-hour window this week ({fmt(peak.out)})</div>
        </div>
        <InfoTip>Claude plans cap usage per 5-hour window, but the cap isn't exposed to apps, so this compares to your own busiest window in
          7 days. Output tokens shown; input is mostly cached. Source: Claude Code session logs. Cursor and Muse don't log tokens locally.</InfoTip>
      </div>
      <div className={cn(GRID_WRAP, "p-2")}>
        <div className="text-[11px] uppercase tracking-widest text-[#d4af37] mb-1 px-1">Claude tokens out per hour · 48 h</div>
        <ResponsiveContainer width="100%" height={130}>
          <BarChart data={hours}>
            <XAxis dataKey="t" tickFormatter={(t: string) => new Date(t).getHours().toString()} tick={{ fontSize: 11, fill: "#a1a1aa" }} interval={5} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v: number) => fmt(v)} tick={{ fontSize: 11, fill: "#a1a1aa" }} width={36} axisLine={false} tickLine={false} />
            <RTooltip contentStyle={{ background: "#09090b", border: "1px solid #38e1ff55", fontSize: 12 }} labelFormatter={(t: string) => new Date(t).toLocaleString()} formatter={(v: number) => [fmt(v), "output"]} />
            <Bar dataKey="out" fill="#38e1ff" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left")}>Day</th><th className={cn(GRID_TH, "text-right")}>Output</th>
            <th className={cn(GRID_TH, "text-right")}>Input (incl. cache)</th><th className={cn(GRID_TH, "text-right")}>Calls</th>
          </tr></thead>
          <tbody>{[...claude].reverse().map((t, i) => (
            <tr key={t.day} className={gridRow(i)}>
              <td className={cn(GRID_TD, "text-white/80")}>{t.day}</td>
              <td className={cn(GRID_TD, "text-right text-white font-semibold")}>{fmt(t.output)}</td>
              <td className={cn(GRID_TD, "text-right text-white/70")}>{fmt(t.input + t.cacheRead + t.cacheWrite)}</td>
              <td className={cn(GRID_TD, "text-right text-white/70")}>{t.requests}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
      <p className="text-[12px] text-white/60">Cursor: {d.status.cursor.tools24h} actions in 24 h (hooks) · Muse: {d.agents.find((a) => a.id === "muse")?.commits24h ?? 0} commits in 24 h · tokens not tracked for either</p>
    </div>
  );
}

function Rules({ d }: { d: Data }) {
  return (
    <div className={GRID_WRAP}>
      <table className="w-full border-collapse">
        <thead><tr className={GRID_HEADER}><th className={cn(GRID_TH, "text-left w-48")}>Who</th><th className={cn(GRID_TH, "text-left")}>Rule</th></tr></thead>
        <tbody>{d.rules.map((r, i) => (
          <tr key={`${r.group}-${r.title}`} className={gridRow(i)}>
            <td className={cn(GRID_TD, "text-[#d4af37]/90 whitespace-nowrap")}>{i === 0 || d.rules[i - 1].group !== r.group ? r.group : ""}</td>
            <td className={cn(GRID_TD, "text-white/90")}>{r.title}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Skills({ d }: { d: Data }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[12px] text-white/70">
        Skills load only when a task needs them (saves tokens). Unused for 7 days → merge or drop.
        <InfoTip>Counts come from Claude Code session logs (Skill / Read of .claude/skills/*.md). Cursor's own rules live in .cursor/rules.</InfoTip>
      </div>
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left")}>Skill</th><th className={cn(GRID_TH, "text-right")}>Loads 7d</th><th className={cn(GRID_TH, "text-left")}>What it's for</th>
          </tr></thead>
          <tbody>{d.skills.map((s, i) => (
            <tr key={s.name} className={gridRow(i)}>
              <td className={cn(GRID_TD, "text-white font-medium whitespace-nowrap")}>{s.name}</td>
              <td className={cn(GRID_TD, "text-right", s.uses7d ? "text-cyan-200 font-semibold" : "text-white/35")}>{s.uses7d || "unused"}</td>
              <td className={cn(GRID_TD, "text-white/70")}>{s.about}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

export function AgentsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["agents-overview"],
    queryFn: async (): Promise<Data> => {
      const r = await fetch("/api/agents/overview", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 15_000, // live events are a cheap file tail; commits/tokens are cached server-side
  });
  const [tab, setTab] = useState<(typeof SUB_TABS)[number]>("Stage");
  if (isLoading || !data) return <p className="text-xs text-white/50">Loading…</p>;
  const looks = (["claude", "cursor"] as const).map((x) => attention(data.status[x])).filter(Boolean);
  const needLook = looks.length;
  const stageNeedsRed = looks.includes("#f87171");
  const ideas = data.ideas ?? [];
  return (
    <div className="rounded-lg border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <div className="ml-auto inline-flex rounded-md border border-[#d4af37]/30 overflow-hidden text-[12px] font-semibold">
          {SUB_TABS.map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={cn("relative px-3 py-1.5 transition-colors", tab === t ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/70 hover:text-[#d4af37]")}>
              {t}
              {t === "Stage" && needLook > 0 && ( // agents waiting on you / looping / erroring → check Stage
                <span className={cn("ml-1.5 inline-flex min-w-4 h-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-black animate-pulse motion-reduce:animate-none",
                  stageNeedsRed ? "bg-red-400" : "bg-yellow-300")}>{needLook}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      {tab === "Stage" && <TeamPanel d={data} />}
      {tab === "Ideas" && <IdeasPanel ideas={ideas} unread={data.needsUnread} />}
      {tab === "Usage" && <Usage d={data} />}
      {tab === "Rules" && <Rules d={data} />}
      {tab === "Skills" && <Skills d={data} />}
    </div>
  );
}
