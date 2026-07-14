import { Activity, DollarSign, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ChartPoint, LiquidityImplications } from "./macro-page-types";
import { changeColor, LIQUIDITY_LEVEL_STYLE, LIQUIDITY_LEVEL_LABEL } from "./macro-format";

// ── Liquidity implications read card ────────────────────────────────────────────

export function LiquidityImplicationsCard({
  data, loading,
}: {
  data: LiquidityImplications | undefined;
  loading?: boolean;
}) {
  if (loading || !data) {
    return (
      <div className="border border-border rounded-lg p-4 flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const overallStyle = LIQUIDITY_LEVEL_STYLE[data.overall.level];

  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Liquidity Regime Read</h2>
        </div>
        <Badge variant="outline" className={cn("text-xs", overallStyle.badge)}>
          {LIQUIDITY_LEVEL_LABEL[data.overall.level]}
        </Badge>
      </div>
      <p className={cn("text-sm font-medium mb-3", overallStyle.text)}>{data.overall.summary}</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {data.signals.map(sg => {
          const style = LIQUIDITY_LEVEL_STYLE[sg.level];
          return (
            <div key={sg.label} className="rounded-md bg-muted/30 p-2.5">
              <div className="flex items-center justify-between gap-2 mb-1">
                <span className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
                  <span className={cn("w-1.5 h-1.5 rounded-full inline-block", style.dot)} />
                  {sg.label}
                </span>
                <span className={cn("text-xs font-mono font-semibold", style.text)}>{sg.readout}</span>
              </div>
              <p className="text-xs text-slate-400 leading-snug">{sg.implication}</p>
            </div>
          );
        })}
      </div>
      <p className="text-xs text-slate-500 mt-3">
        Directional heuristic, not a precise model or trading signal.
      </p>
    </div>
  );
}

// ── Liquidity Plumbing Flow Diagram ─────────────────────────────────────────────
// Honest flow visual: WALCL/TGA/RRP -> Net Liquidity is real arithmetic
// (WALCL - TGA - RRP), so a connected strip is accurate here — unlike sector
// attribution, where no public data traces actual dollars.

function deltaFor(history: ChartPoint[], weeksBack: number): number | null {
  if (history.length === 0) return null;
  const latest = history[history.length - 1];
  const targetIdx = history.length - 1 - weeksBack;
  if (targetIdx < 0) return null;
  return latest.value - history[targetIdx].value;
}

function PlumbingNode({ label, valueB, deltaW, deltaM, sign }: {
  label: string; valueB: number | null; deltaW: number | null; deltaM: number | null; sign?: "-" | "=" ;
}) {
  return (
    <div className="flex items-center gap-2">
      {sign && <span className="text-lg text-muted-foreground font-semibold">{sign}</span>}
      <div className="border border-border rounded-md p-3 min-w-[130px]">
        <p className="text-xs text-slate-300 uppercase tracking-wide mb-1">{label}</p>
        <p className="text-lg font-semibold leading-tight">
          {valueB != null ? `$${valueB.toFixed(0)}B` : "—"}
        </p>
        <p className="text-xs mt-0.5 space-x-2">
          <span className={changeColor(deltaW)}>1w {deltaW != null ? `${deltaW > 0 ? "+" : ""}${deltaW.toFixed(0)}B` : "—"}</span>
          <span className={changeColor(deltaM)}>1m {deltaM != null ? `${deltaM > 0 ? "+" : ""}${deltaM.toFixed(0)}B` : "—"}</span>
        </p>
      </div>
    </div>
  );
}

export function LiquidityFlowDiagram({
  fedAssetsHistory, tgaHistory, rrpHistory, netLiquidityHistory, loading,
}: {
  fedAssetsHistory: ChartPoint[];
  tgaHistory: ChartPoint[];
  rrpHistory: ChartPoint[];
  netLiquidityHistory: ChartPoint[];
  loading?: boolean;
}) {
  const latestB = (history: ChartPoint[], divisor: number) =>
    history.length > 0 ? history[history.length - 1].value / divisor : null;

  if (loading) {
    return (
      <div className="border border-border rounded-lg p-4 flex items-center justify-center h-32">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <DollarSign className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Fed Plumbing — Net Liquidity</h2>
      </div>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <PlumbingNode
          label="Fed Assets (WALCL)"
          valueB={latestB(fedAssetsHistory, 1000)}
          deltaW={deltaFor(fedAssetsHistory, 1) != null ? deltaFor(fedAssetsHistory, 1)! / 1000 : null}
          deltaM={deltaFor(fedAssetsHistory, 4) != null ? deltaFor(fedAssetsHistory, 4)! / 1000 : null}
        />
        <PlumbingNode
          label="Treasury Gen. Acct"
          valueB={latestB(tgaHistory, 1000)}
          deltaW={deltaFor(tgaHistory, 1) != null ? deltaFor(tgaHistory, 1)! / 1000 : null}
          deltaM={deltaFor(tgaHistory, 4) != null ? deltaFor(tgaHistory, 4)! / 1000 : null}
          sign="-"
        />
        <PlumbingNode
          label="Overnight RRP"
          valueB={latestB(rrpHistory, 1)}
          deltaW={deltaFor(rrpHistory, 7)}
          deltaM={deltaFor(rrpHistory, 30)}
          sign="-"
        />
        <PlumbingNode
          label="Net Liquidity"
          valueB={latestB(netLiquidityHistory, 1)}
          deltaW={deltaFor(netLiquidityHistory, 1)}
          deltaM={deltaFor(netLiquidityHistory, 4)}
          sign="="
        />
      </div>
      <p className="text-xs text-slate-500">
        Net Liquidity = Fed Assets − TGA − RRP. Rising ≈ more dollars available to markets.
      </p>
    </div>
  );
}
