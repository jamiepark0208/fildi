/**
 * Investment-report header for a Model List pick — shown at the top of StockBreakdown.
 * Action ticket: what · size · when/trigger · why · redeploy (cash until publish attaches alts).
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { WhyCallout, WhyMetric } from "@/components/research-why";
import { RiskWhatIfBadge, modelAccountToPm } from "@/components/live/risk-what-if-badge";
import { PickOddsPanel } from "@/components/pick-odds-panel";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { VERDICT_LABELS, type ModelListItem } from "@/hooks/use-model-list";
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

/** m/d/yy for action ticket header */
function fmtExpiryMdYy(iso: string) {
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${Number(m)}/${Number(d)}/${y.slice(2)}`;
}

/** Chip shows short word (Model OWN); full VERDICT_LABELS detail on hover. */
function verdictChip(verdict: string): { short: string; tip: string } {
  const full = VERDICT_LABELS[verdict] || verdict || "Model WCH";
  const i = full.search(/[—:]/);
  if (i > 0) return { short: full.slice(0, i).trim().replace(/^Model\s+/i, ""), tip: full };
  return { short: full.replace(/^Model\s+/i, ""), tip: full };
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

/** Drop funding/cash fluff and flag dupes; keep economics + risk that change the decision. */
function isNoiseWhy(w: string): boolean {
  const s = w.replace(/^⚠\s*/, "").toLowerCase();
  if (s.startsWith("not funded") || s.includes("can't fund") || s.includes("cannot fund")) return true;
  if (s.includes("free up cash") || s.includes("$0 free")) return true;
  if (s.includes("closing open puts early would earn less")) return true;
  if (s.includes("all ") && s.includes("put ideas fit inside")) return true;
  return false;
}

function isUsefulWhy(w: string): boolean {
  const s = w.toLowerCase();
  if (isNoiseWhy(w)) return false;
  return (
    s.includes("option score")
    || s.includes("%/week")
    || s.includes("% / week")
    || /δ|delta|Δ/.test(s)
    || /\bdte\b/.test(s)
    || s.includes("put edge")
    || s.includes("falling-knife")
    || s.includes("falling knife")
    || s.includes("fragile")
    || s.includes("earnings")
    || s.includes("iv/rv")
    || s.includes("breach")
  );
}

/** Rank why lines: economics + real risk first; drop funding fluff and flag dupes. */
function rankedWhy(why: string[], flags: string[]): string[] {
  const flagNorm = new Set(flags.map((f) => f.toLowerCase()));
  const uniq = why.filter((w) => {
    if (isNoiseWhy(w)) return false;
    const n = w.replace(/^⚠\s*/, "").toLowerCase();
    return ![...flagNorm].some((f) => n.includes(f) || f.includes(n.slice(0, 24)));
  });
  const prefer = uniq.filter(isUsefulWhy);
  const pool = prefer.length ? prefer : uniq;
  const score = (w: string) => {
    const s = w.toLowerCase();
    if (s.includes("falling-knife") || s.includes("falling knife")) return 0;
    if (s.includes("option score") || s.includes("%/week")) return 1;
    if (s.includes("put edge") || s.includes("breach")) return 2;
    if (s.includes("fragile") || s.includes("credit") || s.includes("earnings")) return 3;
    return 4;
  };
  return pool.slice().sort((a, b) => score(a) - score(b)).slice(0, 4);
}

function dteDays(expiry: string): number | null {
  const t = Date.parse(`${expiry}T16:00:00`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.ceil((t - Date.now()) / 86_400_000));
}

/** Collateral-based weekly income for short premium (premium / strike × 100 / weeks). */
function incomeLine(c: NonNullable<ModelListItem["contract"]>): string | null {
  if (c.premium == null || !(c.premium > 0) || !(c.strike > 0)) return null;
  const dte = dteDays(c.expiry);
  const weekPct = dte != null && dte > 0
    ? (c.premium / c.strike) * 100 * (7 / dte)
    : null;
  const bits = [`~$${c.premium.toFixed(2)}`];
  if (weekPct != null) bits.push(`${weekPct.toFixed(2)}%/wk`);
  if (dte != null) bits.push(`${dte}d`);
  return bits.join(" · ");
}

function pillarTip(
  key: "own" | "street" | "premium" | "fit" | "edge",
  v: number | null | undefined,
  isTrim: boolean,
): string {
  if (key === "own") {
    if (v == null) return "Own score missing — fit model did not score this ticker.";
    if (v < 35) return `Own ${Math.round(v)}: weak hold-worthiness (would not want assignment).`;
    if (v >= 70) return `Own ${Math.round(v)}: happy to hold if assigned.`;
    return `Own ${Math.round(v)}: mid — assignment is acceptable, not a goal.`;
  }
  if (key === "street") {
    if (v == null) return "Street score missing.";
    return `Street ${Math.round(v)}: analyst/estimate quality vs peers (higher = cleaner street picture).`;
  }
  if (key === "premium") {
    if (v == null) return "Premium score missing — no option IV edge scored.";
    return `Prem ${Math.round(v)}: how rich option premium looks vs realized vol / peers.`;
  }
  if (key === "fit") {
    if (v == null) return "Fit not scored for this ticker.";
    if (v === 0) {
      return isTrim
        ? "Fit 0 on a trim: book-fit not the point — this is a risk cut, not a new put."
        : "Fit 0: this idea does not fit the book right now (cash/collateral or soft limits). The contract can still be good — Size stays empty until you free capacity.";
    }
    if (v < 40) return `Fit ${Math.round(v)}: tight vs your book limits — size carefully or skip.`;
    if (v >= 70) return `Fit ${Math.round(v)}: clears book/capacity checks.`;
    return `Fit ${Math.round(v)}: partial book fit.`;
  }
  // edge
  if (v == null) {
    return isTrim
      ? "Edge blank on trim rows — put-edge (S059) ranks new short puts, not exits."
      : "Edge blank: no S059 put-edge inputs for this name (or edge lane demoted). Not a score of zero — missing.";
  }
  if (v < 20) return `Edge ${Math.round(v)}: weak simulated put edge (S059).`;
  if (v >= 60) return `Edge ${Math.round(v)}: strong simulated put edge quintile (S059).`;
  return `Edge ${Math.round(v)}: mid simulated put edge (S059).`;
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
      <button type="button" onClick={run} className="text-[10px] px-2 py-0.5 rounded border border-[#d4af37]/50 text-amber-50 bg-[#d4af37]/15 hover:bg-[#d4af37]/25">
        Explain this pick (AI)
      </button>
    );
  }
  return (
    <div className="rounded border border-[#d4af37]/35 px-2 py-1.5 text-[11px] leading-snug text-amber-50 whitespace-pre-wrap">
      <div className="text-[9px] font-bold uppercase tracking-wider text-[#d4af37] mb-0.5">AI explanation · numbers from the model</div>
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
  const income = c && !isTrim ? incomeLine(c) : null;
  const scoreWhy = why.find((w) => w.toLowerCase().includes("option score"));
  const weekWhy = why.find((w) => w.toLowerCase().includes("%/week") || w.toLowerCase().includes("% / week"));
  const edgeWhy = why.find((w) => w.toLowerCase().includes("put edge"));
  const riskWhy = why.filter((w) =>
    /falling.?knife|fragile|earnings|credit/i.test(w)
    && w !== scoreWhy && w !== weekWhy && w !== edgeWhy,
  );

  // Compact Why: score · X%/wk · Δ · edge (drop long "at $strike (N DTE…)" prose).
  const whyCompact: Array<{ cls: string; text: string }> = [];
  if (item.score != null) whyCompact.push({ cls: "text-sky-300", text: `score ${Math.round(item.score)}` });
  if (weekWhy) {
    const pctM = weekWhy.match(/([\d.]+)\s*%\s*\/?\s*week/i);
    whyCompact.push({ cls: "text-emerald-400", text: pctM ? `${pctM[1]}%/wk` : "yield" });
    const dM = weekWhy.match(/Δ\s*([+\-]?\d+\.?\d*)/i) || weekWhy.match(/delta\s*([+\-]?\d+\.?\d*)/i);
    if (dM) whyCompact.push({ cls: "text-amber-100", text: `Δ${dM[1].startsWith("+") || dM[1].startsWith("-") ? dM[1] : `+${dM[1]}`}` });
  }
  if (edgeWhy) {
    const eM = edgeWhy.match(/([\d.]+)/);
    whyCompact.push({ cls: "text-violet-300", text: eM ? `edge ${eM[1]}` : "put edge" });
  }
  for (const w of riskWhy.slice(0, 1)) {
    whyCompact.push({ cls: "text-orange-300", text: w.replace(/^⚠\s*/, "").slice(0, 28) });
  }
  if (whyCompact.length === 0 && why[0]) whyCompact.push({ cls: "text-amber-100/80", text: why[0].slice(0, 40) });

  const sideLabel = isTrim
    ? "TRIM"
    : c?.type === "put"
      ? "SELL PUT"
      : c?.type === "call"
        ? "SELL CALL"
        : folderName.toUpperCase();

  return (
    <div
      className={cn(
        "rounded-md border px-2.5 py-2 space-y-1.5",
        urgency === "HIGH" ? "border-red-500/45 bg-red-500/[0.07]"
          : urgency === "MED" ? "border-amber-400/40 bg-amber-500/[0.06]"
            : "border-[#d4af37]/30 bg-black/30",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className={cn(
          "text-[10px] font-bold uppercase tracking-wide",
          urgency === "HIGH" ? "text-red-300" : urgency === "MED" ? "text-amber-100" : "text-[#d4af37]",
        )}>
          {sideLabel}
        </span>
        <span className="text-[13px] font-bold text-white font-mono tracking-wide">{item.ticker}</span>
        {close != null && (
          <span className="font-mono text-[12px] font-semibold text-sky-200">${close.toFixed(2)}</span>
        )}
        {!isTrim && c && (
          <>
            <span className="text-[11px] font-mono text-amber-50">
              at X=<span className="text-white font-semibold">${c.strike}</span>
            </span>
            <span className="text-[11px] font-mono text-amber-50">
              Exp <span className="text-white font-semibold">{fmtExpiryMdYy(c.expiry)}</span>
            </span>
          </>
        )}
        <span className={cn(
          "text-[9px] font-bold uppercase px-1 py-0.5 rounded border",
          urgency === "HIGH" ? "border-red-400/50 text-red-200 bg-red-900/40"
            : urgency === "MED" ? "border-amber-400/50 text-amber-50 bg-amber-900/35"
              : "border-[#d4af37]/40 text-amber-50 bg-zinc-800/80",
        )}>
          {urgency}
        </span>
        {item.score != null && (
          <span
            className={cn(
              "font-mono text-[11px] font-semibold",
              item.score >= 70 ? "text-emerald-400" : item.score >= 50 ? "text-sky-300" : "text-amber-200/80",
            )}
            title="Fildi option score for this contract"
          >
            {Math.round(item.score)}
          </span>
        )}
        {item.role === "held" && (
          <span className="text-[9px] px-1 rounded bg-[#3b82f6]/25 text-[#93c5fd]">held</span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-[11px] font-mono leading-snug">
        <div className="grid grid-cols-[3.25rem_1fr] gap-x-2 gap-y-0.5 content-start">
          <span className="text-[#d4af37] font-semibold">What</span>
          <span className="text-white font-semibold">
            {isTrim
              ? `Reduce ${item.ticker} equity`
              : c
                ? `Sell ${c.strike}${c.type === "put" ? "P" : "C"} ${fmtExpiry(c.expiry)}${c.contracts ? ` ×${c.contracts}` : ""}`
                : folderName}
          </span>
          {(isTrim || c?.contracts != null) && (
            <>
              <span className="text-[#d4af37] font-semibold">Size</span>
              <span className="text-white" title={isTrim ? undefined : "1 option contract = right on 100 shares"}>
                {isTrim ? (
                  shares != null ? (
                    <>
                      {shares.toLocaleString()} shares
                      {mv != null && <span className="text-amber-100/70"> · ~${Math.round(mv).toLocaleString()}</span>}
                    </>
                  ) : (
                    <span className="text-amber-100/70">unknown (RH book)</span>
                  )
                ) : (
                  <>
                    {c!.contracts === 1 ? "1 contract" : `${c!.contracts} contracts`}
                    <span className="text-amber-100/70"> (= {(c!.contracts ?? 1) * 100} sh)</span>
                  </>
                )}
              </span>
            </>
          )}
          {isTrim && (
            <>
              <span className="text-[#d4af37] font-semibold">When</span>
              <span className="text-white">Next RTH</span>
              <span className="text-[#d4af37] font-semibold">→ Into</span>
              <span className="text-sky-300 font-semibold">Cash</span>
            </>
          )}
        </div>
        <div className="grid grid-cols-[3.25rem_1fr] gap-x-2 gap-y-0.5 content-start">
          {!isTrim && (
            <>
              <span className="text-[#d4af37] font-semibold">Income</span>
              <span className={cn("font-semibold", income ? "text-emerald-400" : "text-amber-100/70")}>
                {income ?? (c?.premium != null ? `~$${c.premium.toFixed(2)}` : "—")}
              </span>
            </>
          )}
          <span className="text-[#d4af37] font-semibold">Why</span>
          <span className="text-amber-50">
            {whyCompact.map((p, i) => (
              <span key={i} className={p.cls}>
                {i > 0 ? " · " : ""}{p.text}
              </span>
            ))}
          </span>
        </div>
      </div>
    </div>
  );
}

export function ModelThesisReport({ thesis }: { thesis: ModelThesis }) {
  const { item, folderName, folderKey } = thesis;
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
  // Extra risk not already in the ticket Why economics line.
  const driverOnly = whyLines.filter((w) => {
    const s = w.toLowerCase();
    if (s.includes("option score")) return false;
    if (s.includes("%/week") || s.includes("% / week")) return false;
    return /falling.?knife|fragile|earnings|credit|put edge|breach|iv\/rv/i.test(w);
  });
  const flagOnly = item.flags.filter((f) => {
    const fl = f.toLowerCase();
    return !whyLines.some((w) => w.toLowerCase().includes(fl.slice(0, 18)));
  });

  return (
    <div className="rounded-md border border-[#d4af37]/35 bg-[#1E1E2E] px-2.5 py-2 space-y-2 shadow-lg shadow-black/40">
      {/* sticky so MODEL THESIS stays visible if scroll-anchor or a mid-page jump tries to hide it */}
      <div className="sticky top-0 z-10 -mx-2.5 -mt-2 px-2.5 pt-2 pb-1.5 mb-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 bg-[#1E1E2E]/95 backdrop-blur-sm border-b border-[#d4af37]/20">
        <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#d4af37]">
          Model thesis
        </span>
        {(() => {
          const chip = verdictChip(item.verdict);
          return (
            <Tooltip delayDuration={100}>
              <TooltipTrigger asChild>
                <span
                  className={cn(
                    "text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border cursor-help",
                    tone === "good" && "border-green-400/60 bg-green-700/50 text-white",
                    tone === "bad" && "border-red-400/70 bg-red-800/80 text-amber-50",
                    tone === "warn" && "border-amber-400/60 bg-amber-700/40 text-white",
                    tone === "neutral" && "border-[#d4af37]/40 bg-zinc-800 text-amber-50",
                  )}
                >
                  {chip.short}
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-[240px] text-[11px] text-amber-50 border border-[#d4af37]/40">
                {chip.tip}
              </TooltipContent>
            </Tooltip>
          );
        })()}
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

      {item.odds?.p_otm && <PickOddsPanel odds={item.odds} />}

      {driverOnly.length > 0 && (
        <WhyCallout
          tone={tone}
          title={<span className="text-[11px] text-amber-50">Also</span>}
        >
          <ul className="space-y-0.5 text-[11px]">
            {driverOnly.map((w, i) => (
              <li
                key={i}
                className={cn(
                  w.startsWith("⚠") || /falling.?knife|fragile/i.test(w) ? "text-orange-300" : "text-violet-200",
                )}
              >
                {w}
              </li>
            ))}
          </ul>
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
            const tip = pillarTip(k, v, isTrim);
            return (
              <Tooltip key={k} delayDuration={120}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className="text-left w-full rounded-sm cursor-help focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/40"
                  >
                    <WhyMetric
                      label={label}
                      value={v != null ? Math.round(v) : "—"}
                      tone={pt}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="max-w-[260px] bg-zinc-900 text-amber-50 border border-[#d4af37]/40 text-[11px] leading-snug"
                >
                  {tip}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      )}

      {/* Market facts (left) vs your trade history (right) */}
      {(pillars?.ma200 != null || c?.vol || c?.wall || (c?.earnings && c.earnings.days_after_expiry <= 14)
        || (c?.win?.ev != null && c.win.ev_good != null) || c?.record) && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="rounded border border-[#d4af37]/20 bg-black/20 px-2 py-1.5 space-y-1 min-h-[2.5rem]">
            <div className="text-[9px] font-bold uppercase tracking-wider text-[#d4af37]">Market</div>
            {pillars?.ma200 != null && (
              <div className="text-[10px] text-amber-50" title="Close vs 200-day average">
                Trend:{" "}
                <span className={pillars.ma200 >= 0 ? "text-green-400" : "text-red-400"}>
                  {pillars.ma200 >= 0 ? "above" : "below"} 200-day ({pillars.ma200 >= 0 ? "+" : ""}{(pillars.ma200 * 100).toFixed(0)}%)
                </span>
              </div>
            )}
            {c?.vol && (
              <div className="text-[10px] text-amber-50">
                Options vs realized:{" "}
                <span className={c.vol.contract_iv_rv >= 1.1 ? "text-green-400" : c.vol.contract_iv_rv < 0.95 ? "text-red-400" : "text-white"}>
                  {c.vol.contract_iv_rv.toFixed(2)}× {c.vol.contract_iv_rv >= 1.1 ? "rich" : c.vol.contract_iv_rv < 0.95 ? "cheap" : "fair"}
                </span>
              </div>
            )}
            {c?.wall && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="text-[10px] text-amber-50 cursor-help" title="Options-implied 5% breach level from ATM IV — not chart support/resistance">
                    Options IV {c.wall.kind}: <span className="font-mono text-white">${c.wall.level.toFixed(2)}</span> · strike{" "}
                    <span className="font-mono text-white">{c.wall.strike_sigma.toFixed(1)}σ</span>{" "}
                    {c.wall.beyond_wall ? "beyond the wall" : "inside the wall"}
                    {c.wall.held != null && (
                      <>
                        {" "}· stayed inside{" "}
                        <span className={c.wall.held >= 0.97 ? "text-green-400" : c.wall.held < 0.93 ? "text-red-400" : "text-white"}>
                          {Math.round(c.wall.held * 100)}%
                        </span>{" "}
                        past yr
                      </>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="max-w-[300px] text-[11px] leading-snug text-amber-50">
                  {c.wall.kind === "floor" ? "Put floor" : "Call ceiling"} = the price the options market gives a 5 % chance of finishing
                  {c.wall.kind === "floor" ? " below" : " above"} by expiry: spot × e^({c.wall.kind === "floor" ? "−" : "+"}1.645 × 30-day ATM IV × √(days/365)).
                  Strike σ = how many of those standard moves away the strike sits (live puts sell ~0.9–1.4σ, i.e. inside the wall, by design).
                  Stayed inside = how often this stock actually finished inside its own wall over the past year at this horizon
                  ({c.wall.held_n ?? "—"} start days, LSEG closes): above 95 % its options over-priced the tail; below, under-priced it.
                  Display only — not a filter.
                </TooltipContent>
              </Tooltip>
            )}
            {c?.earnings && c.earnings.days_after_expiry <= 14 && (
              <div className={cn("text-[10px]", c.earnings.inside ? "text-orange-300" : "text-amber-50")}>
                Earnings {fmtExpiry(c.earnings.date)}:{" "}
                {c.earnings.inside ? "inside this trade's window (gap risk)" : `${c.earnings.days_after_expiry}d after expiry`}
              </div>
            )}
            {!(pillars?.ma200 != null || c?.vol || c?.wall || (c?.earnings && c.earnings.days_after_expiry <= 14)) && (
              <div className="text-[10px] text-amber-100/60">No market bullets for this pick.</div>
            )}
          </div>

          <div className="rounded border border-[#d4af37]/20 bg-black/20 px-2 py-1.5 space-y-1 min-h-[2.5rem]">
            <div className="text-[9px] font-bold uppercase tracking-wider text-[#d4af37]">Your history</div>
            {c?.win?.ev != null && c.win.ev_good != null && c.win.ev_bad != null && (
              <div className="text-[10px] text-amber-50">
                Per contract: good <span className={usdTone(c.win.ev_good)}>{usd(c.win.ev_good)}</span> · avg{" "}
                <span className={usdTone(c.win.ev)}>{usd(c.win.ev)}</span> · bad <span className={usdTone(c.win.ev_bad)}>{usd(c.win.ev_bad)}</span>
              </div>
            )}
            {c?.record && (
              <div className="text-[10px] text-amber-50">
                Your record ({c.type}s): {c.record.wins} of {c.record.n} profitable ·{" "}
                <span className={usdTone(c.record.pnl)}>{usd(c.record.pnl)}</span>
              </div>
            )}
            {!(c?.win?.ev != null && c.win.ev_good != null) && !c?.record && (
              <div className="text-[10px] text-amber-100/60">No closed trades for this side yet.</div>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <ModelPickExplain key={`${thesis.folderKey}:${item.ticker}:${item.contract?.type ?? ""}:${item.contract?.account ?? ""}`} thesis={thesis} />
        {flagOnly.map((f) => (
          <span key={f} className="text-[9px] px-1.5 py-0.5 rounded border border-amber-400/50 bg-amber-900/40 text-amber-50">
            {f}
          </span>
        ))}
      </div>

      {item.adjustments && item.adjustments.length > 0 && (
        <div className="rounded border border-amber-400/35 bg-black/25 px-2 py-1">
          <div className="text-[9px] font-bold uppercase tracking-wider text-[#d4af37] mb-0.5">Adjustments</div>
          <table className="text-[10px] w-full">
            <tbody>
              {item.adjustments.map((a, i) => {
                const num = typeof a.from === "number" && typeof a.to === "number";
                const net = num ? (a.to as number) - (a.from as number) : null;
                return (
                  <tr key={i} className="align-top">
                    <td className="pr-2 text-white font-semibold whitespace-nowrap">{a.what}</td>
                    <td className="pr-2 font-mono whitespace-nowrap text-amber-50">
                      {num ? Math.round(a.from as number) : a.from} → {num ? Math.round(a.to as number) : a.to}
                      {net != null && (
                        <span className={cn("ml-1", net >= 0 ? "text-green-400" : "text-red-400")}>
                          ({net >= 0 ? "+" : ""}{net.toFixed(1)})
                        </span>
                      )}
                    </td>
                    <td className="text-amber-100/85">{a.why}</td>
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
