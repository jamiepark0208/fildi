/**
 * Settings › Research — studies INDEX + A102 weekly score-outlier review.
 * Data: GET /api/research/studies, GET /api/research/score-outliers.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { SUI } from "@/components/settings/settings-ui";

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
      <div className={SUI.headRow}>
        <h2 className={SUI.title}>Is it working?</h2>
        <p className={SUI.sub}>live since adoption</p>
      </div>
      <div className={SUI.tableWrap}>
        <table className={SUI.table}>
          <thead className={SUI.thead}>
            <tr className="border-b border-[#d4af37]/25">
              <th className={cn(SUI.th, "w-24")}>Verdict</th>
              <th className={SUI.th}>Item</th>
              <th className={SUI.th}>Live</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {data.scoreboard.map((s) => (
              <tr key={s.item} className={cn(SUI.tr, "align-top")}>
                <td className={SUI.td}><span className={cn("inline-block rounded border px-1 py-px text-[10px]", VERDICT[s.verdict] ?? VERDICT["too early"])}>{s.verdict}</span></td>
                <td className={SUI.td}>
                  <Tooltip delayDuration={200}>
                    <TooltipTrigger asChild><span className="cursor-default text-white">{s.item}</span></TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[380px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
                      Promised ({s.source}): {s.promised}<br />Sample: {s.n} · checked {s.checkedAt?.slice(0, 16)}<br />
                      Too early = under 8 expiry weeks (put outcomes move together within a week, so weeks are the sample).
                    </TooltipContent>
                  </Tooltip>
                </td>
                <td className={SUI.td}>{s.live}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={() => setOpen(!open)} className="text-[10px] text-white hover:text-white">
        {open ? "▾" : "▸"} Agent corrections: {c.length} ({c.filter((x) => x.caughtBy.startsWith("user")).length} caught by you)
      </button>
      {open && (
        <div className={SUI.tableWrap}>
          <table className={SUI.table}>
            <tbody className="divide-y divide-zinc-800">
              {[...c].reverse().map((x, i) => (
                <tr key={i} className={cn(SUI.tr, "align-top")}>
                  <td className={cn(SUI.td, "w-12 tabular-nums")}>{x.date}</td>
                  <td className={cn(SUI.td, "w-14")}>{x.agent}</td>
                  <td className={SUI.td}>{md(x.claim)}</td>
                  <td className={SUI.td}>{md(x.correction)}</td>
                  <td className={cn(SUI.td, "w-24")}>{x.caughtBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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

type Outlier = {
  kind: string;
  ticker: string;
  score: number | null;
  detail: string;
  dominantInput: string | null;
  why: string;
  thinData: boolean;
  disposition: "bug" | "explained" | "false_positive" | null;
  dispositionNote: string | null;
};

function ScoreOutliersPanel() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["score-outliers"],
    queryFn: async (): Promise<{ asOf: string; rows: Outlier[]; counts: Record<string, number> }> => {
      const r = await fetch("/api/research/score-outliers", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  const mut = useMutation({
    mutationFn: async (body: { ticker: string; kind: string; disposition: string }) => {
      const r = await fetch("/api/research/score-outliers/disposition", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["score-outliers"] }),
  });
  const [filter, setFilter] = useState<string>("all");
  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return filter === "all" ? all : all.filter((r) => r.kind === filter);
  }, [data, filter]);
  const kinds = Object.keys(data?.counts ?? {}).sort();
  return (
    <div className="space-y-2">
      <div className={SUI.headRow}>
        <div>
          <h2 className={SUI.title}>Score outliers</h2>
          <p className={SUI.sub}>A102 weekly QA — extremes + FV ratio + PT &gt;300% · disposition = bug / explained / false+</p>
        </div>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className={cn(SUI.input, "w-40")}
        >
          <option value="all">all ({data?.rows.length ?? 0})</option>
          {kinds.map((k) => (
            <option key={k} value={k}>{k} ({data?.counts[k]})</option>
          ))}
        </select>
      </div>
      {isLoading && <p className="text-xs text-white/60">Loading outliers…</p>}
      {error && <p className="text-xs text-red-300">{(error as Error).message}</p>}
      {data && (
        <div className={SUI.tableWrap}>
          <table className={SUI.table}>
            <thead className={SUI.thead}>
              <tr className="border-b border-[#d4af37]/25">
                <th className={cn(SUI.th, "w-14")}>Ticker</th>
                <th className={cn(SUI.th, "w-24")}>Kind</th>
                <th className={SUI.th}>Detail</th>
                <th className={SUI.th}>Dominant</th>
                <th className={cn(SUI.th, "w-36")}>Disposition</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.map((r) => (
                <tr key={`${r.kind}:${r.ticker}`} className={cn(SUI.tr, "align-top")}>
                  <td className={cn(SUI.td, "font-mono font-semibold")}>
                    {r.ticker}
                    {r.thinData && (
                      <span className="ml-1 text-[9px] text-orange-300" title="coverage &lt; 0.6">thin</span>
                    )}
                  </td>
                  <td className={cn(SUI.td, "text-[10px] text-amber-100/70")}>{r.kind}</td>
                  <td className={SUI.td} title={r.why}>{r.detail}</td>
                  <td className={cn(SUI.td, "text-[10px] text-white/50")}>{r.dominantInput ?? "—"}</td>
                  <td className={SUI.td}>
                    <select
                      className={cn(SUI.input, "w-full text-[10px]")}
                      value={r.disposition ?? ""}
                      disabled={mut.isPending}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (!v) return;
                        mut.mutate({ ticker: r.ticker, kind: r.kind, disposition: v });
                      }}
                    >
                      <option value="">—</option>
                      <option value="bug">bug → ASKS</option>
                      <option value="explained">explained</option>
                      <option value="false_positive">false positive</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
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
  if (isLoading) return <p className="text-xs text-white">Loading…</p>;
  return (
    <div className={SUI.panel}>
      <Scoreboard />
      <ScoreOutliersPanel />
      <div className={SUI.headRow}>
        <div>
          <h2 className={SUI.title}>Studies</h2>
          <p className={SUI.sub}>research/studies — answers already on the books</p>
        </div>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search studies…"
          className={cn(SUI.input, "w-56")} />
      </div>
      <div className={SUI.tableWrap}>
        <table className={SUI.table}>
          <thead className={SUI.thead}>
            <tr className="border-b border-[#d4af37]/25">
              <th className={cn(SUI.th, "w-12")}>ID</th>
              <th className={SUI.th}>Question</th>
              <th className={SUI.th}>Answer</th>
              <th className={cn(SUI.th, "w-28")}>Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {rows.map((s) => (
              <tr key={s.id} className={cn(SUI.tr, "align-top")}>
                <td className={cn(SUI.td, "tabular-nums")}>{s.id}</td>
                <td className={SUI.td}>{md(s.question)}</td>
                <td className={SUI.td}>
                  <Tooltip delayDuration={200}>
                    <TooltipTrigger asChild>
                      <span className="line-clamp-2 text-white cursor-default">{md(s.answer)}</span>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[420px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug">
                      <div>{md(s.answer)}</div>
                      <div className="mt-1 text-white">{s.date} · {md(s.report)}</div>
                    </TooltipContent>
                  </Tooltip>
                </td>
                <td className={SUI.td}>
                  <span className={cn("inline-block rounded border px-1 py-px text-[10px]", tone(s.status))}>{md(s.status)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
