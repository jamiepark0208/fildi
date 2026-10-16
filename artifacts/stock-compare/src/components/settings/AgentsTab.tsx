/**
 * Settings › Agents (Claude, user 2026-10-15): live map of the agent team from real records — commits (git), hand-offs (ASKS rows),
 * Claude token use (session logs). Orbs pulse with recent activity; beams replay the last 24 h of hand-offs and commits.
 * Click an orb for its numbers. Nothing here is simulated. Data: GET /api/agents/overview (10-min cache).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Id = "muse" | "claude" | "cursor" | "jamie";
type Tok = { day: string; input: number; cacheRead: number; cacheWrite: number; output: number; requests: number };
type Agent = { id: Id; commits24h: number; commits7d: number; lastActive: string | null; queue: number; sent7d: number; received7d: number; tokens: Tok[] | null };
type Ev = { t: string; from: Id; to: Id | "repo"; kind: "commit" | "ask"; text: string; ref?: string };

const META: Record<Id, { label: string; role: string; color: string; x: number; y: number }> = {
  jamie: { label: "Jamie", role: "decides · approves", color: "#d4af37", x: 0.5, y: 0.52 },
  muse: { label: "Muse", role: "ideas · cloud, always on", color: "#a855f7", x: 0.2, y: 0.22 },
  claude: { label: "Claude", role: "PM · reviews · research", color: "#22d3ee", x: 0.8, y: 0.22 },
  cursor: { label: "Cursor", role: "builds", color: "#34d399", x: 0.5, y: 0.9 },
};
const REPO = { x: 0.5, y: 0.52 }; // commits land on the shared repo, drawn at the hub
const fmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const ago = (t: string | null) => {
  if (!t) return "—";
  const h = (Date.now() - Date.parse(t)) / 36e5;
  return h < 1 ? `${Math.round(h * 60)} m ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} d ago`;
};

function Orbs({ agents, events, sel, onSel }: { agents: Agent[]; events: Ev[]; sel: Id | null; onSel: (id: Id) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const recent = useMemo(() => events.filter((e) => Date.now() - Date.parse(e.t) < 864e5).reverse(), [events]);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d")!;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const act = Object.fromEntries(agents.map((a) => [a.id, a.commits24h + a.sent7d / 7])) as Record<Id, number>;
    const ripple: Partial<Record<Id, number>> = {};
    let beams: { a: { x: number; y: number }; b: { x: number; y: number }; c: string; t0: number; to?: Id }[] = [];
    let i = 0, last = 0, raf = 0;
    const draw = (now: number) => {
      const w = cv.clientWidth, h = cv.clientHeight, dpr = window.devicePixelRatio || 1;
      if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // grid
      ctx.strokeStyle = "rgba(212,175,55,0.05)";
      for (let x = 0; x < w; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
      for (let y = 0; y < h; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
      const P = (p: { x: number; y: number }) => ({ x: p.x * w, y: p.y * h });
      // static links
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      for (const id of ["muse", "claude", "cursor"] as Id[]) { const a = P(META[id]), b = P(META.jamie); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
      // replay one event every 900 ms
      if (!reduce && recent.length && now - last > 900) {
        const e = recent[i++ % recent.length];
        last = now;
        const to = e.to === "repo" ? undefined : e.to;
        beams.push({ a: META[e.from], b: to ? META[to] : REPO, c: META[e.from].color, t0: now, to: to ?? "jamie" });
      }
      beams = beams.filter((bm) => now - bm.t0 < 1400);
      for (const bm of beams) {
        const k = Math.min(1, (now - bm.t0) / 1000), a = P(bm.a), b = P(bm.b);
        const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k;
        const g = ctx.createLinearGradient(a.x, a.y, x, y);
        g.addColorStop(0, "transparent"); g.addColorStop(1, bm.c);
        ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(x, y); ctx.stroke();
        ctx.fillStyle = bm.c; ctx.shadowColor = bm.c; ctx.shadowBlur = 12; ctx.beginPath(); ctx.arc(x, y, 3, 0, 7); ctx.fill(); ctx.shadowBlur = 0;
        if (k >= 1 && bm.to) ripple[bm.to] = now;
      }
      // orbs
      for (const id of Object.keys(META) as Id[]) {
        const m = META[id], p = P(m);
        const base = id === "jamie" ? 26 : 20 + Math.min(14, Math.sqrt(act[id] ?? 0) * 3);
        const pulse = reduce ? 0 : Math.sin(now / 600 + p.x) * 2;
        const r = base + pulse;
        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.4);
        grad.addColorStop(0, m.color + "cc"); grad.addColorStop(0.35, m.color + "44"); grad.addColorStop(1, "transparent");
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(p.x, p.y, r * 2.4, 0, 7); ctx.fill();
        ctx.fillStyle = "#0a0a0a"; ctx.strokeStyle = m.color; ctx.lineWidth = sel === id ? 3 : 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, 7); ctx.fill(); ctx.stroke();
        const rp = ripple[id];
        if (rp && now - rp < 700) { const q = (now - rp) / 700; ctx.strokeStyle = m.color + Math.round((1 - q) * 200).toString(16).padStart(2, "0"); ctx.beginPath(); ctx.arc(p.x, p.y, r + q * 22, 0, 7); ctx.stroke(); }
        // orbit ring with queue dots
        const q = Math.min(24, agents.find((a) => a.id === id)?.queue ?? 0);
        for (let j = 0; j < q; j++) {
          const ang = (j / Math.max(q, 1)) * Math.PI * 2 + (reduce ? 0 : now / 4000);
          ctx.fillStyle = m.color + "99"; ctx.beginPath(); ctx.arc(p.x + Math.cos(ang) * (r + 9), p.y + Math.sin(ang) * (r + 9), 1.6, 0, 7); ctx.fill();
        }
        ctx.fillStyle = "#f5f5f4"; ctx.font = "600 11px ui-sans-serif"; ctx.textAlign = "center"; ctx.fillText(m.label, p.x, p.y + 4);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [agents, recent, sel]);
  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    let best: Id | null = null, d = 0.08;
    for (const id of Object.keys(META) as Id[]) { const dd = Math.hypot(META[id].x - x, (META[id].y - y) * (r.height / r.width)); if (dd < d) { d = dd; best = id; } }
    if (best) onSel(best);
  };
  return <canvas ref={ref} onClick={click} className="w-full h-[320px] cursor-pointer rounded border border-[#d4af37]/15 bg-zinc-950" />;
}

function Panel({ a, events }: { a: Agent; events: Ev[] }) {
  const m = META[a.id];
  const tok = a.tokens ?? [];
  const today = tok[tok.length - 1];
  const week = tok.reduce((s, t) => ({ out: s.out + t.output, req: s.req + t.requests, read: s.read + t.cacheRead + t.input + t.cacheWrite }), { out: 0, req: 0, read: 0 });
  const mine = events.filter((e) => e.from === a.id || e.to === a.id).slice(0, 8);
  return (
    <div className="rounded border p-2 space-y-1.5 text-[11px]" style={{ borderColor: m.color + "55" }}>
      <div className="flex items-baseline gap-2"><span className="font-semibold" style={{ color: m.color }}>{m.label}</span><span className="text-amber-200/50">{m.role}</span></div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular-nums text-amber-100">
        <span className="text-amber-200/50">Last active</span><span>{ago(a.lastActive)}</span>
        <span className="text-amber-200/50">Commits 24 h / 7 d</span><span>{a.commits24h} / {a.commits7d}</span>
        <span className="text-amber-200/50">Queue (rows to do)</span><span className={cn(a.queue > 20 && "text-red-300")}>{a.queue}</span>
        <span className="text-amber-200/50">Hand-offs sent / got (7 d)</span><span>{a.sent7d} / {a.received7d}</span>
        <span className="text-amber-200/50">Tokens</span>
        <span>{a.tokens ? <>{fmt(week.out)} out · {fmt(week.read)} in · {week.req} calls (7 d){today ? <><br />today {fmt(today.output)} out</> : null}</> : "not tracked"}</span>
      </div>
      {mine.length > 0 && (
        <div className="pt-1 border-t border-white/5 space-y-0.5">
          {mine.map((e, i) => <div key={i} className="truncate text-amber-200/70"><span className="text-amber-200/40">{e.t.slice(5, 10)}</span> {e.kind === "ask" ? `${e.from}→${e.to}` : "commit"} · {e.text}</div>)}
        </div>
      )}
    </div>
  );
}

export function AgentsTab() {
  const { data, isLoading } = useQuery({
    queryKey: ["agents-overview"],
    queryFn: async (): Promise<{ agents: Agent[]; events: Ev[]; asOf: string }> => {
      const r = await fetch("/api/agents/overview", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 10 * 60_000,
  });
  const [sel, setSel] = useState<Id | null>("cursor");
  if (isLoading || !data) return <p className="text-xs text-amber-200/40">Loading…</p>;
  const a = data.agents.find((x) => x.id === sel);
  const claude = data.agents.find((x) => x.id === "claude")?.tokens ?? [];
  const t = claude[claude.length - 1];
  return (
    <div className="space-y-3">
      <div className="flex items-baseline gap-3 text-[11px] text-amber-200/70">
        {data.agents.filter((x) => x.id !== "jamie").map((x) => (
          <span key={x.id}><span style={{ color: META[x.id].color }}>{META[x.id].label}</span> {x.commits24h} commits 24 h · queue {x.queue}</span>
        ))}
        {t && <span>· Claude today {fmt(t.output)} tokens out</span>}
        <span className="ml-auto">
          <Tooltip delayDuration={150}>
            <TooltipTrigger asChild><button type="button" className="text-amber-200/40 hover:text-amber-200/80"><Info className="w-3 h-3" /></button></TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[340px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
              Real records only. Beams replay the last 24 h: hand-offs (ASKS rows, agent → agent) and commits (agent → repo, drawn at the hub).
              Orb size = recent activity; dots on the ring = queued rows. Commit attribution: `Agent:` trailer, else Claude co-author, else
              cloud (GitHub) author = Muse, else Cursor. Tokens: Claude Code session logs; Cursor/Muse don't record usage locally. Refreshes every 10 min.
            </TooltipContent>
          </Tooltip>
        </span>
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_300px]">
        <Orbs agents={data.agents} events={data.events} sel={sel} onSel={setSel} />
        {a && <Panel a={a} events={data.events} />}
      </div>
      <div className="max-h-56 overflow-y-auto rounded border border-white/5 bg-zinc-950 p-2 font-mono text-[10px] leading-relaxed">
        {data.events.slice(0, 80).map((e, i) => (
          <div key={i} className="truncate">
            <span className="text-amber-200/40">{e.t.slice(5, 16).replace("T", " ")}</span>{" "}
            <span style={{ color: META[e.from].color }}>[{META[e.from].label.toUpperCase()}]</span>{" "}
            <span className="text-amber-200/50">{e.kind === "ask" ? `→ ${e.to}` : "commit"}</span>{" "}
            <span className="text-amber-100/80">{e.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
