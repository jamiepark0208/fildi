/**
 * Settings › Agents (Claude + Cursor styling, user 2026-10-15). Real records only: hook events (Claude Code + Cursor →
 * ~/.fildi/agent-events.jsonl), commits (git), hand-offs + Muse ideas (ASKS rows), Claude tokens (session logs).
 * Team / Ideas = zoomable maps (scroll = zoom, drag = pan, click = details): 3D orbs for agents, 3D cubes for ideas.
 * Beams and spinning rings only for actions in the last 2 min. Tables use the shared Rankings grid look.
 * Data: GET /api/agents/overview.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { GRID_HEADER, GRID_TD, GRID_TH, GRID_WRAP, gridRow } from "@/lib/score-explain-format";

type Id = "muse" | "claude" | "cursor" | "jamie";
type Tok = { day: string; input: number; cacheRead: number; cacheWrite: number; output: number; requests: number };
type Agent = { id: Id; commits24h: number; commits7d: number; lastActive: string | null; queue: number; sent7d: number; received7d: number; tokens: Tok[] | null };
type Ev = { t: string; from: Id; to: Id | "repo"; kind: "commit" | "ask"; text: string; ref?: string };
type Live = { t: string; agent: string; event: string; tool?: string; session?: string; detail?: string };
type Status = { working: boolean; lastEvent: Live | null; sessions10m: number; tools24h: number };
type Win = { out: number; inp: number; req: number };
type Idea = { id: string; date: string; from: Id; to: Id; title: string; status: string; phase: string; quant: boolean; blurb: string };
type Data = {
  agents: Agent[]; events: Ev[]; live: Live[]; ideas?: Idea[];
  status: Record<"claude" | "cursor", Status>;
  windows: { current: Win; peak: Win; hours: { t: string; out: number; req: number }[] };
  rules: { group: string; title: string }[]; skills: { name: string; about: string; uses7d: number }[];
};
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
const SUB_TABS = ["Team", "Ideas", "Usage", "Rules", "Skills"] as const;

function InfoTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild><button type="button" className="text-white/40 hover:text-white"><Info className="w-3.5 h-3.5" /></button></TooltipTrigger>
      <TooltipContent side="bottom" className={TIP}>{children}</TooltipContent>
    </Tooltip>
  );
}

/** Hook payload → short plain English (hide raw shell). (Cursor) */
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
function drawOrb(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, c: string, o: { working?: boolean; selected?: boolean; now: number; reduce: boolean }) {
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
    ctx.strokeStyle = c; ctx.lineWidth = 2.5; ctx.shadowColor = c; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.arc(x, y, r + 7, a, a + 1.7); ctx.stroke(); ctx.shadowBlur = 0;
  }
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
function ZoomCanvas({ height, draw, hit, onPick, hint }: {
  height: number; hint: string;
  draw: (ctx: CanvasRenderingContext2D, now: number, v: View, w: number, h: number) => void;
  hit: (x: number, y: number, w: number, h: number) => string | null; onPick: (id: string | null) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef<View>({ z: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    let raf = 0;
    const loop = (now: number) => {
      const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const v = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      bg.addColorStop(0, "#0b1220"); bg.addColorStop(1, "#03050a");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * v.z, 0, 0, dpr * v.z, dpr * (w / 2 + v.x), dpr * (h / 2 + v.y));
      ctx.strokeStyle = "rgba(56,225,255,0.07)"; ctx.lineWidth = 1 / v.z; // map grid
      const step = 40, ext = 2000;
      for (let gx = -ext; gx <= ext; gx += step) { ctx.beginPath(); ctx.moveTo(gx, -ext); ctx.lineTo(gx, ext); ctx.stroke(); }
      for (let gy = -ext; gy <= ext; gy += step) { ctx.beginPath(); ctx.moveTo(-ext, gy); ctx.lineTo(ext, gy); ctx.stroke(); }
      drawRef.current(ctx, now, v, w, h);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const v = view.current; v.z = Math.min(5, Math.max(0.4, v.z * (e.deltaY < 0 ? 1.12 : 0.89))); };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => { cancelAnimationFrame(raf); cv.removeEventListener("wheel", onWheel); };
  }, []);
  const world = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), v = view.current;
    return { x: (e.clientX - r.left - r.width / 2 - v.x) / v.z, y: (e.clientY - r.top - r.height / 2 - v.y) / v.z, w: r.width, h: r.height };
  };
  return (
    <div className="relative">
      <canvas ref={ref} style={{ height }} className="w-full rounded-lg border border-cyan-300/15 cursor-grab active:cursor-grabbing"
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY, moved: false }; }}
        onMouseMove={(e) => {
          const d = drag.current; if (!d) return;
          const v = view.current; v.x += e.clientX - d.x; v.y += e.clientY - d.y;
          if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 2) d.moved = true;
          d.x = e.clientX; d.y = e.clientY;
        }}
        onMouseUp={(e) => { const d = drag.current; drag.current = null; if (d && !d.moved) { const p = world(e); onPick(hit(p.x, p.y, p.w, p.h)); } }}
        onMouseLeave={() => { drag.current = null; }} />
      <div className="absolute top-2 right-2 flex gap-1">
        {([["+", 1.25], ["−", 0.8]] as const).map(([l, k]) => (
          <button key={l} type="button" onClick={() => { const v = view.current; v.z = Math.min(5, Math.max(0.4, v.z * k)); }}
            className="w-7 h-7 rounded-md bg-black/70 border border-white/15 text-white text-sm hover:border-cyan-300/50">{l}</button>
        ))}
        <button type="button" onClick={() => { view.current = { z: 1, x: 0, y: 0 }; }}
          className="px-2 h-7 rounded-md bg-black/70 border border-white/15 text-white/80 text-[11px] hover:border-cyan-300/50">reset</button>
      </div>
      <div className="absolute bottom-2 left-2.5 text-[11px] text-white/45">{hint}</div>
    </div>
  );
}

// ── Team ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
function TeamMap({ d, sel, onSel }: { d: Data; sel: Id | "all"; onSel: (id: Id | "all") => void }) {
  const sessions = useMemo(() => {
    const by = new Map<string, { agent: string; last: Live }>();
    for (const e of d.live) if (e.session && Date.now() - Date.parse(e.t) < 30 * 60_000) by.set(e.session, { agent: e.agent, last: e });
    return [...by.values()];
  }, [d.live]);
  const seen = useRef(new Set<string>());
  const beams = useRef<{ from: Id; t0: number }[]>([]);
  const reduce = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const R = 150;
  const pos = (id: Id) => { if (id === "jamie") return { x: 0, y: 0 }; const a = (META[id].ang * Math.PI) / 180; return { x: Math.cos(a) * R, y: Math.sin(a) * R }; };
  const draw = (ctx: CanvasRenderingContext2D, now: number, v: View) => {
    for (const e of d.live) {
      const k = `${e.t}|${e.agent}|${e.tool}|${e.detail}`;
      if (seen.current.has(k)) continue;
      seen.current.add(k);
      const age = Date.now() - Date.parse(e.t);
      if (!reduce && age < LIVE_MS && (e.agent === "claude" || e.agent === "cursor")) beams.current.push({ from: e.agent as Id, t0: now - Math.min(age, 800) });
    }
    beams.current = beams.current.filter((b) => now - b.t0 < 1100).slice(-30);
    for (const id of ["muse", "claude", "cursor"] as Id[]) {
      const p = pos(id);
      ctx.strokeStyle = META[id].color + "30"; ctx.lineWidth = 1.2 / v.z;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(p.x, p.y); ctx.stroke();
    }
    for (const b of beams.current) {
      const p = pos(b.from), k = Math.min(1, (now - b.t0) / 850), c = META[b.from].color;
      ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = 16;
      ctx.beginPath(); ctx.arc(p.x * (1 - k), p.y * (1 - k), 3, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
    }
    const byAgent = new Map<string, typeof sessions>();
    for (const s of sessions) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);
    for (const [agent, list] of byAgent) {
      if (!(agent in META)) continue;
      const c = pos(agent as Id), col = META[agent as Id].color;
      list.forEach((s, i) => {
        const a = (i / list.length) * Math.PI * 2 + (reduce ? 0 : now / 9000);
        const sx = c.x + Math.cos(a) * 62, sy = c.y + Math.sin(a) * 62;
        const live = Date.now() - Date.parse(s.last.t) < LIVE_MS;
        ctx.strokeStyle = col + "50"; ctx.lineWidth = 1 / v.z; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sx, sy); ctx.stroke();
        drawOrb(ctx, sx, sy, live ? 6 : 4.5, col, { working: false, now, reduce });
        if (v.z > 1.4) {
          ctx.fillStyle = "#e2e8f0"; ctx.font = `${11 / v.z * 1.3}px ui-sans-serif`; ctx.textAlign = "left";
          ctx.fillText(`${humanAction(s.last)} · ${ago(s.last.t)}`, sx + 10, sy + 4);
        }
      });
    }
    for (const id of Object.keys(META) as Id[]) {
      const p = pos(id), st = id === "claude" || id === "cursor" ? d.status[id] : null;
      drawOrb(ctx, p.x, p.y, id === "jamie" ? 30 : 25, META[id].color, { working: !!st?.working, selected: sel === id, now, reduce });
      ctx.fillStyle = "#ffffff"; ctx.font = "600 13px ui-sans-serif"; ctx.textAlign = "center";
      ctx.fillText(META[id].label, p.x, p.y + (id === "jamie" ? 48 : 43));
      ctx.fillStyle = "rgba(255,255,255,0.6)"; ctx.font = "11px ui-sans-serif";
      const a = d.agents.find((x) => x.id === id);
      const sub = id === "jamie" ? "decides" : st?.working ? "working" : st ? `idle ${ago(st.lastEvent?.t)}` : `${a?.commits24h ?? 0} commits 24h`;
      ctx.fillText(sub, p.x, p.y + (id === "jamie" ? 62 : 57));
    }
  };
  const hit = (x: number, y: number) => {
    for (const id of Object.keys(META) as Id[]) { const p = pos(id); if (Math.hypot(p.x - x, p.y - y) < 34) return id; }
    return null;
  };
  return <ZoomCanvas height={360} draw={draw} hit={hit} onPick={(id) => onSel((id as Id) ?? "all")}
    hint="scroll = zoom · drag = pan · click an orb · zoom in to see live sessions" />;
}

function TeamPanel({ d }: { d: Data }) {
  const [focus, setFocus] = useState<Id | "all">("all");
  const rows = useMemo(() => {
    const live = d.live.map((e) => ({ t: e.t, agent: e.agent, what: humanAction(e) }));
    const ev = d.events.map((e) => ({ t: e.t, agent: e.from, what: e.kind === "ask" ? `→ ${META[e.to as Id]?.label ?? e.to}: ${e.text}` : `commit · ${e.text}` }));
    return [...live, ...ev].filter((r) => focus === "all" || r.agent === focus).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 150);
  }, [d, focus]);
  return (
    <div className="space-y-3">
      <TeamMap d={d} sel={focus} onSel={setFocus} />
      <div className={GRID_WRAP}>
        <table className="w-full border-collapse">
          <thead><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left")}>Agent</th><th className={cn(GRID_TH, "text-left")}>Status</th>
            <th className={cn(GRID_TH, "text-right")}>Commits 24h / 7d</th><th className={cn(GRID_TH, "text-right")}>Queue</th>
            <th className={cn(GRID_TH, "text-right")}>Actions 24h</th><th className={cn(GRID_TH, "text-left")}>Last action</th>
          </tr></thead>
          <tbody>{d.agents.filter((a) => a.id !== "jamie").map((a, i) => {
            const st = a.id === "claude" || a.id === "cursor" ? d.status[a.id] : undefined;
            return (
              <tr key={a.id} className={cn(gridRow(i), "cursor-pointer", focus === a.id && "bg-white/[0.06]")} onClick={() => setFocus(focus === a.id ? "all" : a.id)}>
                <td className={cn(GRID_TD, "font-semibold")} style={{ color: META[a.id].color }}>{META[a.id].label}</td>
                <td className={cn(GRID_TD, st?.working ? "text-emerald-300" : "text-white/70")}>{st ? (st.working ? "● working" : `idle ${ago(st.lastEvent?.t)}`) : `last commit ${ago(a.lastActive)}`}</td>
                <td className={cn(GRID_TD, "text-right text-white")}>{a.commits24h} / {a.commits7d}</td>
                <td className={cn(GRID_TD, "text-right", a.queue > 20 ? "text-red-300" : "text-white")}>{a.queue}</td>
                <td className={cn(GRID_TD, "text-right text-white/80")}>{st ? st.tools24h : "—"}</td>
                <td className={cn(GRID_TD, "text-white/70 truncate max-w-[280px]")}>{st?.lastEvent ? humanAction(st.lastEvent) : "—"}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
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
              <td className={cn(GRID_TD, "font-medium")} style={{ color: META[r.agent as Id]?.color ?? "#d4d4d8" }}>{META[r.agent as Id]?.label ?? r.agent}</td>
              <td className={cn(GRID_TD, "text-white/85 truncate max-w-0 w-full")} title={r.what}>{r.what}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

// ── Ideas ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function IdeasPanel({ ideas }: { ideas: Idea[] }) {
  const [sel, setSel] = useState<string | null>(null);
  const [showParked, setShowParked] = useState(false);
  const cols = PHASES.filter((p) => showParked || (p !== "parked" && p !== "done"));
  const visible = ideas.filter((i) => cols.includes(i.phase as (typeof PHASES)[number]));
  const active = ideas.find((i) => i.id === sel) ?? null;
  const COLW = 130, S = 13, ROWH = 46, PER = 3; // cubes per row inside a phase column
  const layout = useMemo(() => {
    const out: { idea: Idea; x: number; y: number }[] = [];
    const x0 = -((cols.length - 1) * COLW) / 2;
    cols.forEach((ph, ci) => {
      ideas.filter((i) => i.phase === ph).forEach((idea, k) => {
        out.push({ idea, x: x0 + ci * COLW + ((k % PER) - (PER - 1) / 2) * 36, y: -110 + Math.floor(k / PER) * ROWH });
      });
    });
    return out;
  }, [ideas, cols.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const draw = (ctx: CanvasRenderingContext2D, _now: number, v: View) => {
    const x0 = -((cols.length - 1) * COLW) / 2;
    cols.forEach((ph, ci) => {
      const n = ideas.filter((i) => i.phase === ph).length;
      ctx.fillStyle = PHASE_COLOR[ph]; ctx.font = "600 12px ui-sans-serif"; ctx.textAlign = "center";
      ctx.fillText(`${ph.toUpperCase()} · ${n}`, x0 + ci * COLW, -150);
      ctx.strokeStyle = PHASE_COLOR[ph] + "25"; ctx.lineWidth = 1 / v.z;
      ctx.beginPath(); ctx.moveTo(x0 + ci * COLW + COLW / 2, -165); ctx.lineTo(x0 + ci * COLW + COLW / 2, 400); ctx.stroke();
    });
    for (const { idea, x, y } of layout) {
      drawCube(ctx, x, y, S, PHASE_COLOR[idea.phase] ?? "#e879f9", { selected: sel === idea.id, dim: idea.phase === "parked" });
      if (v.z > 1.5) {
        ctx.fillStyle = "#ffffff"; ctx.font = `${10 / v.z * 1.4}px ui-sans-serif`; ctx.textAlign = "center";
        ctx.fillText(idea.id, x, y + S * 1.3 + 12 / v.z * 1.4);
        if (v.z > 2.4) { ctx.fillStyle = "rgba(255,255,255,0.65)"; ctx.fillText(idea.title.slice(0, 26), x, y + S * 1.3 + 24 / v.z * 1.4); }
      }
    }
  };
  const hit = (x: number, y: number) => layout.find((p) => Math.abs(p.x - x) < S + 2 && y > p.y - S && y < p.y + S * 1.4)?.idea.id ?? null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-[12px] text-white/70">
        <span>Muse ideas by stage · {visible.length} shown</span>
        <InfoTip>Each cube = one Muse → Cursor row in research/common/ASKS.md, grouped by where it is: needs you → filed → reviewed (Claude)
          → building (Cursor) → done. Zoom in for IDs and titles; click a cube for the full context.</InfoTip>
        <button type="button" onClick={() => setShowParked((v) => !v)} className="ml-auto text-[11px] border border-white/15 rounded-md px-2 py-1 text-white/80 hover:border-[#d4af37]/50">
          {showParked ? "Hide done / parked" : "Show done / parked"}
        </button>
      </div>
      <ZoomCanvas height={360} draw={draw} hit={hit} onPick={setSel} hint="scroll = zoom · drag = pan · click a cube · zoom in for titles" />
      {active && (
        <div className="rounded-lg border px-3 py-2.5 space-y-1.5" style={{ borderColor: (PHASE_COLOR[active.phase] ?? "#e879f9") + "66", background: (PHASE_COLOR[active.phase] ?? "#e879f9") + "0d" }}>
          <div className="flex flex-wrap items-baseline gap-2 text-[12px]">
            <span className="font-semibold text-white">{active.id}</span>
            <span style={{ color: PHASE_COLOR[active.phase] }}>{active.phase}</span>
            <span className="text-white/50">{active.date} · Muse → Cursor{active.quant ? " · quant" : ""}</span>
          </div>
          <p className="text-[14px] text-white font-medium leading-snug">{active.title}</p>
          <p className="text-[13px] text-white/75 leading-relaxed">{active.blurb || "No Context section in the ask file yet."}</p>
          <p className="text-[11px] text-white/45">Status: {active.status}</p>
        </div>
      )}
      <div className={cn(GRID_WRAP, "max-h-[360px] overflow-y-auto")}>
        <table className="w-full border-collapse">
          <thead className="sticky top-0"><tr className={GRID_HEADER}>
            <th className={cn(GRID_TH, "text-left w-16")}>ID</th><th className={cn(GRID_TH, "text-left")}>Idea</th>
            <th className={cn(GRID_TH, "text-left w-24")}>Stage</th><th className={cn(GRID_TH, "text-right w-24")}>Filed</th>
          </tr></thead>
          <tbody>{visible.map((i, k) => (
            <tr key={i.id} className={cn(gridRow(k), "cursor-pointer", sel === i.id && "bg-white/[0.06]")} onClick={() => setSel(sel === i.id ? null : i.id)}>
              <td className={cn(GRID_TD, "text-white/60 font-mono")}>{i.id}</td>
              <td className={cn(GRID_TD, "text-white/90")}>{i.title}</td>
              <td className={GRID_TD} style={{ color: PHASE_COLOR[i.phase] }}>{i.phase}</td>
              <td className={cn(GRID_TD, "text-right text-white/55")}>{i.date.slice(5)}</td>
            </tr>
          ))}</tbody>
        </table>
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
  const [tab, setTab] = useState<(typeof SUB_TABS)[number]>("Team");
  if (isLoading || !data) return <p className="text-xs text-white/50">Loading…</p>;
  const working = (["claude", "cursor"] as const).filter((a) => data.status[a].working);
  const ideas = data.ideas ?? [];
  const activeIdeas = ideas.filter((i) => !["parked", "done", "verified"].includes(i.phase)).length;
  return (
    <div className="rounded-lg border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <span className="text-white">
          {working.length ? <>Working: {working.map((a) => <span key={a} className="font-semibold" style={{ color: META[a].color }}> {META[a].label}</span>)}</> : "No agent working right now"}
        </span>
        <span className="text-white/55">· Claude {fmt(data.windows.current.out)} tokens this 5h · {activeIdeas} ideas active</span>
        <div className="ml-auto inline-flex rounded-md border border-[#d4af37]/30 overflow-hidden text-[12px] font-semibold">
          {SUB_TABS.map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={cn("px-3 py-1.5 transition-colors", tab === t ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-white/70 hover:text-[#d4af37]")}>{t}</button>
          ))}
        </div>
      </div>
      {tab === "Team" && <TeamPanel d={data} />}
      {tab === "Ideas" && <IdeasPanel ideas={ideas} />}
      {tab === "Usage" && <Usage d={data} />}
      {tab === "Rules" && <Rules d={data} />}
      {tab === "Skills" && <Skills d={data} />}
    </div>
  );
}
