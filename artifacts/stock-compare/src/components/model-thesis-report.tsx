/**
 * Investment-report header for a Model List pick — shown at the top of StockBreakdown.
 */
import { useState } from "react";
import { WhyCallout, WhyMetric } from "@/components/research-why";
import { VERDICT_COLORS, VERDICT_LABELS, type ModelListItem } from "@/hooks/use-model-list";
import { cn } from "@/lib/utils";

export type ModelThesis = {
  folderKey: string;
  folderName: string;
  folderDescription: string;
  item: ModelListItem;
};

function fmtExpiry(iso: string) {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function pct(x: number) {
  return `${Math.round(x * 100)}%`;
}

function usd(x: number) {
  return `${x >= 0 ? "+" : "−"}$${Math.abs(Math.round(x))}`;
}

function usdTone(x: number) {
  return x >= 0 ? "text-green-400" : "text-red-400";
}

function toneForVerdict(v: string): "good" | "bad" | "warn" | "neutral" {
  if (v === "green") return "good";
  if (v === "red") return "bad";
  if (v === "yellow" || v === "purple") return "warn";
  return "neutral";
}

/** "Explain AI" for a Model List pick: the server narrates the stored item (numbers come from the model, not the AI). */
function ModelPickExplain({ thesis }: { thesis: ModelThesis }) {
  const [state, setState] = useState<{ status: "idle" | "loading" | "done" | "error"; text: string }>({ status: "idle", text: "" });
  const c = thesis.item.contract;
  const run = async () => {
    setState({ status: "loading", text: "" });
    try {
      const res = await fetch("/api/explain/model-pick", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: thesis.item.ticker, folderKey: thesis.folderKey, type: c?.type ?? "", account: c?.account ?? "" }),
      });
      const data = (await res.json()) as { explanation?: string; error?: string };
      setState(data.explanation ? { status: "done", text: data.explanation } : { status: "error", text: data.error ?? "No explanation available." });
    } catch {
      setState({ status: "error", text: "Unable to reach the explainer." });
    }
  };
  if (state.status === "idle") {
    return (
      <button onClick={run} className="text-[10px] px-2 py-0.5 rounded border border-[#d4af37]/40 text-[#d4af37] hover:bg-[#d4af37]/10">
        Explain this pick (AI)
      </button>
    );
  }
  return (
    <div className="rounded border border-[#d4af37]/25 px-2 py-1.5 text-[11px] leading-snug text-zinc-300 whitespace-pre-wrap">
      <div className="text-[9px] uppercase tracking-wider text-amber-200/50 mb-0.5">AI explanation · numbers from the model</div>
      {state.status === "loading" ? "Explaining…" : state.text.replace(/\*\*/g, "")}
    </div>
  );
}

export function ModelThesisReport({ thesis }: { thesis: ModelThesis }) {
  const { item, folderName, folderDescription } = thesis;
  const color = VERDICT_COLORS[item.verdict] ?? "";
  const tone = toneForVerdict(item.verdict);
  const c = item.contract;
  const pillars = item.pillars;
  const score = item.score != null ? Math.round(item.score) : null;

  return (
    <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 px-3 py-2.5 space-y-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="text-[9px] uppercase tracking-[0.14em] text-amber-200/40">Model thesis · investment report</div>
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border",
                tone === "good" && "border-green-500/40 text-green-300",
                tone === "bad" && "border-red-500/40 text-red-300",
                tone === "warn" && "border-amber-400/40 text-amber-200",
                tone === "neutral" && "border-zinc-600 text-zinc-400",
              )}
            >
              {VERDICT_LABELS[item.verdict] || item.verdict || "Watch"}
            </span>
            <span className="text-[11px] font-semibold text-[#d4af37]">{folderName}</span>
            {score != null && (
              <span className="font-mono text-[11px] text-zinc-300">score {score}</span>
            )}
            {item.role === "held" && (
              <span className="text-[9px] px-1 rounded bg-[#3b82f6]/25 text-[#93c5fd]">held</span>
            )}
            {item.status !== "ok" && (
              <span className="text-[9px] px-1 rounded bg-amber-500/20 text-amber-300">{item.status}</span>
            )}
          </div>
          <p className="text-[10px] text-zinc-500 leading-snug">{folderDescription}</p>
        </div>
        {c && (
          <div className="text-right shrink-0 font-mono text-[11px] text-zinc-200">
            <div className="text-[9px] uppercase tracking-wider text-zinc-500">Idea</div>
            <div>
              {c.strike}
              {c.type === "put" ? "P" : "C"} {fmtExpiry(c.expiry)}
              {c.contracts ? ` ×${c.contracts}` : ""}
            </div>
            {c.premium != null && (
              <div className="text-zinc-500" title={c.model_premium != null ? `Realistic Robinhood fill. Fildi model premium $${c.model_premium.toFixed(2)}` : undefined}>
                {c.model_premium != null ? "fill" : "prem"} ${c.premium.toFixed(2)}
              </div>
            )}
            {c.fair_value && (
              <div
                className="text-zinc-400"
                title={`Blended fair value $${c.fair_value.value.toFixed(2)} (${c.fair_value.confidence ?? "low"} conf.${c.fair_value.value_trap ? "; value-trap risk" : ""}${c.fair_value.cyclical ? "; cyclical" : ""}). Valuation reference only — not a buy/sell or sizing signal.`}
              >
                strike {c.fair_value.strike_vs_fair >= 0 ? "+" : ""}
                {(c.fair_value.strike_vs_fair * 100).toFixed(0)}% vs fair
                {c.fair_value.value_trap ? " · trap" : ""}
              </div>
            )}
            {c.win && (
              <div
                className="text-zinc-300"
                title={`${c.win.outside ? "≈ nearest tested cell. " : ""}Share of ${c.win.n.toLocaleString()} reconstructed ${c.type === "put" ? "puts" : "covered calls"} at Δ${c.win.delta.toFixed(2)}, ${c.win.dte}d (2020→) that made money. Worst year ${pct(c.win.lo)}, best ${pct(c.win.hi)}. Not a forecast for this stock: delta already prices its volatility; per-stock history added nothing.`}
              >
                wins {c.win.outside || c.win.extrapolated ? "≈" : ""}{pct(c.win.rate)} <span className="text-zinc-500">({pct(c.win.lo)}–{pct(c.win.hi)})</span>
              </div>
            )}
            {c.account && (
              <div className="text-zinc-500">{c.account === "Traditional IRA" ? "IRA" : c.account}</div>
            )}
          </div>
        )}
      </div>

      <WhyCallout
        tone={tone}
        title={
          <span className="flex items-center gap-2">
            {color ? <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} /> : null}
            Why this trade
          </span>
        }
      >
        {item.why.length === 0 ? (
          <p className="text-zinc-500 italic">No model rationale on this run.</p>
        ) : (
          <ul className="list-disc pl-3.5 space-y-0.5">
            {item.why.map((w, i) => (
              <li key={i} className={cn(w.startsWith("⚠") && "text-orange-300")}>{w}</li>
            ))}
          </ul>
        )}
      </WhyCallout>

      {pillars && (
        <div className="grid grid-cols-5 gap-1.5">
          {([
            ["own", "Own"],
            ["street", "Street"],
            ["premium", "Prem"],
            ["fit", "Fit"],
            ["edge", "Edge"],
          ] as const).map(([k, label]) => (
            <WhyMetric
              key={k}
              label={label}
              value={pillars[k] != null ? Math.round(pillars[k]!) : "—"}
              tone="neutral"
            />
          ))}
        </div>
      )}

      {c?.win?.ev != null && c.win.ev_good != null && c.win.ev_bad != null && (
        <div className="space-y-1">
          <div
            className="text-[10px] text-zinc-400"
            title="Per contract at the realistic fill, using how much options at this delta / expiry paid out historically (scaled by this stock's ATM implied vol). Good / average / bad = best, all-years and worst calendar year 2020→. The all-stock average roughly broke even; the Model List's edge is in which names it picks, which this table can't see."
          >
            Per contract (history): good <span className={usdTone(c.win.ev_good)}>{usd(c.win.ev_good)}</span> · avg{" "}
            <span className={usdTone(c.win.ev)}>{usd(c.win.ev)}</span> · bad <span className={usdTone(c.win.ev_bad)}>{usd(c.win.ev_bad)}</span>
          </div>
          {c.win.alts && c.win.alts.length > 0 && (
            <table className="text-[10px] font-mono text-zinc-400" title="Same expiry at other deltas. Strike and premium are Black-Scholes estimates (no skew) scaled from the real fill: check the chain before trading.">
              <thead>
                <tr className="text-zinc-500">
                  <th className="text-left pr-2 font-normal">what-if Δ</th>
                  <th className="text-right pr-2 font-normal">strike≈</th>
                  <th className="text-right pr-2 font-normal">prem≈</th>
                  <th className="text-right pr-2 font-normal">wins</th>
                  <th className="text-right pr-2 font-normal">avg $</th>
                  <th className="text-right font-normal">bad $</th>
                </tr>
              </thead>
              <tbody>
                {c.win.alts.map((a) => (
                  <tr key={a.delta}>
                    <td className="pr-2">{a.delta.toFixed(2)}</td>
                    <td className="text-right pr-2">{a.strike.toFixed(2)}</td>
                    <td className="text-right pr-2">{a.premium.toFixed(2)}</td>
                    <td className="text-right pr-2">{pct(a.rate)}</td>
                    <td className={cn("text-right pr-2", usdTone(a.ev))}>{usd(a.ev)}</td>
                    <td className={cn("text-right", usdTone(a.ev_bad))}>{usd(a.ev_bad)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {c?.vol && (
        <div
          className="text-[10px] text-zinc-400"
          title={`This contract's IV ${pct(c.vol.contract_iv)} vs the stock's 20-day realized vol ${pct(c.vol.rv20)}. Options priced above recent moves (> 1×) is the edge the scorecard lab validated. The 30-day ATM ratio${c.vol.atm30_iv_rv != null ? ` (${c.vol.atm30_iv_rv.toFixed(2)}×)` : ""} feeds the Prem pillar; it can include an earnings date this contract doesn't cover.`}
        >
          Options vs realized:{" "}
          <span className={c.vol.contract_iv_rv >= 1.1 ? "text-green-400" : c.vol.contract_iv_rv < 0.95 ? "text-red-400" : "text-zinc-300"}>
            {c.vol.contract_iv_rv.toFixed(2)}× {c.vol.contract_iv_rv >= 1.1 ? "rich" : c.vol.contract_iv_rv < 0.95 ? "cheap" : "fair"}
          </span>
          {c.vol.atm30_iv_rv != null && Math.abs(c.vol.atm30_iv_rv - c.vol.contract_iv_rv) >= 0.15 && (
            <span className="text-amber-300"> · 30-day {c.vol.atm30_iv_rv.toFixed(2)}× (Prem pillar sees this)</span>
          )}
        </div>
      )}

      {c?.earnings && c.earnings.days_after_expiry <= 14 && (
        <div className={cn("text-[10px]", c.earnings.inside ? "text-orange-300" : "text-zinc-400")}>
          Earnings {fmtExpiry(c.earnings.date)}:{" "}
          {c.earnings.inside ? "inside this trade's window (gap risk)" : `${c.earnings.days_after_expiry}d after expiry`}
        </div>
      )}

      {c?.record && (
        <div className="text-[10px] text-zinc-400" title={`Your Robinhood realized closes on ${item.ticker} ${c.type}s since ${c.record.since}. Small samples: descriptive, not a forecast.`}>
          Your record ({c.type}s): {c.record.wins} of {c.record.n} profitable ·{" "}
          <span className={usdTone(c.record.pnl)}>{usd(c.record.pnl)}</span> total
        </div>
      )}

      {pillars?.ma200 != null && (
        <div className="text-[10px] text-zinc-400" title="Close vs its 200-day average: the long-term trend signal that passed the scorecard lab (63-day return vs peers).">
          Trend:{" "}
          <span className={pillars.ma200 >= 0 ? "text-green-400" : "text-red-400"}>
            {pillars.ma200 >= 0 ? "above" : "below"} 200-day ({pillars.ma200 >= 0 ? "+" : ""}{(pillars.ma200 * 100).toFixed(0)}%)
          </span>
        </div>
      )}

      <ModelPickExplain key={`${thesis.folderKey}:${item.ticker}:${item.contract?.type ?? ""}:${item.contract?.account ?? ""}`} thesis={thesis} />

      {item.adjustments && item.adjustments.length > 0 && (
        <div className="rounded border border-amber-400/20 px-2 py-1">
          <div className="text-[9px] uppercase tracking-wider text-amber-200/50 mb-0.5">Adjustments</div>
          <table className="text-[10px] w-full">
            <tbody>
              {item.adjustments.map((a, i) => {
                const num = typeof a.from === "number" && typeof a.to === "number";
                const net = num ? (a.to as number) - (a.from as number) : null;
                return (
                  <tr key={i} className="align-top">
                    <td className="pr-2 text-zinc-300 font-semibold whitespace-nowrap">{a.what}</td>
                    <td className="pr-2 font-mono whitespace-nowrap text-zinc-400">
                      {num ? Math.round(a.from as number) : a.from} → {num ? Math.round(a.to as number) : a.to}
                      {net != null && (
                        <span className={cn("ml-1", net >= 0 ? "text-green-400" : "text-red-400")}>
                          ({net >= 0 ? "+" : ""}{net.toFixed(1)})
                        </span>
                      )}
                    </td>
                    <td className="text-zinc-500">{a.why}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {item.flags.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {item.flags.map((f) => (
            <span key={f} className="text-[9px] px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400">
              {f}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
