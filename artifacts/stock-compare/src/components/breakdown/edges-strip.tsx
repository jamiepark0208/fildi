// Breakdown › "Rules firing today" (Jamie 11-08: ship proven edges into the app; spec research/common/edge-surfaces.md).
// One chip per rule that fires on this name today, read from /api/stocks/:t/edges (Model List lanes, put band engine,
// Rankings ladder, Strategy Library signals, long-options board). Method, study and record live in the tooltip.
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface EdgeRecord { kind: "backtest" | "live"; n: number | null; hitPct: number | null; bpWk?: number | null; open?: number | null; note?: string }
interface EdgeRow {
  rule: string; study: string | null; side: string; status: "pick" | "shadow" | "signal" | "paper" | "gated";
  rank: number | null; of: number | null; strike: number | null; expiry: string | null; premium: number | null;
  why: string | null; blocked: string | null; asOf: string | null; record: EdgeRecord | null;
}

const STATUS_CLASS: Record<EdgeRow["status"], string> = {
  pick: "border-emerald-500/60 bg-emerald-500/15 text-emerald-300",
  signal: "border-amber-500/60 bg-amber-500/15 text-amber-300",
  shadow: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  paper: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  gated: "border-zinc-600 bg-zinc-800/60 text-zinc-400",
};
const STATUS_LABEL: Record<EdgeRow["status"], string> = {
  pick: "pick", signal: "signal", shadow: "shadow", paper: "paper", gated: "gated",
};

const md = (d: string | null) => (d ? d.slice(5).replace("-", "/") : "");
const px = (v: number | null) => (v == null ? "" : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

function recordText(r: EdgeRecord | null): string {
  if (!r) return "no record attached";
  const parts = [r.kind === "live" ? "Live" : "Backtest"];
  if (r.n != null) parts.push(`n ${r.n}`);
  if (r.hitPct != null) parts.push(`${r.hitPct} % ${r.kind === "live" ? "won" : "kept"}`);
  if (r.bpWk != null) parts.push(`${r.bpWk > 0 ? "+" : ""}${r.bpWk} bp/wk`);
  if (r.open != null) parts.push(`${r.open} open`);
  return parts.join(" · ") + (r.note ? ` (${r.note})` : "");
}

function tip(e: EdgeRow): string {
  return [
    `${e.rule}${e.study ? ` — ${e.study}` : ""} · ${e.side} · ${STATUS_LABEL[e.status]}${e.rank != null ? ` #${e.rank}${e.of ? ` of ${e.of}` : ""}` : ""}`,
    e.why,
    e.blocked ? `Blocked: ${e.blocked}` : null,
    recordText(e.record),
    e.asOf ? `As of ${e.asOf}` : null,
  ].filter(Boolean).join("\n");
}

export function EdgesStrip({ ticker }: { ticker: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["stock-edges", ticker],
    queryFn: async () => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/edges`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { ticker: string; edges: EdgeRow[] };
    },
    staleTime: 5 * 60_000,
  });
  if (isLoading || isError) return null;
  const edges = data?.edges ?? [];
  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px]" data-testid="edges-strip">
      <span className="text-muted-foreground shrink-0" title="Proven rules (BOARD 'works' rows) that fire on this name today. Same rows as Model List / Rankings / Strategy Library; hover a chip for method, study and record.">
        Rules today
      </span>
      {edges.length === 0 && <span className="text-muted-foreground/70">no proven rule fires on {ticker} today</span>}
      {edges.map((e, i) => (
        <span
          key={`${e.rule}-${i}`}
          title={tip(e)}
          className={cn("inline-flex items-center gap-1 rounded border px-1.5 py-0.5 whitespace-nowrap cursor-help", STATUS_CLASS[e.status], e.blocked && e.status !== "gated" && "opacity-70")}
        >
          <span className="font-medium">{e.rule}</span>
          {e.rank != null && <span className="opacity-80">#{e.rank}</span>}
          {e.strike != null && <span>{e.side.endsWith("put") ? "P" : "C"} {px(e.strike)}{e.expiry ? ` ${md(e.expiry)}` : ""}</span>}
          {e.premium != null && <span className="opacity-80">@{px(e.premium)}</span>}
          {e.status === "gated" || e.blocked ? <span className="opacity-80">· {e.status === "gated" ? "gated" : "blocked"}</span> : null}
          {e.status !== "gated" && !e.blocked && e.status !== "pick" && <span className="opacity-70">· {STATUS_LABEL[e.status]}</span>}
        </span>
      ))}
    </div>
  );
}
