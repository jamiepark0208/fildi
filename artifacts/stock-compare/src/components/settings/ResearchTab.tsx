/**
 * Settings › Research — every study run on Fildi data (research/studies/INDEX.md) with its one-line answer and status, so a
 * question already answered isn't asked again. Full answer + report path in the hover tooltip. Data: GET /api/research/studies.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Score = { item: string; source: string; promised: string; live: string; n: string; verdict: string; checkedAt: string };
type Correction = { date: string; agent: string; claim: string; correction: string; caughtBy: string };
const VERDICT: Record<string, string> = {
  holding: "border-emerald-500/40 text-emerald-300", drifting: "border-amber-400/40 text-amber-200",
  failed: "border-red-500/50 text-red-300", "too early": "border-zinc-600 text-zinc-400", "no live check": "border-red-500/30 text-red-300/80",
};

/** Promised (backtest) vs live since adoption, per adopted score. Method + counts in the hover. */
function Scoreboard() {
  const { data } = useQuery({
    queryKey: ["research-scoreboard"],
    queryFn: async (): Promise<{ scoreboard: Score[]; corrections: Correction[] }> => {
      const r = await fetch("/api/research/scoreboard", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 10 * 60_000,
  });
  const [open, setOpen] = useState(false);
  if (!data) return null;
  const c = data.corrections;
  return (
    <div className="space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-amber-200/60">Is it working? (live since adoption)</div>
      <table className="w-full text-[11px]">
        <tbody>
          {data.scoreboard.map((s) => (
            <tr key={s.item} className="border-t border-white/5 align-top">
              <td className="py-1 pr-2 w-24"><span className={cn("inline-block rounded border px-1 py-px text-[10px]", VERDICT[s.verdict] ?? VERDICT["too early"])}>{s.verdict}</span></td>
              <td className="py-1 pr-2 text-amber-100">
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild><span className="cursor-default">{s.item}</span></TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[380px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
                    Promised ({s.source}): {s.promised}<br />Sample: {s.n} · checked {s.checkedAt?.slice(0, 16)}<br />
                    Too early = under 8 expiry weeks (put outcomes move together within a week, so weeks are the sample).
                  </TooltipContent>
                </Tooltip>
              </td>
              <td className="py-1 text-amber-200/70">{s.live}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <button type="button" onClick={() => setOpen(!open)} className="text-[10px] text-amber-200/60 hover:text-amber-200">
        {open ? "▾" : "▸"} Agent corrections: {c.length} ({c.filter((x) => x.caughtBy.startsWith("user")).length} caught by you)
      </button>
      {open && (
        <table className="w-full text-[11px]">
          <tbody>
            {[...c].reverse().map((x, i) => (
              <tr key={i} className="border-t border-white/5 align-top">
                <td className="py-1 pr-2 w-12 text-amber-200/50 tabular-nums">{x.date}</td>
                <td className="py-1 pr-2 w-14 text-amber-200/60">{x.agent}</td>
                <td className="py-1 pr-2 text-amber-100">{md(x.claim)}</td>
                <td className="py-1 pr-2 text-amber-200/70">{md(x.correction)}</td>
                <td className="py-1 w-24 text-amber-200/50">{x.caughtBy}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type Study = { id: string; date: string; question: string; answer: string; status: string; report: string };

const md = (s: string) => s.replace(/\*\*/g, "").replace(/`/g, "");
function tone(status: string): string {
  const s = status.toLowerCase();
  if (s.startsWith("adopted")) return "border-emerald-500/40 text-emerald-300";
  if (s.startsWith("display")) return "border-sky-500/40 text-sky-300";
  if (s.startsWith("rejected") || s.startsWith("superseded")) return "border-zinc-600 text-zinc-400";
  return "border-amber-400/40 text-amber-200";
}

export function ResearchTab() {
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["research-studies"],
    queryFn: async (): Promise<Study[]> => {
      const r = await fetch("/api/research/studies", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()).studies;
    },
    staleTime: 10 * 60_000,
  });
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const all = [...(data ?? [])].reverse();
    return needle ? all.filter((s) => `${s.id} ${s.question} ${s.answer} ${s.status}`.toLowerCase().includes(needle)) : all;
  }, [data, q]);
  if (isLoading) return <p className="text-xs text-amber-200/40">Loading…</p>;
  return (
    <div className="space-y-4">
      <Scoreboard />
      <div className="space-y-2">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search studies (e.g. earnings, IV, fair value)"
        className="w-full max-w-sm rounded border border-[#d4af37]/20 bg-zinc-950 px-2 py-1 text-xs text-amber-100 placeholder:text-amber-200/30" />
      <table className="w-full text-[11px]">
        <thead className="text-amber-200/50 text-left">
          <tr><th className="py-1 pr-2 w-12">ID</th><th className="pr-2">Question</th><th className="pr-2">Answer</th><th className="w-28">Status</th></tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr key={s.id} className="border-t border-white/5 align-top">
              <td className="py-1 pr-2 text-amber-200/60 tabular-nums">{s.id}</td>
              <td className="py-1 pr-2 text-amber-100">{md(s.question)}</td>
              <td className="py-1 pr-2">
                <Tooltip delayDuration={200}>
                  <TooltipTrigger asChild>
                    <span className="line-clamp-2 text-amber-200/70 cursor-default">{md(s.answer)}</span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" className="max-w-[420px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
                    <div>{md(s.answer)}</div>
                    <div className="mt-1 text-amber-200/50">{s.date} · {md(s.report)}</div>
                  </TooltipContent>
                </Tooltip>
              </td>
              <td className="py-1"><span className={cn("inline-block rounded border px-1 py-px text-[10px]", tone(s.status))}>{md(s.status)}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </div>
  );
}
