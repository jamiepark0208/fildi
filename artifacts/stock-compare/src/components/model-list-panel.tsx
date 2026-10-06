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

function ageTone(ts: string | null | undefined, mode: "clock" | "trading" = "clock"): string {
  if (!ts) return "bg-red-500";
  if (mode === "trading") {
    const lag = etTradingDaysBehind(String(ts).slice(0, 10));
    return lag <= 1 ? "bg-green-500" : lag <= 3 ? "bg-amber-400" : "bg-red-500";
  }
  const days = (Date.now() - new Date(ts).getTime()) / DAY_MS;
  return days <= 1.5 ? "bg-green-500" : days <= 3.5 ? "bg-amber-400" : "bg-red-500";
}

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

function HealthStrip({ h }: { h: ModelListHealth }) {
  const priceAsOf =
    [h.prices_date, h.prices_universe_date]
      .filter((x): x is string => !!x)
      .sort()
      .at(-1) ?? null;
  const parts: Array<{ label: string; tone: string; title: string }> = [
    { label: "export", tone: ageTone(h.snapshot_at, "clock"), title: `Robinhood snapshot: ${fmtWhen(h.snapshot_at)}` },
    {
      label: "quotes",
      tone: h.plan_status === "verified" ? ageTone(h.quotes_at, "clock") : "bg-red-500",
      title: `Quote check: ${h.plan_status ?? "no plan"} · ${fmtWhen(h.quotes_at)}`,
    },
    {
      label: "LSEG",
      tone: ageTone(h.lseg_signals_date ?? h.lseg_history_date, "trading"),
      title: `LSEG signals ${fmtWhen(h.lseg_signals_date)} · history ${fmtWhen(h.lseg_history_date)}`,
    },
    {
      label: "prices",
      tone: ageTone(priceAsOf, "trading"),
      title: `Prices SPY ${fmtWhen(h.prices_date)} · universe ${fmtWhen(h.prices_universe_date)}`,
    },
    {
      label: `g${h.grades ?? 0}`,
      tone: (h.grades ?? 0) > 0 ? ageTone(h.last_graded_at, "clock") : "bg-white/30",
      title: (h.grades ?? 0) > 0 ? `Last graded ${fmtWhen(h.last_graded_at)}` : "No graded picks yet",
    },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 mt-0.5">
      {parts.map((p) => (
        <span key={p.label} title={p.title} className="flex items-center gap-0.5 cursor-help">
          <span className={cn("w-1.5 h-1.5 rounded-full", p.tone)} />
          {p.label}
        </span>
      ))}
      <span
        title={`Champion${h.challengers ? `; ${h.challengers} challenger(s)` : ""}`}
        className="cursor-help"
      >
        m{h.champion ?? "?"}
        {h.challengers ? `+${h.challengers}` : ""}
      </span>
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

  const run = data.run;
  const byKind = KIND_ORDER.map((kind) => ({
    kind,
    folders: data.folders.filter((f) => f.kind === kind),
  })).filter((g) => g.folders.length > 0);

  return (
    <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
      <div className="px-2 py-1 border-b border-[#d4af37]/20 text-[9px] text-amber-200/50 leading-snug shrink-0">
        #{run.id} · {run.modelVersion} ·{" "}
        {new Date(run.createdAt).toLocaleString([], {
          month: "numeric",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })}
        <div className="text-amber-200/30">Model only · not on RH</div>
        {data.health && <HealthStrip h={data.health} />}
      </div>
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
