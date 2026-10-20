/**
 * Investment-report header for a Model List pick — shown at the top of StockBreakdown.
 * Action ticket: what · size · when/trigger · why · redeploy (cash until publish attaches alts).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { WhyCallout, WhyMetric } from "@/components/research-why";
import { RiskWhatIfBadge, modelAccountToPm } from "@/components/live/risk-what-if-badge";
import { VERDICT_COLORS, VERDICT_LABELS, type ModelListItem } from "@/hooks/use-model-list";
import { cn } from "@/lib/utils";

export type ModelThesis = {
  folderKey: string;
  folderName: string;
  folderDescription: string;
  item: ModelListItem;
};

type PillarTone = "good" | "bad" | "warn" | "neutral";

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

function toneForVerdict(v: string): PillarTone {
  if (v === "green") return "good";
  if (v === "red") return "bad";
  if (v === "yellow" || v === "purple") return "warn";
  return "neutral";
}

function pillarTone(key: string, v: number | null | undefined, isTrim: boolean): PillarTone {
  if (v == null) return "neutral";
  if (key === "own") return v < 35 ? "bad" : v < 50 ? "warn" : v >= 70 ? "good" : "neutral";
  if (key === "edge") {
    if (isTrim) return v <= 0 ? "bad" : "neutral";
    return v < 20 ? "bad" : v < 40 ? "warn" : v >= 60 ? "good" : "neutral";
  }
  if (key === "fit") return isTrim ? "neutral" : v >= 70 ? "good" : v < 40 ? "warn" : "neutral";
  if (key === "premium") return isTrim ? "neutral" : v >= 65 ? "good" : v < 40 ? "warn" : "neutral";
  if (key === "street") return v < 40 ? "warn" : v >= 65 ? "good" : "neutral";
  return "neutral";
}

/** Rank why lines: knife / credit / LSEG first; drop dupes already in flags. */
function rankedWhy(why: string[], flags: string[]): string[] {
  const flagNorm = new Set(flags.map((f) => f.toLowerCase()));
  const uniq = why.filter((w) => {
    const n = w.replace(/^⚠\s*/, "").toLowerCase();
    return ![...flagNorm].some((f) => n.includes(f) || f.includes(n.slice(0, 24)));
  });
  const score = (w: string) => {
    const s = w.toLowerCase();
    if (s.includes("falling-knife") || s.includes("falling knife")) return 0;
    if (s.includes("fragile") || s.includes("credit") || s.includes("balance")) return 1;
    if (s.includes("lseg") || s.includes("weak overall")) return 2;
    if (s.includes("wheel") || s.includes("p&l")) return 4;
    return 3;
  };
  return uniq.slice().sort((a, b) => score(a) - score(b)).slice(0, 4);
}

function urgencyFor(item: ModelListItem, isTrim: boolean): "HIGH" | "MED" | "LOW" {
  const blob = `${item.why.join(" ")} ${item.flags.join(" ")}`.toLowerCase();
  const knife = blob.includes("falling-knife") || blob.includes("falling knife");
  const score = item.score ?? 50;
  if (isTrim && (knife || score <= 3 || item.verdict === "red")) return "HIGH";
  if (isTrim || item.verdict === "red" || knife) return "MED";
  return "LOW";
}

async function fetchHeldShares(ticker: string): Promise<number | null> {
  const r = await fetch(`/api/research/lseg/${encodeURIComponent(ticker)}`, { credentials: "include" });
  if (!r.ok) return null;
  const data = (await r.json()) as { myPosition?: { shares?: number | null } | null };
  const sh = data.myPosition?.shares;
  return sh != null && Number.isFinite(sh) && sh > 0 ? sh : null;
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
      <button type="button" onClick={run} className="text-[10px] px-2 py-0.5 rounded border border-[#d4af37]/40 text-[#d4af37] hover:bg-[#d4af37]/10">
        Explain this pick (AI)
      </button>
    );
  }
  return (
    <div className="rounded border border-[#d4af37]/25 px-2 py-1.5 text-[11px] leading-snug text-amber-100/85 whitespace-pre-wrap">
      <div className="text-[9px] uppercase tracking-wider text-amber-200/70 mb-0.5">AI explanation · numbers from the model</div>
      {state.status === "loading" ? "Explaining…" : state.text.replace(/\*\*/g, "")}
    </div>
  );
}

function ActionTicket({
  thesis,
  shares,
  isTrim,
}: {
  thesis: ModelThesis;
  shares: number | null;
  isTrim: boolean;
}) {
  const { item, folderName } = thesis;
  const c = item.contract;
  const urgency = urgencyFor(item, isTrim);
  const close = item.close;
  const mv = shares != null && close != null ? shares * close : null;
  const why = rankedWhy(item.why, item.flags);

  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2 space-y-1.5",
        urgency === "HIGH" ? "border-red-500/45 bg-red-500/[0.07]"
          : urgency === "MED" ? "border-amber-400/40 bg-amber-500/[0.06]"
            : "border-[#d4af37]/25 bg-zinc-950",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={cn(
          "text-[10px] font-bold uppercase tracking-wide",
          urgency === "HIGH" ? "text-red-300" : urgency === "MED" ? "text-amber-200" : "text-[#d4af37]",
        )}>
          {isTrim ? "Trim" : folderName}
        </span>
        <span className="text-[12px] font-bold text-white font-mono">{item.ticker}</span>
        <span className={cn(
          "text-[9px] font-bold uppercase px-1 py-0.5 rounded border",
          urgency === "HIGH" ? "border-red-400/50 text-red-300" : urgency === "MED" ? "border-amber-400/50 text-amber-200" : "border-zinc-600 text-amber-200/70",
        )}>
          {urgency}
        </span>
        {item.score != null && (
          <span className="font-mono text-[10px] text-amber-100/80">score {Math.round(item.score)}</span>
        )}
        {item.role === "held" && (
          <span className="text-[9px] px-1 rounded bg-[#3b82f6]/25 text-[#93c5fd]">held</span>
        )}
      </div>

      {/* What / size / when */}
      <div className="grid grid-cols-[4.5rem_1fr] gap-x-2 gap-y-0.5 text-[11px] font-mono leading-snug">
        <span className="text-amber-200/70">What</span>
        <span className="text-white">
          {isTrim
            ? `Reduce ${item.ticker} equity`
            : c
              ? `Sell ${c.strike}${c.type === "put" ? "P" : "C"} ${fmtExpiry(c.expiry)}${c.contracts ? ` ×${c.contracts}` : ""}`
              : folderName}
        </span>
        <span className="text-amber-200/70">Size</span>
        <span className="text-white">
          {isTrim ? (
            shares != null ? (
              <>
                {shares.toLocaleString()} sh
                {mv != null && <span className="text-amber-200/70"> · ~${Math.round(mv).toLocaleString()}</span>}
                <span className="text-amber-200/60"> · full exit unless you size down</span>
              </>
            ) : (
              <span className="text-amber-200/70">held size unknown (RH book) — check Open Positions</span>
            )
          ) : c?.contracts != null ? (
            <>{c.contracts} contract{c.contracts === 1 ? "" : "s"}{c.collateral != null ? ` · collat $${Math.round(c.collateral).toLocaleString()}` : ""}</>
          ) : (
            <span className="text-amber-200/70">—</span>
          )}
        </span>
        <span className="text-amber-200/70">When</span>
        <span className="text-white">
          {isTrim
            ? "Next RTH — market (knife) or limit near last"
            : c
              ? `Before ${fmtExpiry(c.expiry)} · fill ~$${c.premium?.toFixed(2) ?? "—"}`
              : "—"}
          {close != null && <span className="text-amber-200/60"> · spot ${close.toFixed(2)}</span>}
        </span>
        <span className="text-amber-200/70">Why</span>
        <span className="text-amber-100/90">
          {why.length === 0 ? (item.flags[0] ?? "Model folder rule") : why.slice(0, 3).join(" · ")}
        </span>
        <span className="text-amber-200/70">→ Into</span>
        <span className={isTrim ? "text-sky-300 font-semibold" : "text-amber-100/90"}>
          {isTrim
            ? "CASH (no replace pick on this run) — park BP until next Sell Put / capacity"
            : c?.account
              ? `${c.account === "Traditional IRA" ? "IRA" : c.account} book`
              : "Sized book"}
        </span>
      </div>
    </div>
  );
}

export function ModelThesisReport({ thesis }: { thesis: ModelThesis }) {
  const { item, folderName, folderDescription, folderKey } = thesis;
  const color = VERDICT_COLORS[item.verdict] ?? "";
  const tone = toneForVerdict(item.verdict);
  const c = item.contract;
  const pillars = item.pillars;
  const isTrim = folderKey === "trim_risk" || folderName.toLowerCase().includes("trim");
  const needShares = isTrim || item.role === "held";

  const { data: shares = null } = useQuery({
    queryKey: ["held-shares", item.ticker],
    queryFn: () => fetchHeldShares(item.ticker),
    enabled: needShares,
    staleTime: 5 * 60_000,
  });

  const whyLines = rankedWhy(item.why, item.flags);
  const flagOnly = item.flags.filter((f) => {
    const fl = f.toLowerCase();
    return !whyLines.some((w) => w.toLowerCase().includes(fl.slice(0, 18)));
  });

  return (
    <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 px-2.5 py-2 space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="text-[9px] uppercase tracking-[0.12em] text-amber-200/70">Model thesis</span>
        <span
          className={cn(
            "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border",
            tone === "good" && "border-green-500/40 text-green-300",
            tone === "bad" && "border-red-500/40 text-red-300",
            tone === "warn" && "border-amber-400/40 text-amber-200",
            tone === "neutral" && "border-zinc-600 text-amber-200/70",
          )}
        >
          {VERDICT_LABELS[item.verdict] || item.verdict || "Watch"}
        </span>
        <span className="text-[10px] text-amber-200/60 truncate" title={folderDescription}>{folderDescription}</span>
      </div>

      <ActionTicket thesis={thesis} shares={shares} isTrim={isTrim} />

      {c?.type === "put" && c.strike > 0 && c.expiry && item.close != null && item.close > 0 && (c.vol?.contract_iv ?? 0) > 0 && (
        <RiskWhatIfBadge
          compact
          input={{
            account: modelAccountToPm(c.account),
            ticker: item.ticker,
            strike: c.strike,
            expiry: c.expiry,
            qty: c.contracts ?? 1,
            iv: c.vol!.contract_iv,
            spot: item.close,
            premium: c.premium,
            surface: "model_list",
          }}
        />
      )}

      {whyLines.length > 0 && (
        <WhyCallout
          tone={tone}
          title={
            <span className="flex items-center gap-2 text-[11px]">
              {color ? <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: color }} /> : null}
              Drivers
            </span>
          }
        >
          <ol className="list-decimal pl-3.5 space-y-0.5 text-[11px] text-amber-100/85">
            {whyLines.map((w, i) => (
              <li key={i} className={cn(w.startsWith("⚠") && "text-orange-300")}>{w}</li>
            ))}
          </ol>
        </WhyCallout>
      )}

      {pillars && (
        <div className="grid grid-cols-5 gap-1">
          {([
            ["own", "Own"],
            ["street", "Street"],
            ["premium", "Prem"],
            ["fit", "Fit"],
            ["edge", "Edge"],
          ] as const).map(([k, label]) => {
            const v = pillars[k];
            const pt = pillarTone(k, v, isTrim);
            return (
              <WhyMetric
                key={k}
                label={label}
                value={v != null ? Math.round(v) : "—"}
                tone={pt}
              />
            );
          })}
        </div>
      )}

      {pillars?.ma200 != null && (
        <div className="text-[10px] text-amber-200/70" title="Close vs 200-day average">
          Trend:{" "}
          <span className={pillars.ma200 >= 0 ? "text-green-400" : "text-red-400"}>
            {pillars.ma200 >= 0 ? "above" : "below"} 200-day ({pillars.ma200 >= 0 ? "+" : ""}{(pillars.ma200 * 100).toFixed(0)}%)
          </span>
        </div>
      )}

      {c?.win?.ev != null && c.win.ev_good != null && c.win.ev_bad != null && (
        <div className="text-[10px] text-amber-200/70">
          Per contract (history): good <span className={usdTone(c.win.ev_good)}>{usd(c.win.ev_good)}</span> · avg{" "}
          <span className={usdTone(c.win.ev)}>{usd(c.win.ev)}</span> · bad <span className={usdTone(c.win.ev_bad)}>{usd(c.win.ev_bad)}</span>
        </div>
      )}

      {c?.vol && (
        <div className="text-[10px] text-amber-200/70">
          Options vs realized:{" "}
          <span className={c.vol.contract_iv_rv >= 1.1 ? "text-green-400" : c.vol.contract_iv_rv < 0.95 ? "text-red-400" : "text-amber-100"}>
            {c.vol.contract_iv_rv.toFixed(2)}× {c.vol.contract_iv_rv >= 1.1 ? "rich" : c.vol.contract_iv_rv < 0.95 ? "cheap" : "fair"}
          </span>
        </div>
      )}

      {c?.earnings && c.earnings.days_after_expiry <= 14 && (
        <div className={cn("text-[10px]", c.earnings.inside ? "text-orange-300" : "text-amber-200/70")}>
          Earnings {fmtExpiry(c.earnings.date)}:{" "}
          {c.earnings.inside ? "inside this trade's window (gap risk)" : `${c.earnings.days_after_expiry}d after expiry`}
        </div>
      )}

      {c?.record && (
        <div className="text-[10px] text-amber-200/70">
          Your record ({c.type}s): {c.record.wins} of {c.record.n} profitable ·{" "}
          <span className={usdTone(c.record.pnl)}>{usd(c.record.pnl)}</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ModelPickExplain key={`${thesis.folderKey}:${item.ticker}:${item.contract?.type ?? ""}:${item.contract?.account ?? ""}`} thesis={thesis} />
        {flagOnly.map((f) => (
          <span key={f} className="text-[9px] px-1.5 py-0.5 rounded border border-amber-500/30 text-amber-200/80">
            {f}
          </span>
        ))}
      </div>

      {item.adjustments && item.adjustments.length > 0 && (
        <div className="rounded border border-amber-400/25 px-2 py-1">
          <div className="text-[9px] uppercase tracking-wider text-amber-200/70 mb-0.5">Adjustments</div>
          <table className="text-[10px] w-full">
            <tbody>
              {item.adjustments.map((a, i) => {
                const num = typeof a.from === "number" && typeof a.to === "number";
                const net = num ? (a.to as number) - (a.from as number) : null;
                return (
                  <tr key={i} className="align-top">
                    <td className="pr-2 text-amber-100 font-semibold whitespace-nowrap">{a.what}</td>
                    <td className="pr-2 font-mono whitespace-nowrap text-amber-200/80">
                      {num ? Math.round(a.from as number) : a.from} → {num ? Math.round(a.to as number) : a.to}
                      {net != null && (
                        <span className={cn("ml-1", net >= 0 ? "text-green-400" : "text-red-400")}>
                          ({net >= 0 ? "+" : ""}{net.toFixed(1)})
                        </span>
                      )}
                    </td>
                    <td className="text-amber-200/60">{a.why}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
