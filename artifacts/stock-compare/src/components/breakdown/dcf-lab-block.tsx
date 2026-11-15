/**
 * A289 — DCF v2 (lab) block for Assumptions tab. Display only; not in fair-value blend.
 */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/format";

type Assum = { key: string; label: string; value: number | number[]; unit: string; source: string };
type Dcf = {
  asOf?: string; version?: string; valued: boolean; reason?: string; price?: number | null;
  p10?: number; p50?: number; p90?: number; price_pct?: number;
  reverse?: { growth_pct: number | null; implied_cagr5: number | null };
  scenarios?: Record<string, number>;
  assumptions?: Assum[];
  risk?: { expensive?: boolean; read?: string };
  drivers?: { key: string; label: string; low: number; high: number; mid: number }[];
};

const SCENARIO_LABEL: Record<string, string> = {
  base: "Base", normal: "Normal rates", implied: "Market-implied ERP", ltcma: "JPM LT 7.5%",
};

function fmtAssum(v: number | number[], unit: string): string {
  const one = (x: number) => {
    if (unit === "pct" || unit.startsWith("pct")) return `${(x * 100).toFixed(1)}%`;
    if (unit === "usd_total") return Math.abs(x) >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`;
    if (unit === "count") return `${(x / 1e6).toFixed(1)}M`;
    if (unit === "x" || unit.startsWith("x")) return `${x.toFixed(2)}×`;
    return formatCurrency(x);
  };
  if (Array.isArray(v)) {
    const parts = v.map(one);
    return parts.length === 2 ? `${parts[0]} → ${parts[1]}` : parts.join(" / ");
  }
  return one(v);
}

export function DcfLabBlock({ ticker }: { ticker: string }) {
  const { data } = useQuery({
    queryKey: ["fv-dcf-lab", ticker],
    queryFn: async (): Promise<Dcf | null> => {
      const r = await fetch(`/api/fair-value/${encodeURIComponent(ticker)}/dcf`, { credentials: "include" });
      if (!r.ok) return null;
      const j = await r.json();
      return (j.dcf as Dcf | null) ?? null;
    },
    staleTime: 10 * 60_000,
  });
  if (data == null) return null;
  if (!data.valued) {
    return (
      <div className="rounded border border-[#d4af37]/15 bg-zinc-950/60 px-2.5 py-2 text-[10px] text-amber-100">
        <span className="text-amber-100/70 font-semibold">DCF (lab)</span>
        <span className="ml-1.5 rounded border border-zinc-600/50 px-1 text-[9px] text-amber-100/80">lab — not in fair value</span>
        <div className="mt-1">{data.reason ?? "Not valued"}</div>
      </div>
    );
  }
  const { p10, p50, p90, price, price_pct, reverse, scenarios, assumptions = [], risk, asOf } = data;
  const lo = p10 ?? 0, hi = p90 ?? 1, mid = p50 ?? 0;
  const span = Math.max(hi - lo, 1e-9);
  const pctPos = (v: number) => Math.max(0, Math.min(100, ((v - lo) / span) * 100));
  const ops = assumptions.filter((a) => !a.key.startsWith("claim:") && !a.key.startsWith("asset:"));
  const bridge = assumptions.filter((a) => a.key.startsWith("claim:") || a.key.startsWith("asset:"));

  return (
    <div className="rounded border border-[#d4af37]/20 bg-zinc-950/70 px-2.5 py-2 space-y-2 text-[10.5px]" title={asOf ? `as of ${asOf}` : undefined}>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-amber-100 font-semibold">DCF (lab)</span>
        <span className="rounded border border-zinc-600/50 px-1 text-[9px] text-amber-100/80">lab — not in fair value</span>
        {p50 != null && <span className="font-mono text-amber-100/90">P50 {formatCurrency(p50)}</span>}
        {price != null && <span className="text-amber-100/80">price {formatCurrency(price)}</span>}
      </div>

      {p10 != null && p90 != null && (
        <div className="space-y-1">
          <div className="relative h-2 rounded bg-zinc-800 border border-zinc-700/50">
            <div className="absolute inset-y-0 left-0 rounded bg-[#d4af37]/25" style={{ width: "100%" }} />
            <div className="absolute top-0 bottom-0 w-0.5 bg-[#d4af37]" style={{ left: `${pctPos(mid)}%` }} title={`P50 ${formatCurrency(mid)}`} />
            {price != null && (
              <div className="absolute -top-0.5 -bottom-0.5 w-0.5 bg-sky-400" style={{ left: `${pctPos(price)}%` }} title={`Price ${formatCurrency(price)}`} />
            )}
          </div>
          <div className="flex justify-between text-[9px] text-amber-100/80 font-mono">
            <span>P10 {formatCurrency(p10)}</span>
            <span>P90 {formatCurrency(p90)}</span>
          </div>
          {price_pct != null && (
            <div className="text-amber-100">Price sits at P{Math.round(price_pct * 100)} of outcomes</div>
          )}
          {risk?.expensive && (
            <div className="text-amber-300" title={risk.read ?? undefined}>
              Dearest 20 % by DCF — higher drawdown odds
            </div>
          )}
        </div>
      )}

      {reverse && (
        <div className="text-amber-100">
          {reverse.growth_pct == null
            ? "Price above our P98 growth outcome"
            : `Price needs revenue ${(reverse.implied_cagr5 ?? 0) >= 0 ? "+" : ""}${((reverse.implied_cagr5 ?? 0) * 100).toFixed(0)}%/yr for 5 years (P${Math.round((reverse.growth_pct ?? 0) * 100)} of similar firms)`}
        </div>
      )}

      {scenarios && (
        <div className="flex flex-wrap gap-1">
          {(["base", "normal", "implied", "ltcma"] as const).map((k) => (
            scenarios[k] != null ? (
              <span key={k} className="rounded border border-zinc-700/60 px-1.5 py-0.5 text-[9.5px] text-zinc-300">
                {SCENARIO_LABEL[k] ?? k} <span className="font-mono text-amber-100/80">{formatCurrency(scenarios[k]!)}</span>
              </span>
            ) : null
          ))}
        </div>
      )}

      {data.drivers && data.drivers.length > 0 && (
        <div className="space-y-0.5" title="One assumption at a time at its low / high setting, everything else unchanged (same random draws). Largest swing first.">
          <div className="text-[9px] uppercase tracking-wide text-amber-100/80">What moves the value</div>
          {data.drivers.map((d) => (
            <div key={d.key} className="flex justify-between gap-2" title={d.label}>
              <span className="text-amber-100 truncate">{d.label}</span>
              <span className="font-mono text-white shrink-0">{formatCurrency(d.low)} – {formatCurrency(d.high)}</span>
            </div>
          ))}
        </div>
      )}

      <AssumTable rows={ops} />
      {bridge.length > 0 && (
        <div className="space-y-1 pt-1">
          <div className="text-[9px] uppercase tracking-wide text-amber-100/80">From enterprise value to equity</div>
          <AssumTable rows={bridge} />
        </div>
      )}
    </div>
  );
}

function AssumTable({ rows }: { rows: Assum[] }) {
  if (!rows.length) return null;
  return (
    <div className="space-y-0.5">
      {rows.map((a) => (
        <div key={a.key} className="flex justify-between gap-2" title={a.source}>
          <span className={cn("text-amber-100 truncate", a.key.startsWith("claim:") && "text-rose-300/70", a.key.startsWith("asset:") && "text-emerald-300/70")}>
            {a.label}
          </span>
          <span className="font-mono text-zinc-200 shrink-0">{fmtAssum(a.value, a.unit)}</span>
        </div>
      ))}
    </div>
  );
}
