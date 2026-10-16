/**
 * Settings › Agents (Claude, user 2026-10-15). Real records only:
 *   live hook events (Claude Code + Cursor hooks → ~/.fildi/agent-events.jsonl) · commits (git) · hand-offs (ASKS rows) ·
 *   Claude tokens (session logs). Sub-tabs: Map · Activity · Usage · Rules · Skills. Data: GET /api/agents/overview.
 * Map: wheel = zoom, drag = pan. Beams/rings animate only for actions in the last 2 min (= actually working).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from "recharts";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Id = "muse" | "claude" | "cursor" | "jamie";
type Tok = { day: string; input: number; cacheRead: number; cacheWrite: number; output: number; requests: number };
type Agent = { id: Id; commits24h: number; commits7d: number; lastActive: string | null; queue: number; sent7d: number; received7d: number; tokens: Tok[] | null };
type Ev = { t: string; from: Id; to: Id | "repo"; kind: "commit" | "ask"; text: string; ref?: string };
type Live = { t: string; agent: string; event: string; tool?: string; session?: string; detail?: string };
type Status = { working: boolean; lastEvent: Live | null; sessions10m: number; tools24h: number };
type Win = { out: number; inp: number; req: number };
type Data = {
  agents: Agent[]; events: Ev[]; live: Live[]; status: Record<"claude" | "cursor", Status>;
  windows: { current: Win; peak: Win; hours: { t: string; out: number; req: number }[] };
  rules: { group: string; title: string }[]; skills: { name: string; about: string; uses7d: number }[];
};

const META: Record<Id, { label: string; role: string; color: string; ang: number; r: number }> = {
  jamie: { label: "You", role: "decide", color: "#d4af37", ang: 0, r: 0 },
  muse: { label: "Muse", role: "ideas", color: "#c084fc", ang: -150, r: 1 },
  claude: { label: "Claude", role: "review · research", color: "#22d3ee", ang: -30, r: 1 },
  cursor: { label: "Cursor", role: "build", color: "#34d399", ang: 90, r: 1 },
};
const LIVE_MS = 2 * 60_000;
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const ago = (t: string | null | undefined) => {
  if (!t) return "—";
  const m = (Date.now() - Date.parse(t)) / 6e4;
  return m < 1 ? "now" : m < 60 ? `${Math.round(m)}m` : m < 2880 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const TIP = "max-w-[340px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug";

function InfoTip({ children }: { children: React.ReactNode }) {
  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild><button type="button" className="text-zinc-500 hover:text-zinc-300"><Info className="w-3.5 h-3.5" /></button></TooltipTrigger>
      <TooltipContent side="bottom" className={TIP}>{children}</TooltipContent>
    </Tooltip>
  );
}

/** Hub-and-spoke map: you → agents → live sessions (shown when zoomed in). */
function MapView({ d }: { d: Data }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const view = useRef({ z: 1, x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  const [, force] = useState(0);
  const sessions = useMemo(() => {
    const by = new Map<string, { agent: string; last: Live }>();
    for (const e of d.live) if (e.session && Date.now() - Date.parse(e.t) < 30 * 60_000) by.set(e.session, { agent: e.agent, last: e });
    return [...by.entries()].map(([id, v]) => ({ id, ...v }));
  }, [d.live]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    const seen = new Set<string>();
    let beams: { from: Id; t0: number; c: string }[] = [];
    const draw = (now: number) => {
      const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
      const { z, x: px, y: py } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#05070b"; ctx.fillRect(0, 0, w, h);
      ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (w / 2 + px), dpr * (h / 2 + py));
      const R = Math.min(w, h) * 0.34;
      // hex-ish grid
      ctx.strokeStyle = "rgba(34,211,238,0.05)"; ctx.lineWidth = 1 / z;
      for (let r = R / 2; r < R * 3; r += R / 2) { ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.stroke(); }
      const pos = (id: Id) => { const m = META[id], a = (m.ang * Math.PI) / 180; return { x: Math.cos(a) * R * m.r, y: Math.sin(a) * R * m.r }; };
      // spawn beams from genuinely new live events only
      for (const e of d.live) {
        const k = `${e.t}|${e.agent}|${e.tool}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const age = Date.now() - Date.parse(e.t);
        if (age < LIVE_MS && (e.agent === "claude" || e.agent === "cursor") && !reduce) beams.push({ from: e.agent as Id, t0: now - Math.min(age, 900), c: META[e.agent as Id].color });
      }
      beams = beams.filter((b) => now - b.t0 < 1200).slice(-30);
      // spokes
      for (const id of ["muse", "claude", "cursor"] as Id[]) {
        const p = pos(id);
        ctx.strokeStyle = "rgba(255,255,255,0.07)"; ctx.lineWidth = 1 / z; ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(p.x, p.y); ctx.stroke();
      }
      for (const b of beams) {
        const p = pos(b.from), k = Math.min(1, (now - b.t0) / 900);
        const x = p.x * (1 - k), y = p.y * (1 - k);
        ctx.fillStyle = b.c; ctx.shadowColor = b.c; ctx.shadowBlur = 14;
        ctx.beginPath(); ctx.arc(x, y, 2.6, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
      }
      // sessions (layer 2): satellites around their agent
      const byAgent = new Map<string, typeof sessions>();
      for (const s of sessions) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);
      for (const [agent, list] of byAgent) {
        if (!(agent in META)) continue;
        const c = pos(agent as Id), col = META[agent as Id].color;
        list.forEach((s, i) => {
          const a = (i / list.length) * Math.PI * 2 + (reduce ? 0 : now / 9000);
          const sx = c.x + Math.cos(a) * 58, sy = c.y + Math.sin(a) * 58;
          const live = Date.now() - Date.parse(s.last.t) < LIVE_MS;
          ctx.strokeStyle = col + "55"; ctx.lineWidth = 1 / z; ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(sx, sy); ctx.stroke();
          ctx.fillStyle = live ? col : col + "55"; ctx.beginPath(); ctx.arc(sx, sy, live ? 5 : 3.5, 0, 7); ctx.fill();
          if (z > 1.4) {
            ctx.fillStyle = "#cbd5e1"; ctx.font = `${10 / z * 1.2}px ui-sans-serif`; ctx.textAlign = "left";
            ctx.fillText(`${s.last.tool ?? s.last.event} ${ago(s.last.t)}`, sx + 8, sy + 3);
            if (z > 2.2 && s.last.detail) { ctx.fillStyle = "#64748b"; ctx.fillText(s.last.detail.slice(0, 48), sx + 8, sy + 3 + 12 / z * 1.2); }
          }
        });
      }
      // agent orbs (layer 1)
      for (const id of Object.keys(META) as Id[]) {
        const m = META[id], p = pos(id);
        const st = id === "claude" || id === "cursor" ? d.status[id] : null;
        const working = !!st?.working;
        const r = id === "jamie" ? 30 : 24;
        const glow = ctx.createRadialGradient(p.x, p.y, r * 0.4, p.x, p.y, r * (working ? 2.6 : 1.8));
        glow.addColorStop(0, m.color + (working ? "aa" : "44")); glow.addColorStop(1, "transparent");
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.6, 0, 7); ctx.fill();
        ctx.fillStyle = "#0b1118"; ctx.strokeStyle = m.color + (working ? "" : "88"); ctx.lineWidth = 1.5 / z;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
        if (working && !reduce) { // spinning arc = actually working (event < 2 min)
          const a = now / 400;
          ctx.strokeStyle = m.color; ctx.lineWidth = 2.5 / z; ctx.beginPath(); ctx.arc(p.x, p.y, r + 6, a, a + 1.6); ctx.stroke();
        }
        ctx.fillStyle = "#f1f5f9"; ctx.font = `600 12px ui-sans-serif`; ctx.textAlign = "center"; ctx.fillText(m.label, p.x, p.y + 4);
        ctx.fillStyle = "#94a3b8"; ctx.font = "10px ui-sans-serif";
        const sub = id === "jamie" ? "" : working ? "working" : st ? `idle · ${ago(st.lastEvent?.t)}` : `${d.agents.find((a) => a.id === id)?.commits24h ?? 0} commits 24h`;
        ctx.fillText(sub, p.x, p.y + r + 14);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [d, sessions]);
  useEffect(() => { // native listener: React's wheel handler is passive, so the page would scroll while zooming
    const cv = ref.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => { e.preventDefault(); const v = view.current; v.z = Math.min(4, Math.max(0.5, v.z * (e.deltaY < 0 ? 1.12 : 0.89))); force((n) => n + 1); };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div className="relative">
      <canvas ref={ref}
        onMouseDown={(e) => { drag.current = { x: e.clientX, y: e.clientY }; }}
        onMouseMove={(e) => { if (!drag.current) return; const v = view.current; v.x += e.clientX - drag.current.x; v.y += e.clientY - drag.current.y; drag.current = { x: e.clientX, y: e.clientY }; }}
        onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}
        className="w-full h-[380px] rounded-lg border border-cyan-400/10 cursor-grab active:cursor-grabbing" />
      <div className="absolute top-2 right-2 flex gap-1">
        {[["+", 1.25], ["−", 0.8]].map(([l, k]) => (
          <button key={l as string} type="button" onClick={() => { const v = view.current; v.z = Math.min(4, Math.max(0.5, v.z * (k as number))); }}
            className="w-6 h-6 rounded bg-zinc-900/80 border border-white/10 text-zinc-300 text-xs">{l}</button>
        ))}
        <button type="button" onClick={() => { view.current = { z: 1, x: 0, y: 0 }; }} className="px-1.5 h-6 rounded bg-zinc-900/80 border border-white/10 text-zinc-400 text-[10px]">reset</button>
      </div>
      <div className="absolute bottom-2 left-2 text-[10px] text-zinc-500">scroll = zoom · drag = pan · zoom in for sessions and their last action</div>
    </div>
  );
}

function AgentCard({ a, st }: { a: Agent; st?: Status }) {
  const m = META[a.id];
  return (
    <div className="rounded-lg border p-2.5 text-[12px] space-y-1" style={{ borderColor: m.color + "40", background: m.color + "08" }}>
      <div className="flex items-center gap-2">
        <span className={cn("w-2 h-2 rounded-full", st?.working && "animate-pulse")} style={{ background: st?.working ? m.color : m.color + "55" }} />
        <span className="font-semibold" style={{ color: m.color }}>{m.label}</span>
        <span className="text-zinc-500">{st ? (st.working ? "working" : `idle ${ago(st.lastEvent?.t)}`) : m.role}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-2 text-zinc-300 tabular-nums">
        <span className="text-zinc-500">Commits 24h / 7d</span><span>{a.commits24h} / {a.commits7d}</span>
        <span className="text-zinc-500">Queue</span><span className={cn(a.queue > 20 && "text-red-300")}>{a.queue}</span>
        {st && <><span className="text-zinc-500">Actions 24h</span><span>{st.tools24h}</span><span className="text-zinc-500">Sessions now</span><span>{st.sessions10m}</span></>}
      </div>
    </div>
  );
}

function Activity({ d }: { d: Data }) {
  const [who, setWho] = useState<string>("all");
  const rows = useMemo(() => {
    const live = d.live.map((e) => ({ t: e.t, agent: e.agent, what: `${e.tool ?? e.event}${e.detail ? ` · ${e.detail}` : ""}`, kind: "action" }));
    const ev = d.events.map((e) => ({ t: e.t, agent: e.from, what: e.kind === "ask" ? `→ ${e.to}: ${e.text}` : `commit · ${e.text}`, kind: e.kind }));
    return [...live, ...ev].filter((r) => who === "all" || r.agent === who).sort((a, b) => b.t.localeCompare(a.t)).slice(0, 200);
  }, [d, who]);
  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        {d.agents.filter((a) => a.id !== "jamie").map((a) => <AgentCard key={a.id} a={a} st={a.id === "claude" || a.id === "cursor" ? d.status[a.id] : undefined} />)}
      </div>
      <div className="flex gap-1">
        {["all", "claude", "cursor", "muse"].map((x) => (
          <button key={x} type="button" onClick={() => setWho(x)}
            className={cn("px-2 py-0.5 rounded text-[11px] border", who === x ? "border-cyan-400/50 text-cyan-200" : "border-white/10 text-zinc-400")}>{x}</button>
        ))}
      </div>
      <div className="max-h-[420px] overflow-y-auto rounded-lg border border-white/5">
        {rows.map((r, i) => (
          <div key={i} className={cn("grid grid-cols-[52px_64px_1fr] gap-2 px-2 py-1 text-[12.5px] leading-snug", i % 2 && "bg-white/[0.02]")}>
            <span className="text-zinc-500 tabular-nums">{ago(r.t)}</span>
            <span style={{ color: META[r.agent as Id]?.color ?? "#94a3b8" }}>{META[r.agent as Id]?.label ?? r.agent}</span>
            <span className="text-zinc-200 truncate" title={r.what}>{r.what}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Usage({ d }: { d: Data }) {
  const { current, peak, hours } = d.windows;
  const pct = peak.out ? Math.round((current.out / peak.out) * 100) : 0;
  const claude = d.agents.find((a) => a.id === "claude")?.tokens ?? [];
  return (
    <div className="space-y-4 text-[12px]">
      <div className="flex items-baseline gap-4">
        <div><div className="text-zinc-500 text-[11px]">Claude · this 5-hour window</div>
          <div className="text-xl font-semibold text-cyan-200 tabular-nums">{fmt(current.out)} <span className="text-sm text-zinc-400">out · {current.req} calls</span></div></div>
        <div className="flex-1">
          <div className="h-2 rounded bg-zinc-800 overflow-hidden"><div className={cn("h-full", pct > 80 ? "bg-red-400" : pct > 50 ? "bg-amber-300" : "bg-cyan-400")} style={{ width: `${Math.min(100, pct)}%` }} /></div>
          <div className="text-zinc-500 text-[11px] mt-0.5">{pct}% of your busiest 5-hour window this week ({fmt(peak.out)} out)</div>
        </div>
        <InfoTip>Claude plans limit usage per 5-hour window, but the cap itself isn't exposed to apps, so this compares to your own busiest window
          in the last 7 days. Output tokens shown; input is mostly cached (cheap). Source: Claude Code session logs. Cursor and Muse don't record
          tokens locally: Cursor shows action counts from its hooks; Muse shows commits.</InfoTip>
      </div>
      <div>
        <div className="text-zinc-500 text-[11px] mb-1">Claude output tokens per hour, last 48 h</div>
        <ResponsiveContainer width="100%" height={120}>
          <BarChart data={hours}>
            <XAxis dataKey="t" tickFormatter={(t: string) => new Date(t).getHours().toString()} tick={{ fontSize: 10, fill: "#71717a" }} interval={5} axisLine={false} tickLine={false} />
            <YAxis tickFormatter={(v: number) => fmt(v)} tick={{ fontSize: 10, fill: "#71717a" }} width={34} axisLine={false} tickLine={false} />
            <RTooltip contentStyle={{ background: "#09090b", border: "1px solid #22d3ee55", fontSize: 11 }} labelFormatter={(t: string) => new Date(t).toLocaleString()} formatter={(v: number) => [fmt(v), "output"]} />
            <Bar dataKey="out" fill="#22d3ee" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <table className="w-full text-[12px] tabular-nums">
        <thead className="text-zinc-500 text-left"><tr><th className="font-normal">Day</th><th className="font-normal">Output</th><th className="font-normal">Input (incl. cache)</th><th className="font-normal">Calls</th></tr></thead>
        <tbody>{[...claude].reverse().map((t) => (
          <tr key={t.day} className="border-t border-white/5"><td className="py-0.5 text-zinc-400">{t.day.slice(5)}</td><td className="text-zinc-200">{fmt(t.output)}</td>
            <td className="text-zinc-400">{fmt(t.input + t.cacheRead + t.cacheWrite)}</td><td className="text-zinc-400">{t.requests}</td></tr>
        ))}</tbody>
      </table>
      <div className="text-zinc-500">Cursor: {d.status.cursor.tools24h} actions in 24 h (hooks) · Muse: {d.agents.find((a) => a.id === "muse")?.commits24h ?? 0} commits in 24 h · tokens not tracked</div>
    </div>
  );
}

function Rules({ d }: { d: Data }) {
  const groups = [...new Set(d.rules.map((r) => r.group))];
  return (
    <div className="grid gap-3 sm:grid-cols-2 text-[12.5px]">
      {groups.map((g) => (
        <div key={g} className="rounded-lg border border-white/5 p-2.5">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 mb-1">{g}</div>
          <ul className="space-y-0.5 text-zinc-200">{d.rules.filter((r) => r.group === g).map((r) => <li key={r.title}>· {r.title}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}

function Skills({ d }: { d: Data }) {
  return (
    <div className="space-y-2 text-[12.5px]">
      <div className="flex items-center gap-2 text-zinc-400">
        Skills = instructions an agent loads only when a task needs them (saves tokens vs. always-on rules).
        <InfoTip>Yes, worth keeping, but only the used ones. 0 loads in 7 days → candidate to merge into another skill or delete, so agents
          scan fewer options. Counts come from Claude Code session logs (Skill/Read of .claude/skills/*.md).</InfoTip>
      </div>
      <table className="w-full">
        <tbody>{d.skills.map((s) => (
          <tr key={s.name} className="border-t border-white/5 align-top">
            <td className="py-1 pr-3 text-zinc-100 whitespace-nowrap">{s.name}</td>
            <td className={cn("py-1 pr-3 tabular-nums whitespace-nowrap", s.uses7d ? "text-cyan-200" : "text-zinc-600")}>{s.uses7d ? `${s.uses7d}× / 7d` : "unused"}</td>
            <td className="py-1 text-zinc-400">{s.about}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const TABS = ["Map", "Activity", "Usage", "Rules", "Skills"] as const;

export function AgentsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["agents-overview"],
    queryFn: async (): Promise<Data> => {
      const r = await fetch("/api/agents/overview", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 15_000, // live events are cheap (file tail); commits/tokens are cached server-side
  });
  const [tab, setTab] = useState<(typeof TABS)[number]>("Map");
  if (isLoading || !data) return <p className="text-xs text-zinc-500">Loading…</p>;
  const working = (["claude", "cursor"] as const).filter((a) => data.status[a].working);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 text-[12px]">
        <span className="text-zinc-300">{working.length ? <>Working now: {working.map((a) => <span key={a} style={{ color: META[a].color }}> {META[a].label}</span>)}</> : "No agent working right now"}</span>
        <span className="text-zinc-500">· Claude {fmt(data.windows.current.out)} tokens this 5h window</span>
        <div className="ml-auto flex gap-1">
          {TABS.map((t) => (
            <button key={t} type="button" onClick={() => setTab(t)}
              className={cn("px-2.5 py-1 rounded-md text-[12px] border", tab === t ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-100" : "border-white/10 text-zinc-400 hover:text-zinc-200")}>{t}</button>
          ))}
        </div>
      </div>
      {tab === "Map" && <MapView d={data} />}
      {tab === "Activity" && <Activity d={data} />}
      {tab === "Usage" && <Usage d={data} />}
      {tab === "Rules" && <Rules d={data} />}
      {tab === "Skills" && <Skills d={data} />}
    </div>
  );
}
