import { type ReactNode } from "react";
import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  useModelList,
  VERDICT_CHIPS,
  VERDICT_LABELS,
  type ModelListFolder,
  type ModelListHealth,
  type ModelListItem,
} from "@/hooks/use-model-list";
import { useSessionState } from "@/hooks/use-session-state";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModelThesis } from "@/components/model-thesis-report";
import { HouseViewWarnings } from "@/components/live/house-view-card";
import { PutBandSelector } from "@/components/put-band-selector";
import { bookGroupChip, engineAwareness, newsChip } from "@/lib/model-list-awareness";
import {
  strategyMeta,
  useActivePanicPutBadges,
  useActiveShadowStrategyBadges,
  type StrategySignal,
  type StrategySignalsLive,
} from "@/hooks/use-strategy-signals";

/** Shared Model value cols — VIEW chip + SCR/RANK (universe put score or section confidence). */
export const WATCHLIST_ROW =
  "grid grid-cols-[3ch_4.5ch_7ch_5.5ch_4ch_4.5ch_8ch] items-center gap-x-1 px-1.5 h-[26px] text-[11px] w-max max-w-full";

/** My List only — trailing 14px for always-visible remove X (keeps headers aligned). */
export const WATCHLIST_ROW_MINE =
  "grid grid-cols-[14px_minmax(4.5ch,1fr)_minmax(5ch,1.1fr)_minmax(4.5ch,1fr)_minmax(4.5ch,1fr)_14px] items-center gap-x-1.5 px-1.5 h-[26px] text-[11px] w-full";

/** Per-folder metric column labels (SCR = put universe score; CONF/URG = section-native). */
const FOLDER_METRIC: Record<string, { score: string; rank: string; tip: string; invert?: boolean }> = {
  sell_puts: {
    score: "SCR",
    rank: "RANK",
    tip: "Universe sell-put option score / rank — same board as Rankings › Options. Green = stronger.",
  },
  sell_calls: {
    score: "CONF",
    rank: "RANK",
    tip: "Setup confidence (status · hist win · pillars) — not call option score (S061). Green = cleaner setup.",
  },
  trim_risk: {
    score: "CONF",
    rank: "RANK",
    tip: "Trim confidence from flag severity (stronger case = higher). Green = stronger trim case.",
  },
  manage: {
    score: "URG",
    rank: "RANK",
    tip: "Action urgency (ITM › at risk › fund › expiry). Red = act sooner — not trade quality.",
    invert: true,
  },
};

/** Red / yellow / green for score (0–100) or rank (1 = best). Urgency inverts (high = red). */
function metricTone(
  raw: string,
  kind: "score" | "rank",
  opts: { invert?: boolean; universeN?: number | null; folderSize?: number } = {},
): string {
  if (raw === "—" || raw === "") return "text-white/35";
  const n = Number(raw);
  if (!Number.isFinite(n)) return "text-white/35";
  let good: number; // 0..1 higher = better for green
  if (kind === "score") {
    good = Math.max(0, Math.min(1, n / 100));
    if (opts.invert) good = 1 - good;
  } else {
    const denom = Math.max(2, opts.universeN ?? opts.folderSize ?? 20);
    good = 1 - (n - 1) / (denom - 1);
    good = Math.max(0, Math.min(1, good));
    if (opts.invert) good = 1 - good;
  }
  if (good >= 0.66) return "text-emerald-400";
  if (good >= 0.33) return "text-amber-300";
  return "text-red-400";
}

const DEFAULT_OPEN: Record<string, boolean> = {
  sell_puts: true,
  rich_puts: true, // 11-09: the S109 lane is where the ≥ 0.9 %/wk puts are — collapsed, the list looked empty
  sell_calls: true,
  trim_risk: true,
  manage: true,
  review: true,
};
const STALE_CLOSE_MS = 5 * 24 * 3600 * 1000;

function fmtExpiry(iso: string) {
  const [, m, d] = iso.split("-");
  return `${Number(m)}/${Number(d)}`;
}

function contractShort(c: NonNullable<ModelListItem["contract"]>) {
  const win = c.win ? ` (wins ${c.win.outside || c.win.extrapolated ? "≈" : ""}${Math.round(c.win.rate * 100)}% hist.)` : "";
  const wall = c.wall ? ` · IV ${c.wall.kind} $${c.wall.level.toFixed(2)}` : "";
  return `${c.strike}${c.type === "put" ? "P" : "C"} ${fmtExpiry(c.expiry)}${win}${wall}`;
}

function itemKey(folderKey: string, item: ModelListItem) {
  return `${folderKey}:${item.ticker}:${item.contract?.type ?? ""}:${item.contract?.account ?? ""}`;
}

function metricFor(folderKey: string, item: ModelListItem, folderSize: number): {
  score: string;
  rank: string;
  tip: string | undefined;
  scoreClass: string;
  rankClass: string;
} {
  const meta = FOLDER_METRIC[folderKey];
  const invert = meta?.invert;
  if (folderKey === "sell_puts") {
    const scr =
      item.universeScore != null
        ? String(Math.round(item.universeScore))
        : item.score != null
          ? String(Math.round(item.score))
          : "—";
    const rk = item.universeRank != null ? String(item.universeRank) : "—";
    const tip =
      item.universeRank != null && item.universeN
        ? `Universe put score ${item.universeScore ?? "—"} · rank ${item.universeRank} of ${item.universeN}`
        : item.score != null
          ? `Option score ${Math.round(item.score)} (no universe rank)`
          : undefined;
    return {
      score: scr,
      rank: rk,
      tip,
      scoreClass: metricTone(scr, "score"),
      rankClass: metricTone(rk, "rank", { universeN: item.universeN }),
    };
  }
  const c = item.confidence;
  if (c) {
    const scr = String(Math.round(c.score));
    const rk = String(c.rank);
    return {
      score: scr,
      rank: rk,
      tip: c.basis,
      scoreClass: metricTone(scr, "score", { invert }),
      rankClass: metricTone(rk, "rank", { invert, folderSize }),
    };
  }
  return { score: "—", rank: "—", tip: undefined, scoreClass: "text-white/35", rankClass: "text-white/35" };
}

function ItemRow({
  item,
  folderKey,
  folderSize,
  selected,
  onSelect,
  shadowSignals,
  panicSignal,
  panicLive,
}: {
  item: ModelListItem;
  folderKey: string;
  folderSize: number;
  selected: boolean;
  onSelect: () => void;
  shadowSignals?: StrategySignal[];
  /** S054 panic + hi-IV put signal open on this name (last 3 sessions). */
  panicSignal?: StrategySignal;
  panicLive?: StrategySignalsLive;
}) {
  const view = VERDICT_CHIPS[item.verdict] ?? VERDICT_CHIPS[""]!;
  const chgPct = item.close != null && item.prevClose ? (item.close / item.prevClose - 1) * 100 : null;
  const stale = item.closeDate != null && Date.now() - new Date(item.closeDate).getTime() > STALE_CLOSE_MS;
  const repriceNote = (item.adjustments ?? [])
    .map((a) => (typeof a.why === "string" && /re-struck|repriced|Δ/i.test(a.why) ? a.why : null))
    .find(Boolean)
    ?? (item.why ?? []).find((w) => /re-struck|repriced/i.test(w));
  const otmTip = item.odds?.p_otm?.value != null ? `P(OTM) ${Math.round(item.odds.p_otm.value * 100)}%` : null;
  const metric = metricFor(folderKey, item, folderSize);
  const callScoreTip =
    folderKey === "sell_calls" && item.score != null
      ? `call tech score ${Math.round(item.score)} — not used as edge`
      : null;
  const bandWhy = (item.why ?? []).find((w) => /your (setting|fixed band)/i.test(w));
  const putAware =
    folderKey === "sell_puts"
      ? (() => {
          const a = engineAwareness(item.contract);
          return { group: bookGroupChip(a.book_group), news: newsChip(a.news) };
        })()
      : null;
  return (
    <div
      onClick={onSelect}
      title={[VERDICT_LABELS[item.verdict] ?? VERDICT_LABELS[""], item.contract ? contractShort(item.contract) : "", otmTip, callScoreTip, repriceNote, bandWhy, ...(item.why.slice(0, 2))].filter(Boolean).join(" · ")}
      className={cn(
        WATCHLIST_ROW,
        "cursor-pointer relative group",
        selected ? "bg-[#d4af37]/15" : "hover:bg-[#d4af37]/10",
      )}
    >
      <Tooltip delayDuration={200}>
        <TooltipTrigger asChild>
          <span className={cn("text-[8px] font-bold px-0.5 rounded leading-none cursor-help tabular-nums", view.className)}>
            {view.code}
          </span>
        </TooltipTrigger>
        <TooltipContent side="right" className="max-w-[280px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
          {VERDICT_LABELS[item.verdict] ?? VERDICT_LABELS[""]}
          {" — Fildi Model view (not your My List color tags)."}
        </TooltipContent>
      </Tooltip>
      <span className="font-mono font-bold whitespace-nowrap overflow-hidden text-white">
        {item.ticker}
      </span>
      <span
        className={cn("text-right font-mono tabular-nums whitespace-nowrap", stale ? "text-amber-200/40 line-through" : "text-white")}
        title={stale ? `Stale close ${String(item.closeDate).slice(0, 10)}` : undefined}
      >
        {item.close != null ? item.close.toFixed(2) : "—"}
      </span>
      <span
        className={cn(
          "text-right font-mono tabular-nums whitespace-nowrap",
          chgPct == null ? "text-amber-200/40" : chgPct >= 0 ? "text-green-500" : "text-red-500",
        )}
      >
        {chgPct == null ? "—" : `${chgPct >= 0 ? "+" : ""}${chgPct.toFixed(1)}%`}
      </span>
      <span
        className={cn("text-right font-mono tabular-nums whitespace-nowrap font-semibold", metric.scoreClass)}
        title={metric.tip}
      >
        {metric.score}
      </span>
      <span
        className={cn("text-right font-mono tabular-nums whitespace-nowrap font-semibold", metric.rankClass)}
        title={metric.tip}
      >
        {metric.rank}
      </span>
      <span className="flex flex-wrap items-center justify-end gap-0.5 max-w-[11rem] leading-tight">
        {item.role === "held" && (
          <TagChip code="H" className="bg-[#3b82f6]/25 text-[#93c5fd]">H</TagChip>
        )}
        {item.isNew && (
          <TagChip code="n" className="bg-[#d4af37]/25 text-[#d4af37]">n</TagChip>
        )}
        {item.status === "provisional" && (
          <TagChip code="p" className="bg-amber-500/20 text-amber-300">p</TagChip>
        )}
        {item.status === "unfunded" && (
          <TagChip code="$" className="bg-sky-500/20 text-sky-300">$</TagChip>
        )}
        {item.status === "review" && (
          <TagChip code="r" className="bg-red-500/20 text-red-300">r</TagChip>
        )}
        {(item.status === "warn" || item.why.some((w) => w.startsWith("⚠"))) && (
          <TagChip code="!" className="bg-orange-500/20 text-orange-300">!</TagChip>
        )}
        {item.news && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[8px] px-0.5 rounded bg-emerald-500/20 text-emerald-300 cursor-help">news</span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              {item.news.titles.length
                ? item.news.titles.join(" · ")
                : item.news.role === "peer"
                  ? `peer of ${item.news.ofTicker}`
                  : "news shortlist"}
            </TooltipContent>
          </Tooltip>
        )}
        {putAware?.group ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[7px] px-0.5 rounded bg-zinc-500/25 text-zinc-200 cursor-help max-w-[5.5rem] truncate">
                {putAware.group.label}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs whitespace-pre-wrap">{putAware.group.tip}</TooltipContent>
          </Tooltip>
        ) : null}
        {putAware?.news ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[7px] px-0.5 rounded bg-zinc-500/25 text-zinc-200 cursor-help max-w-[5.5rem] truncate">
                {putAware.news.label}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs whitespace-pre-wrap">{putAware.news.tip}</TooltipContent>
          </Tooltip>
        ) : null}
        {panicSignal ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[7px] px-0.5 rounded bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/40 cursor-help">
                panic
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs whitespace-pre-wrap">
              {[
                `S054 panic put firing ${panicSignal.asOf}: ${panicSignal.trigger}`,
                panicSignal.strike != null && panicSignal.expiry
                  ? `Signal contract P${panicSignal.strike} ${panicSignal.expiry}${panicSignal.entryMid != null ? ` @${panicSignal.entryMid.toFixed(2)}` : ""}`
                  : "Not priced yet",
                "Backtest: premium kept +4.05 % vs +0.26 % (2025: +3.15 vs +1.63 %)",
                panicLive?.graded
                  ? `Live: n ${panicLive.graded}, hit ${panicLive.hitRate != null ? `${Math.round(panicLive.hitRate * 100)} %` : "—"}`
                  : "Live: no graded signals yet",
              ].join("\n")}
            </TooltipContent>
          </Tooltip>
        ) : null}
        {shadowSignals?.length ? (
          // 11-09: one chip per row (N rules) — one chip per strategy overflowed the narrow panel; tooltip lists each
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-[7px] px-0.5 rounded bg-fuchsia-500/20 text-fuchsia-200 border border-fuchsia-400/40 cursor-help">
                {shadowSignals.length === 1 ? strategyMeta(shadowSignals[0]).label : `${shadowSignals.length} rules`}
              </span>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs whitespace-pre-wrap">
              {shadowSignals.map((s) => `${strategyMeta(s).label} ${s.asOf}: ${strategyMeta(s).tip}`).join("\n\n")}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </span>
    </div>
  );
}

/** Sort-only lenses (fields already on the item). Compact `<select>` in folder header — no View row. */
const LENSES = {
  model: { label: "Model order", hint: "Default portfolio allocation order", value: (_: ModelListItem) => 0 },
  safe: { label: "Safest", hint: "Highest historical win rate for delta / expiry", value: (i: ModelListItem) => i.contract?.win?.rate ?? -1 },
  tail: { label: "Least tail", hint: "Smallest bad-year loss per contract", value: (i: ModelListItem) => i.contract?.win?.ev_bad ?? -1e9 },
  value: { label: "Rich options", hint: "Contract IV ÷ 20d realized — options priced above recent moves", value: (i: ModelListItem) => i.contract?.vol?.contract_iv_rv ?? -1 },
  wheel: { label: "Wheel", hint: "Best vs 200-day trend — better to own if assigned", value: (i: ModelListItem) => i.pillars?.ma200 ?? -1 },
} as const;
type LensKey = keyof typeof LENSES;

/** Structures-tab style: solid folder chrome + white label (never gold-on-gold). */
const FOLDER_CHROME: Record<string, string> = {
  sell_puts: "bg-emerald-700 hover:bg-emerald-600 border-y border-emerald-500",
  sell_calls: "bg-red-800 hover:bg-red-700 border-y border-red-500",
  trim_risk: "bg-orange-700 hover:bg-orange-600 border-y border-orange-500",
  manage: "bg-violet-700 hover:bg-violet-600 border-y border-violet-400",
  review: "bg-zinc-700 hover:bg-zinc-600 border-y border-zinc-500",
};
const folderChrome = (key: string) => FOLDER_CHROME[key] ?? "bg-zinc-800 hover:bg-zinc-700 border-y border-zinc-600";

const TAG_TIP: Record<string, string> = {
  H: "In your Robinhood book (shares / related) — book fact, not a Model verdict. Model view is the OWN/INC/AVD/ETF/WCH chip on the left.",
  n: "New — not on yesterday's published Model List.",
  p: "Provisional — passed after-hours / soft quote path; treat size carefully.",
  $: "Unfunded — checks passed; blocked only by cash / collateral.",
  r: "Review — held back by portfolio rules (e.g. call strike below avg cost).",
  "!": "Warn — live check flagged something (wide spread, thin OI, etc.). See thesis why.",
};

function TagChip({ code, children, className }: { code: string; children: ReactNode; className?: string }) {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <span className={cn("text-[8px] px-0.5 rounded cursor-help", className)}>{children}</span>
      </TooltipTrigger>
      <TooltipContent side="left" className="max-w-[240px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
        {TAG_TIP[code] ?? code}
      </TooltipContent>
    </Tooltip>
  );
}

function FolderTable({
  folder,
  open,
  onToggle,
  selectedKey,
  onSelect,
}: {
  folder: ModelListFolder;
  open: boolean;
  onToggle: () => void;
  selectedKey: string | null;
  onSelect: (thesis: ModelThesis) => void;
}) {
  const added = folder.items.filter((i) => i.isNew).length;
  const hasTrades = folder.items.some((i) => i.contract?.win);
  const [lens, setLens] = useSessionState<LensKey>(`fildi_model_lens_${folder.key}`, "model");
  const items = hasTrades && lens !== "model" ? [...folder.items].sort((a, b) => LENSES[lens].value(b) - LENSES[lens].value(a)) : folder.items;
  const { byTicker: shadowByTicker } = useActiveShadowStrategyBadges(3);
  const showShadow = folder.key === "sell_puts" || folder.key === "rich_puts"; // 11-09: every strategy chip on both put lanes
  const { byTicker: panicByTicker, data: panicData } = useActivePanicPutBadges(3);
  const showPanic = folder.key === "sell_puts" || folder.key === "rich_puts";
  const emptyHint =
    folder.key === "sell_calls"
      ? `${folder.description} Different from Rankings › Structures covered-call study rows (S076 fail / research board) — Model List only shows calls on free shares that passed L1+L2 live checks.`
      : folder.description;
  return (
    <section className="border-b border-[#d4af37]/20">
      <button
        type="button"
        onClick={onToggle}
        title={folder.description}
        className={cn(
          "w-full flex items-center gap-1.5 px-2 py-1 text-[10px] font-bold text-white sticky top-0 z-10",
          folderChrome(folder.key),
        )}
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <span className="truncate uppercase tracking-wide">{folder.name}</span>
        <span className="text-white/90 font-semibold tabular-nums">{folder.items.length}</span>
        <span className="ml-auto flex items-center gap-1.5 font-normal shrink-0">
          {hasTrades && open ? (
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <select
                  value={lens}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => { e.stopPropagation(); setLens(e.target.value as LensKey); }}
                  className="max-w-[7.5rem] truncate rounded border border-white/25 bg-black/30 px-1 py-0.5 text-[9px] text-white"
                  aria-label="Sort view"
                >
                  {(Object.keys(LENSES) as LensKey[]).map((k) => (
                    <option key={k} value={k}>{LENSES[k].label}</option>
                  ))}
                </select>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[260px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
                {LENSES[lens].hint}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {added > 0 && <span className="text-[9px] text-emerald-200">+{added}</span>}
          {folder.removed.length > 0 && (
            <span title={`Dropped: ${folder.removed.join(", ")}`} className="text-[9px] text-red-200">
              −{folder.removed.length}
            </span>
          )}
        </span>
      </button>
      {open && folder.key === "sell_puts" ? (
        <PutBandSelector className="border-b border-[#d4af37]/15 shrink-0" />
      ) : null}
      {open && (
        <>
          <div className={cn(WATCHLIST_ROW, "border-b border-[#d4af37]/25 text-[#d4af37] bg-black")}>
            <div className="min-w-0 text-[9px] font-bold uppercase tracking-wider">
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild><span className="cursor-help">Vw</span></TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[300px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
                  Model view (Fildi fit): OWN · INC · AVD · ETF · WCH. Not your My List color tags. Graded → learn.py propose → shadow → approve.
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="min-w-0 text-[9px] font-bold uppercase tracking-wider">Sym</div>
            <div className="text-right min-w-0 text-[9px] font-bold uppercase tracking-wider">Last</div>
            <div className="text-right min-w-0 text-[9px] font-bold uppercase tracking-wider">Chg%</div>
            {(() => {
              const m = FOLDER_METRIC[folder.key] ?? { score: "SCR", rank: "RANK", tip: "Relative score / rank for this folder. Green better (except URG: red = more urgent)." };
              return (
                <>
                  <div className="text-right min-w-0 text-[9px] font-bold uppercase tracking-wider">
                    <Tooltip delayDuration={200}>
                      <TooltipTrigger asChild><span className="cursor-help">{m.score}</span></TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[280px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
                        {m.tip}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="text-right min-w-0 text-[9px] font-bold uppercase tracking-wider">
                    <Tooltip delayDuration={200}>
                      <TooltipTrigger asChild><span className="cursor-help">{m.rank}</span></TooltipTrigger>
                      <TooltipContent side="bottom" className="max-w-[280px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
                        {m.tip}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </>
              );
            })()}
            <div className="text-right min-w-0 text-[9px] font-bold uppercase tracking-wider">
              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild><span className="cursor-help">Tag</span></TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[280px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px]">
                  Book / list flags only: H in book · n new · p provisional · $ unfunded · r review · ! warn. Model judgment = Vw chip (OWN/INC/AVD/…).
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          {folder.items.length === 0 ? (
            <div className="px-2 py-2 text-[10px] text-amber-100 leading-snug">{emptyHint}</div>
          ) : (
            <div className="divide-y divide-[#d4af37]/10 bg-zinc-950">
              {items.map((item) => {
                const key = itemKey(folder.key, item);
                return (
                  <ItemRow
                    key={key}
                    item={item}
                    folderKey={folder.key}
                    folderSize={folder.items.length}
                    selected={selectedKey === key}
                    shadowSignals={showShadow ? shadowByTicker.get(item.ticker.toUpperCase()) : undefined}
                    panicSignal={showPanic && item.contract?.type !== "call" ? panicByTicker.get(item.ticker.toUpperCase()) : undefined}
                    panicLive={panicData?.live}
                    onSelect={() =>
                      onSelect({
                        folderKey: folder.key,
                        folderName: folder.name,
                        folderDescription: folder.description,
                        item,
                      })
                    }
                  />
                );
              })}
            </div>
          )}
        </>
      )}
    </section>
  );
}

const DAY_MS = 24 * 3600 * 1000;

function etYmd(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function etTradingDaysBehind(fromYmd: string, toYmd = etYmd()): number {
  const [fy, fm, fd] = fromYmd.slice(0, 10).split("-").map(Number);
  const [ty, tm, td] = toYmd.slice(0, 10).split("-").map(Number);
  const cur = new Date(Date.UTC(fy!, fm! - 1, fd!));
  const end = new Date(Date.UTC(ty!, tm! - 1, td!));
  if (cur >= end) return 0;
  let n = 0;
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur <= end) {
    const dow = cur.getUTCDay();
    if (dow !== 0 && dow !== 6) n++;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return n;
}

type Tone = "ok" | "warn" | "bad" | "idle";

function ageStatus(
  ts: string | null | undefined,
  mode: "clock" | "trading" = "clock",
): { tone: Tone; lagLabel: string } {
  if (!ts) return { tone: "bad", lagLabel: "never" };
  if (mode === "trading") {
    const lag = etTradingDaysBehind(String(ts).slice(0, 10));
    const lagLabel = lag === 0 ? "today" : `${lag} trading day${lag === 1 ? "" : "s"} behind`;
    return { tone: lag <= 1 ? "ok" : lag <= 3 ? "warn" : "bad", lagLabel };
  }
  const days = (Date.now() - new Date(ts).getTime()) / DAY_MS;
  const lagLabel =
    days < 1 / 24
      ? "just now"
      : days < 1
        ? `${Math.round(days * 24)}h ago`
        : `${days.toFixed(1)}d ago`;
  return { tone: days <= 1.5 ? "ok" : days <= 3.5 ? "warn" : "bad", lagLabel };
}

const TONE_DOT: Record<Tone, string> = {
  ok: "bg-green-500",
  warn: "bg-amber-400",
  bad: "bg-red-500",
  idle: "bg-white/30",
};

function fmtWhen(ts: string | null | undefined): string {
  if (!ts) return "never";
  const d = new Date(ts);
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(ts).slice(0, 10)) && String(ts).length <= 10) {
    const [y, m, day] = String(ts).slice(0, 10).split("-");
    return `${Number(m)}/${Number(day)}/${y}`;
  }
  return d.toLocaleString([], {
    month: "numeric",
    day: "numeric",
    ...(String(ts).length > 10 ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

function whyLine(tone: Tone, whenOk: string, whenBad: string): string {
  if (tone === "ok") return whenOk;
  return whenBad;
}

function HealthStrip({
  h,
  listUpdatedAt,
}: {
  h: ModelListHealth;
  /** model_runs.created_at — when folders/actions were last published */
  listUpdatedAt?: string | null;
}) {
  const priceAsOf =
    [h.prices_date, h.prices_universe_date]
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;

  const exportS = ageStatus(h.snapshot_at, "clock");
  const quotesVerified = h.plan_status === "verified";
  const quotesS = ageStatus(h.quotes_at, "clock");
  const quotesTone: Tone = !quotesVerified ? "bad" : quotesS.tone;
  const lsegAsOf = h.lseg_signals_date ?? h.lseg_history_date;
  const lsegS = ageStatus(lsegAsOf, "trading");
  const pricesS = ageStatus(priceAsOf, "trading");
  const grades = h.grades ?? 0;
  const gradesS = grades > 0 ? ageStatus(h.last_graded_at, "clock") : { tone: "idle" as Tone, lagLabel: "" };
  const listS = ageStatus(listUpdatedAt, "clock");

  const champ = h.champion ?? "?";
  const listTip = [
    `Published ${fmtWhen(listUpdatedAt)} (${listS.lagLabel}).`,
    `Model ${champ}${h.challengers ? ` +${h.challengers} challenger(s)` : ""}.`,
    "Folders refresh after RH export → daily/publish. Stale = re-run watchlist_sync publish.",
  ].join(" ");

  const parts: Array<{ label: string; tone: Tone; title: string }> = [
    {
      label: "List",
      tone: listS.tone,
      title: listTip,
    },
    {
      label: "RH",
      tone: exportS.tone,
      title: whyLine(
        exportS.tone,
        `Robinhood book OK · ${fmtWhen(h.snapshot_at)} (${exportS.lagLabel}). Drives Open Positions + held tags.`,
        `Robinhood book stale · last ${fmtWhen(h.snapshot_at)} (${exportS.lagLabel}). Re-run RH portfolio export.`,
      ),
    },
    {
      label: "Quotes",
      tone: quotesTone,
      title: !quotesVerified
        ? `Quotes not verified · plan status "${h.plan_status ?? "none"}" (need verified). Last ${fmtWhen(h.quotes_at)}.`
        : whyLine(
            quotesS.tone,
            `Quotes OK · ${fmtWhen(h.quotes_at)} (${quotesS.lagLabel})`,
            `Quotes stale · last ${fmtWhen(h.quotes_at)} (${quotesS.lagLabel}). Re-run plan verify/publish.`,
          ),
    },
    {
      label: "LSEG",
      tone: lsegS.tone,
      title: whyLine(
        lsegS.tone,
        `LSEG OK · signals ${fmtWhen(h.lseg_signals_date)} · history ${fmtWhen(h.lseg_history_date)}`,
        `LSEG stale · signals ${fmtWhen(h.lseg_signals_date)} · history ${fmtWhen(h.lseg_history_date)} (${lsegS.lagLabel}).`,
      ),
    },
    {
      label: "Prices",
      tone: pricesS.tone,
      title: whyLine(
        pricesS.tone,
        `Prices OK · SPY ${fmtWhen(h.prices_date)} · universe ${fmtWhen(h.prices_universe_date)}`,
        `Prices lagging · SPY ${fmtWhen(h.prices_date)} · universe ${fmtWhen(h.prices_universe_date)} (${pricesS.lagLabel}).`,
      ),
    },
    {
      label: "Grades",
      tone: gradesS.tone,
      title:
        grades > 0
          ? whyLine(
              gradesS.tone,
              `${grades} graded picks (win/loss) · last ${fmtWhen(h.last_graded_at)} (${gradesS.lagLabel}). Not open positions.`,
              `Grades stale · ${grades} total · last ${fmtWhen(h.last_graded_at)} (${gradesS.lagLabel}).`,
            )
          : "No graded Model List outcomes yet — grey is empty, not a failure.",
    },
  ];
  const cal = h.calibration;
  if (cal && cal.n > 0) {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    const weeks = cal.byWeek?.length ? cal.byWeek : [{ week: 1 as const, ...cal }];
    for (const w of weeks) {
      const gap = Math.abs(w.pred - w.real);
      parts.push({
        label: "Cal",
        tone: w.n < 20 ? "idle" : gap <= 0.05 ? "ok" : gap <= 0.12 ? "warn" : "bad",
        title: `P(OTM) cal${cal.byWeek?.length ? ` wk${w.week}` : ""}: predicted ${pct(w.pred)} → happened ${pct(w.real)} on ${w.n} picks. Grey < 20 samples; green within 5 pts.`,
      });
    }
  }

  // Learning loop: grade → daily reflection → learn.py propose (idempotent) → shadow score → approve promote.
  const chall = h.challengers ?? 0;
  const learnS = ageStatus(h.learn_proposed_at ?? h.learn_promoted_at ?? h.last_graded_at, "clock");
  const learnTone: Tone =
    grades === 0 ? "idle"
      : chall > 0 ? "warn"
      : learnS.tone === "bad" ? "warn"
      : "ok";
  parts.push({
    label: "Learn",
    tone: learnTone,
    title: [
      `Champion ${champ}${chall ? ` · ${chall} challenger(s) waiting approval` : " · no open challenger"}.`,
      `Promoted ${fmtWhen(h.learn_promoted_at)} · last propose ${fmtWhen(h.learn_proposed_at)}.`,
      "Cycle: grade_ledger → daily_reflection → learn propose (only if evidence moved) → shadow fit → promote --approve.",
      "Data bugs never retune weights. Verdict chips (OWN/INC/AVD) come from champion fit — Model's tags, not My List.",
    ].join(" "),
  });

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {parts.map((p) => (
        <Tooltip key={`${p.label}-${p.title.slice(0, 24)}`} delayDuration={150}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-0.5 rounded-sm hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/40",
                p.tone === "bad" ? "text-red-300/90" : p.tone === "warn" ? "text-amber-300/90" : "text-amber-100/70",
              )}
            >
              <span className={cn("w-1.5 h-1.5 rounded-full", TONE_DOT[p.tone])} />
              {p.label}
            </button>
          </TooltipTrigger>
          <TooltipContent
            side="bottom"
            className="max-w-[280px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug font-normal normal-case tracking-normal"
          >
            {p.title}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

const KIND_ORDER: Array<ModelListFolder["kind"]> = ["action", "verdict", "review"];

/** Watchlist → Model List: folder chrome matches Rankings › Structures themes (no ACTION FOLDERS labels). */
export function ModelListPanel({
  onSelectThesis,
  selectedKey,
}: {
  onSelectThesis: (thesis: ModelThesis) => void;
  selectedKey: string | null;
}) {
  const { data, isLoading, isError } = useModelList();
  const [openMap, setOpenMap] = useSessionState<Record<string, boolean>>("fildi_model_list_open", DEFAULT_OPEN);

  if (isLoading) {
    return (
      <div className="p-6 flex justify-center">
        <Loader2 className="w-4 h-4 animate-spin text-amber-200/40" />
      </div>
    );
  }
  if (isError) {
    return <div className="p-6 text-center text-xs text-red-400">Couldn't load the Model List.</div>;
  }
  if (!data?.run) {
    return (
      <div className="p-6 text-center text-xs text-amber-200/40">
        No model run published yet (scripts/watchlist_sync/publish_model_list.py).
      </div>
    );
  }

  const folders = KIND_ORDER.flatMap((kind) => data.folders.filter((f) => f.kind === kind));

  return (
    <div className="flex-1 overflow-y-auto flex flex-col min-h-0" data-lenis-prevent>
      {data.health ? (
        <div className="px-2 py-1.5 border-b border-[#d4af37]/20 text-[9px] text-amber-200/50 leading-snug shrink-0">
          <HealthStrip h={data.health} listUpdatedAt={data.run?.createdAt} />
        </div>
      ) : null}
      <HouseViewWarnings className="px-2 py-1.5 border-b border-red-500/20 space-y-1 shrink-0" />
      {folders.map((f) => (
        <FolderTable
          key={f.key}
          folder={f}
          open={openMap[f.key] ?? DEFAULT_OPEN[f.key] ?? false}
          onToggle={() => setOpenMap({ ...openMap, [f.key]: !(openMap[f.key] ?? DEFAULT_OPEN[f.key] ?? false) })}
          selectedKey={selectedKey}
          onSelect={onSelectThesis}
        />
      ))}
    </div>
  );
}

export function modelThesisSelectionKey(thesis: ModelThesis): string {
  return itemKey(thesis.folderKey, thesis.item);
}
