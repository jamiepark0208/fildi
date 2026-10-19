import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import {
  useModelList,
  VERDICT_COLORS,
  VERDICT_LABELS,
  type ModelListFolder,
  type ModelListHealth,
  type ModelListItem,
} from "@/hooks/use-model-list";
import { useSessionState } from "@/hooks/use-session-state";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ModelThesis } from "@/components/model-thesis-report";

/** Shared Model/My value cols — ch widths so numbers don't ellipsis. */
export const WATCHLIST_ROW =
  "grid grid-cols-[14px_4.5ch_7ch_6ch_5.5ch] items-center gap-x-1 px-1.5 h-[26px] text-[11px] w-max max-w-full";

/** My List only — trailing 14px for always-visible remove X (keeps headers aligned). */
export const WATCHLIST_ROW_MINE =
  "grid grid-cols-[14px_4.5ch_7ch_6ch_5.5ch_14px] items-center gap-x-1 px-1.5 h-[26px] text-[11px] w-max max-w-full";

const DEFAULT_OPEN: Record<string, boolean> = {
  sell_puts: true,
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
  return `${c.strike}${c.type === "put" ? "P" : "C"} ${fmtExpiry(c.expiry)}${win}`;
}

function itemKey(folderKey: string, item: ModelListItem) {
  return `${folderKey}:${item.ticker}:${item.contract?.type ?? ""}:${item.contract?.account ?? ""}`;
}

function ItemRow({
  item,
  selected,
  onSelect,
}: {
  item: ModelListItem;
  selected: boolean;
  onSelect: () => void;
}) {
  const color = VERDICT_COLORS[item.verdict] ?? "";
  const chgPct = item.close != null && item.prevClose ? (item.close / item.prevClose - 1) * 100 : null;
  const stale = item.closeDate != null && Date.now() - new Date(item.closeDate).getTime() > STALE_CLOSE_MS;
  return (
    <div
      onClick={onSelect}
      title={[VERDICT_LABELS[item.verdict], item.contract ? contractShort(item.contract) : "", ...(item.why.slice(0, 2))].filter(Boolean).join(" · ")}
      className={cn(
        WATCHLIST_ROW,
        "cursor-pointer relative group",
        selected ? "bg-[#d4af37]/15" : "hover:bg-[#d4af37]/10",
      )}
    >
      <span className="flex items-center justify-center w-3.5 h-3.5">
        {color ? (
          <span className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
        ) : (
          <span className="w-2 h-2 rounded-full border border-white/30" />
        )}
      </span>
      <span className="font-mono font-bold whitespace-nowrap overflow-hidden" style={{ color: color || "white" }}>
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
      <span className="flex items-center justify-end gap-0.5">
        {item.role === "held" && (
          <span className="text-[8px] px-0.5 rounded bg-[#3b82f6]/25 text-[#93c5fd]">H</span>
        )}
        {item.isNew && (
          <span className="text-[8px] px-0.5 rounded bg-[#d4af37]/25 text-[#d4af37]">n</span>
        )}
        {item.status === "provisional" && (
          <span className="text-[8px] px-0.5 rounded bg-amber-500/20 text-amber-300">p</span>
        )}
        {item.status === "review" && (
          <span className="text-[8px] px-0.5 rounded bg-red-500/20 text-red-300">r</span>
        )}
        {(item.status === "warn" || item.why.some((w) => w.startsWith("⚠"))) && (
          <span className="text-[8px] px-0.5 rounded bg-orange-500/20 text-orange-300">!</span>
        )}
      </span>
    </div>
  );
}

/** Sort-only strategy views over fields the Model List already carries (no new scores). Missing values sort last. */
const LENSES = {
  model: { label: "Model", hint: "Model order (portfolio allocation)", value: (_: ModelListItem) => 0 },
  safe: { label: "Safest", hint: "Highest historical win rate for the contract's delta / expiry", value: (i: ModelListItem) => i.contract?.win?.rate ?? -1 },
  tail: { label: "Least tail", hint: "Smallest bad-year loss per contract", value: (i: ModelListItem) => i.contract?.win?.ev_bad ?? -1e9 },
  value: { label: "Rich options", hint: "Contract IV vs 20-day realized vol: options priced above recent moves (the validated edge)", value: (i: ModelListItem) => i.contract?.vol?.contract_iv_rv ?? -1 },
  wheel: { label: "Wheel", hint: "Best long-term trend (vs 200-day): better to own if assigned", value: (i: ModelListItem) => i.pillars?.ma200 ?? -1 },
} as const;
type LensKey = keyof typeof LENSES;

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
  return (
    <section className="border-b border-[#d4af37]/15">
      <button
        onClick={onToggle}
        title={folder.description}
        className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-bold text-[#d4af37] hover:bg-white/5 sticky top-0 bg-zinc-950/95 backdrop-blur-md z-10"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <span className="truncate">{folder.name}</span>
        <span className="text-amber-200/40 font-normal tabular-nums">{folder.items.length}</span>
        <span className="ml-auto flex gap-1 font-normal shrink-0">
          {added > 0 && <span className="text-[9px] text-green-400">+{added}</span>}
          {folder.removed.length > 0 && (
            <span title={`Dropped: ${folder.removed.join(", ")}`} className="text-[9px] text-red-400">
              −{folder.removed.length}
            </span>
          )}
        </span>
      </button>
      {open && (
        <>
          <div className={cn(WATCHLIST_ROW, "border-b border-[#d4af37]/15 text-[#d4af37] bg-zinc-950/80")}>
            <div />
            <div className="min-w-0 text-[9px] font-bold uppercase tracking-wider">Sym</div>
            <div className="text-right min-w-0 text-[9px] font-bold uppercase tracking-wider">Last</div>
            <div className="text-right min-w-0 text-[9px] font-bold uppercase tracking-wider">Chg%</div>
            <div className="text-right min-w-0 text-[9px] font-bold uppercase tracking-wider">Tag</div>
          </div>
          {hasTrades && (
            <div className="flex items-center gap-1 px-1.5 py-0.5 text-[9px] text-amber-200/50 border-b border-[#d4af37]/10">
              <span>View</span>
              {(Object.keys(LENSES) as LensKey[]).map((k) => (
                <button
                  key={k}
                  title={LENSES[k].hint}
                  onClick={() => setLens(k)}
                  className={cn("px-1 rounded", lens === k ? "bg-[#d4af37]/25 text-[#d4af37]" : "hover:text-amber-200")}
                >
                  {LENSES[k].label}
                </button>
              ))}
            </div>
          )}
          {folder.items.length === 0 ? (
            <div className="px-2 py-2 text-[10px] text-amber-200/40">{folder.description}</div>
          ) : (
            <div className="divide-y divide-[#d4af37]/10">
              {items.map((item) => {
                const key = itemKey(folder.key, item);
                return (
                  <ItemRow
                    key={key}
                    item={item}
                    selected={selectedKey === key}
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

function HealthStrip({ h }: { h: ModelListHealth }) {
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

  const parts: Array<{ label: string; tone: Tone; title: string }> = [
    {
      label: "export",
      tone: exportS.tone,
      title: whyLine(
        exportS.tone,
        `RH portfolio snapshot OK · ${fmtWhen(h.snapshot_at)} (${exportS.lagLabel})`,
        `RH portfolio export stale/missing · last ${fmtWhen(h.snapshot_at)} (${exportS.lagLabel}). Re-run the Robinhood portfolio import.`,
      ),
    },
    {
      label: "quotes",
      tone: quotesTone,
      title: !quotesVerified
        ? `Quotes not verified · plan status is "${h.plan_status ?? "none"}" (need verified). Last ${fmtWhen(h.quotes_at)}.`
        : whyLine(
            quotesS.tone,
            `Quotes OK · ${fmtWhen(h.quotes_at)} (${quotesS.lagLabel})`,
            `Quotes stale · last ${fmtWhen(h.quotes_at)} (${quotesS.lagLabel}). Re-run verify/publish for the plan (Schwab or Robinhood).`,
          ),
    },
    {
      label: "LSEG",
      tone: lsegS.tone,
      title: whyLine(
        lsegS.tone,
        `LSEG OK · signals ${fmtWhen(h.lseg_signals_date)} · history ${fmtWhen(h.lseg_history_date)}`,
        `LSEG stale/stopped · signals ${fmtWhen(h.lseg_signals_date)} · history ${fmtWhen(h.lseg_history_date)} (${lsegS.lagLabel}). Feed may be revoked or nightly LSEG job not writing.`,
      ),
    },
    {
      label: "prices",
      tone: pricesS.tone,
      title: whyLine(
        pricesS.tone,
        `Prices OK · SPY ${fmtWhen(h.prices_date)} · universe ${fmtWhen(h.prices_universe_date)}`,
        `Prices lagging · SPY ${fmtWhen(h.prices_date)} · universe ${fmtWhen(h.prices_universe_date)} (${pricesS.lagLabel}). Check price refresh / Yahoo fallback.`,
      ),
    },
    {
      // Count of your graded Model List outcomes (win/loss feedback). Grey = none yet, not stale.
      label: grades > 0 ? `g${grades}` : "grades",
      tone: gradesS.tone,
      title:
        grades > 0
          ? whyLine(
              gradesS.tone,
              `${grades} graded pick${grades === 1 ? "" : "s"} · last ${fmtWhen(h.last_graded_at)} (${gradesS.lagLabel})`,
              `Grades stale · last ${fmtWhen(h.last_graded_at)} (${gradesS.lagLabel}).`,
            )
          : "grades = your scored Model List picks (win/loss). 0 so far — grey means none yet, not a failure. Grade a pick from the list to start the learning loop.",
    },
  ];
  const cal = h.calibration;
  if (cal && cal.n > 0) {
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    // A74: first forecast per pick, split by expiry week (1st = this week's expiry, 2nd = next week's after the roll).
    const weeks = cal.byWeek?.length ? cal.byWeek : [{ week: 1 as const, ...cal }];
    for (const w of weeks) {
      const gap = Math.abs(w.pred - w.real);
      parts.push({
        label: `cal ${cal.byWeek?.length ? `wk${w.week} ` : ""}${pct(w.pred)}→${pct(w.real)}`,
        tone: w.n < 20 ? "idle" : gap <= 0.05 ? "ok" : gap <= 0.12 ? "warn" : "bad",
        title: `Model List P(OTM) calibration (A74), ${w.week === 1 ? "1st-week" : "2nd-week"} expiry: predicted ${pct(w.pred)} → happened ${pct(w.real)} on ${w.n} resolved pick${w.n === 1 ? "" : "s"}. Uses the P(OTM) shown when each pick was first recommended. Grey = under 20 samples; green = within 5 pts.`,
      });
    }
  }
  const champTip = `Champion model ${h.champion ?? "?"}${h.challengers ? ` · ${h.challengers} challenger(s)` : ""}`;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {parts.map((p) => (
        <Tooltip key={p.label} delayDuration={150}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-0.5 rounded-sm hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/40"
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
      <Tooltip delayDuration={150}>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="rounded-sm text-amber-200/40 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#d4af37]/40"
          >
            m{h.champion ?? "?"}
            {h.challengers ? `+${h.challengers}` : ""}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          className="max-w-[280px] bg-zinc-900 text-zinc-100 border border-[#d4af37]/30 text-[11px] leading-snug font-normal normal-case tracking-normal"
        >
          {champTip}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

const KIND_ORDER: Array<ModelListFolder["kind"]> = ["action", "verdict", "review"];
const KIND_LABEL: Record<ModelListFolder["kind"], string> = {
  action: "Action folders",
  verdict: "Verdict folders",
  review: "Review",
};

/** Watchlist → Model List: folder tables matching My List density. */
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

  const byKind = KIND_ORDER.map((kind) => ({
    kind,
    folders: data.folders.filter((f) => f.kind === kind),
  })).filter((g) => g.folders.length > 0);

  return (
    <div className="flex-1 overflow-y-auto flex flex-col min-h-0" data-lenis-prevent>
      {data.health ? (
        <div className="px-2 py-1 border-b border-[#d4af37]/20 text-[9px] text-amber-200/50 leading-snug shrink-0">
          <HealthStrip h={data.health} />
        </div>
      ) : null}
      {byKind.map(({ kind, folders }) => (
        <div key={kind}>
          <div className="px-2 py-0.5 text-[8px] uppercase tracking-[0.12em] text-zinc-600 bg-zinc-900/80 border-b border-zinc-800/60 sticky top-0 z-[11]">
            {KIND_LABEL[kind]}
          </div>
          {folders.map((f) => (
            <FolderTable
              key={f.key}
              folder={f}
              open={openMap[f.key] ?? false}
              onToggle={() => setOpenMap({ ...openMap, [f.key]: !(openMap[f.key] ?? false) })}
              selectedKey={selectedKey}
              onSelect={onSelectThesis}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

export function modelThesisSelectionKey(thesis: ModelThesis): string {
  return itemKey(thesis.folderKey, thesis.item);
}
