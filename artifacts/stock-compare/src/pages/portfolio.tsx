import { useState, useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { getGetStockQuoteQueryOptions, type StockMetrics } from "@workspace/api-client-react";
import { Sidebar } from "@/components/sidebar";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  usePortfolio, PortfolioEntry, PositionType, entryPortfolio,
  positionLabel, isOptionsPosition, isShortPosition,
  notionalValue, premiumReceived, daysToExpiry, cashCollateral,
} from "@/hooks/use-portfolio";
import { formatCurrency } from "@/lib/format";
import {
  Plus, Trash2, TrendingUp, Clock, AlertTriangle,
  Pencil, Wallet, ChevronDown, ChevronRight,
  ArrowUpDown, ArrowUp, ArrowDown, FolderPlus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PortfolioAnalysis } from "@/components/portfolio-analysis";
import { DailyBrief } from "@/components/daily-brief";
import { RobinhoodPortfolio } from "@/components/RobinhoodPortfolio";

// ── Position types ────────────────────────────────────────────────────────────

const POSITION_TYPES: { type: PositionType; label: string; desc: string; color: string }[] = [
  { type: "short_put",  label: "Short Put",  desc: "Sell put, collect premium",    color: "text-green-400" },
  { type: "short_call", label: "Short Call", desc: "Sell call, collect premium",   color: "text-green-400" },
  { type: "stock",      label: "Stock",      desc: "Long equity position",         color: "text-blue-400" },
  { type: "long_put",   label: "Long Put",   desc: "Buy put for protection",       color: "text-orange-400" },
  { type: "long_call",  label: "Long Call",  desc: "Buy call for upside",          color: "text-purple-400" },
  { type: "crypto",     label: "Crypto",     desc: "Cryptocurrency (e.g. BTC-USD)", color: "text-cyan-400" },
];

// ── Option position quote type ─────────────────────────────────────────────────
interface OptionPositionQuote {
  midPrice: number | null;
  bid: number | null;
  ask: number | null;
  impliedVolatility: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
}

// ── Sort helpers ──────────────────────────────────────────────────────────────

type SortCol = "ticker" | "type" | "qty" | "strike" | "value" | "pnl";

function getSortValue(e: PortfolioEntry, col: SortCol, priceMap: Record<string, number | undefined>): string | number {
  switch (col) {
    case "ticker": return e.ticker;
    case "type":   return e.positionType;
    case "qty":    return e.qty;
    case "strike": return e.strike ?? e.avgPrice;
    case "value":
      if (e.positionType === "short_put") return cashCollateral(e);
      if (e.positionType === "stock") return (priceMap[e.ticker] ?? e.avgPrice) * e.qty;
      return premiumReceived(e);
    case "pnl":
      if (e.positionType === "short_put") return premiumReceived(e);
      if (e.positionType === "stock") {
        const p = priceMap[e.ticker];
        return p ? (p - e.avgPrice) * e.qty : 0;
      }
      return daysToExpiry(e.expiry) ?? 999;
  }
}

const SORTABLE_COLS: { col: SortCol; label: string; align: "left" | "right" }[] = [
  { col: "ticker", label: "Ticker",             align: "left" },
  { col: "type",   label: "Type",               align: "left" },
  { col: "qty",    label: "Qty",                align: "right" },
  { col: "strike", label: "Strike / Price",     align: "right" },
  { col: "value",  label: "Collateral / Value", align: "right" },
  { col: "pnl",    label: "Premium / P&L",      align: "right" },
];

// ── Add/Edit position dialog ──────────────────────────────────────────────────

function PositionDialog({
  open, onClose, initial, onSubmit, portfolioNames, presetPortfolio, entries,
}: {
  open: boolean;
  onClose: () => void;
  initial?: PortfolioEntry;
  onSubmit: (entry: Omit<PortfolioEntry, "id" | "openedAt">) => void;
  portfolioNames: string[];
  presetPortfolio?: string;
  entries?: PortfolioEntry[];
}) {
  const isEdit = !!initial;

  // Resolve the initial portfolio value, migrating from legacy `notes` field
  const resolvedInitialPortfolio = (() => {
    if (initial?.portfolioName) return initial.portfolioName;
    if (initial?.notes && portfolioNames.includes(initial.notes)) return initial.notes;
    return presetPortfolio ?? portfolioNames[0] ?? "";
  })();

  const [step,          setStep]          = useState<"type" | "details">(isEdit ? "details" : "type");
  const [posType,       setPosType]       = useState<PositionType | null>(initial?.positionType ?? null);
  const [ticker,        setTicker]        = useState(initial?.ticker ?? "");
  const [qty,           setQty]           = useState(initial?.qty?.toString() ?? "");
  const [price,         setPrice]         = useState(initial?.avgPrice?.toString() ?? "");
  const [strike,        setStrike]        = useState(initial?.strike?.toString() ?? "");
  const [expiry,        setExpiry]        = useState(initial?.expiry ?? "");
  const [portfolio,     setPortfolio]     = useState(resolvedInitialPortfolio);

  const reset = () => {
    setStep(isEdit ? "details" : "type");
    if (!isEdit) {
      setPosType(null); setTicker(""); setQty(""); setPrice("");
      setStrike(""); setExpiry(""); setPortfolio(presetPortfolio ?? portfolioNames[0] ?? "");
    }
  };

  const handleClose = () => { reset(); onClose(); };
  const handleSubmit = () => {
    if (!posType || !ticker || !qty || !price) return;
    const entry: Omit<PortfolioEntry, "id" | "openedAt"> = {
      ticker: ticker.toUpperCase(),
      positionType: posType,
      qty: Number(qty),
      avgPrice: Number(price),
      portfolioName: portfolio || undefined,
      notes: undefined, // clear legacy field on save
    };
    if (isOptionsPosition(posType)) {
      entry.strike = strike ? Number(strike) : undefined;
      entry.expiry = expiry || undefined;
    }
    onSubmit(entry);
    reset();
    onClose();
  };

  const isOptionsType = posType ? isOptionsPosition(posType) : false;
  const isShort       = posType ? isShortPosition(posType) : false;
  const valid         = !!(posType && ticker.trim() && qty && Number(qty) > 0 && price && Number(price) >= 0);

  // Tickers this portfolio is already long — used to restrict covered call selection
  const longTickersInPortfolio = useMemo(() => {
    if (!entries || posType !== "short_call") return [];
    return [...new Set(
      entries
        .filter(e => e.positionType === "stock" && entryPortfolio(e) === portfolio)
        .map(e => e.ticker),
    )];
  }, [entries, portfolio, posType]);

  const inputCls = "w-full h-9 px-3 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors";
  const labelCls = "block text-xs font-medium text-muted-foreground mb-1";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {step === "type" ? "Add Position — Select Type" : `${isEdit ? "Edit" : "Add"} ${posType ? positionLabel(posType) : ""}`}
          </DialogTitle>
        </DialogHeader>

        {step === "type" ? (
          <div className="space-y-2 pt-1">
            {POSITION_TYPES.map(pt => (
              <button key={pt.type} onClick={() => { setPosType(pt.type); setStep("details"); }}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-secondary/50 hover:border-primary/40 transition-all text-left">
                <div>
                  <div className={cn("font-semibold text-sm", pt.color)}>{pt.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{pt.desc}</div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            {/* Portfolio */}
            <div>
              <label className={labelCls}>Portfolio *</label>
              <select className={cn(inputCls, "cursor-pointer")} value={portfolio}
                onChange={e => setPortfolio(e.target.value)}>
                <option value="">— Unassigned —</option>
                {portfolioNames.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>

            {/* Ticker + Qty */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>
                  Ticker *
                  {posType === "crypto" && <span className="ml-1 font-normal text-muted-foreground/70">(e.g. BTC-USD)</span>}
                </label>
                {posType === "short_call" && longTickersInPortfolio.length > 0 ? (
                  <>
                    <select className={cn(inputCls, "cursor-pointer")} value={ticker}
                      onChange={e => setTicker(e.target.value)}>
                      <option value="">— select —</option>
                      {longTickersInPortfolio.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <p className="text-[10px] text-muted-foreground mt-1">
                      Covered calls restricted to {portfolio} longs.
                    </p>
                  </>
                ) : (
                  <input className={cn(inputCls, "uppercase")}
                    placeholder={posType === "crypto" ? "BTC-USD" : "NVDA"} value={ticker}
                    onChange={e => setTicker(e.target.value.toUpperCase())} autoFocus={!isEdit} />
                )}
              </div>
              <div>
                <label className={labelCls}>
                  {isOptionsType ? "Contracts *" : posType === "crypto" ? "Coins *" : "Shares *"}
                </label>
                <input className={inputCls} type="number" min="1" placeholder="1" value={qty}
                  onChange={e => setQty(e.target.value)} />
              </div>
            </div>

            {/* Type (edit only) */}
            {isEdit && (
              <div>
                <label className={labelCls}>Position Type</label>
                <select className={cn(inputCls, "cursor-pointer")} value={posType ?? ""}
                  onChange={e => setPosType(e.target.value as PositionType)}>
                  {POSITION_TYPES.map(pt => <option key={pt.type} value={pt.type}>{pt.label}</option>)}
                </select>
              </div>
            )}

            {/* Price / Premium */}
            <div>
              <label className={labelCls}>
                {isShort ? "Premium Received (per contract) *"
                  : isOptionsType ? "Premium Paid (per contract) *"
                  : posType === "crypto" ? "Avg Cost Per Coin *"
                  : "Avg Price Per Share *"}
              </label>
              <input className={inputCls} type="number" step="0.01" min="0" placeholder="0.00"
                value={price} onChange={e => setPrice(e.target.value)} />
            </div>

            {/* Strike + Expiry */}
            {isOptionsType && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Strike Price</label>
                  <input className={inputCls} type="number" step="0.50" min="0" placeholder="850.00"
                    value={strike} onChange={e => setStrike(e.target.value)} />
                </div>
                <div>
                  <label className={labelCls}>Expiry Date</label>
                  <input className={inputCls} type="date" value={expiry}
                    onChange={e => setExpiry(e.target.value)} />
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-1">
              {!isEdit && <Button variant="outline" className="flex-1" onClick={() => setStep("type")}>Back</Button>}
              <Button variant="outline" className={isEdit ? "flex-1" : ""} onClick={handleClose}>Cancel</Button>
              <Button className="flex-1" onClick={handleSubmit} disabled={!valid}>
                {isEdit ? "Save Changes" : "Add Position"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Add Portfolio dialog ──────────────────────────────────────────────────────

function AddPortfolioDialog({ open, onClose, onAdd, existing }: {
  open: boolean;
  onClose: () => void;
  onAdd: (name: string) => void;
  existing: string[];
}) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const isDupe  = existing.includes(trimmed);
  const valid   = !!trimmed && !isDupe;

  const handleSubmit = () => {
    if (!valid) return;
    onAdd(trimmed);
    setName("");
    onClose();
  };

  const inputCls = "w-full h-9 px-3 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && (setName(""), onClose())}>
      <DialogContent className="max-w-xs">
        <DialogHeader>
          <DialogTitle>Add Portfolio</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 pt-1">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Portfolio Name *</label>
            <input
              className={inputCls}
              placeholder="e.g. Roth IRA, Margin, TFSA"
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              autoFocus
            />
            {isDupe && <p className="text-xs text-red-400 mt-1">A portfolio with this name already exists.</p>}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => { setName(""); onClose(); }}>Cancel</Button>
            <Button className="flex-1" onClick={handleSubmit} disabled={!valid}>Create</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({ entry, currentPrice, onRemove, onEdit }: {
  entry: PortfolioEntry;
  currentPrice: number | undefined;
  onRemove: (id: string) => void;
  onEdit: (entry: PortfolioEntry) => void;
}) {
  const isOpt      = isOptionsPosition(entry.positionType);
  const isShort    = isShortPosition(entry.positionType);
  const dte        = daysToExpiry(entry.expiry);
  const premium    = premiumReceived(entry);
  const collateral = cashCollateral(entry);
  const optionType: "call" | "put" = entry.positionType.includes("call") ? "call" : "put";

  const pnl      = (entry.positionType === "stock" && currentPrice != null)
    ? (currentPrice - entry.avgPrice) * entry.qty : null;
  const cryptoPnl = (entry.positionType === "crypto" && currentPrice != null)
    ? (currentPrice - entry.avgPrice) * entry.qty : null;

  const expiryWarning = dte !== null && dte >= 0 && dte <= 7;
  const isExpired     = dte !== null && dte < 0;

  // Live option quote — Greeks + current market price
  const { data: optQuote } = useQuery<OptionPositionQuote | null>({
    queryKey: ["opt-pos-quote", entry.ticker, entry.expiry, entry.strike, optionType],
    queryFn: async () => {
      const params = new URLSearchParams({
        ticker: entry.ticker,
        expiry: entry.expiry ?? "",
        strike: String(entry.strike ?? 0),
        type:   optionType,
      });
      const res = await fetch(`/api/options/position-quote?${params}`);
      if (!res.ok) return null;
      return res.json();
    },
    enabled: isOpt && !!entry.expiry && !!entry.strike,
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const optPnl = (optQuote?.midPrice != null)
    ? (isShort
        ? (entry.avgPrice - optQuote.midPrice) * 100 * entry.qty
        : (optQuote.midPrice - entry.avgPrice) * 100 * entry.qty)
    : null;

  // Breakeven is purely from entry data — always available when strike is set
  const breakeven = (entry.strike != null)
    ? (optionType === "put" ? entry.strike - entry.avgPrice : entry.strike + entry.avgPrice)
    : null;

  const hasLiveData = optQuote?.delta != null || optQuote?.gamma != null || optQuote?.theta != null;

  return (
    <>
      <tr className="border-b border-border/30 hover:bg-secondary/20 transition-colors group">
        <td className="py-2.5 px-4 font-mono font-bold text-sm">{entry.ticker}</td>
        <td className="py-2.5 px-4">
          <Badge variant="outline" className={cn(
            "text-[10px] font-medium",
            isShort ? "text-green-400 border-green-500/30 bg-green-500/10" :
            isOpt   ? "text-orange-400 border-orange-500/30 bg-orange-500/10" :
            entry.positionType === "crypto" ? "text-cyan-400 border-cyan-500/30 bg-cyan-500/10" :
                      "text-blue-400 border-blue-500/30 bg-blue-500/10"
          )}>
            {positionLabel(entry.positionType)}
          </Badge>
        </td>
        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-sm">
          {entry.qty}
          <span className="text-muted-foreground text-xs ml-1">
            {isOpt ? "contracts" : entry.positionType === "crypto" ? "coins" : "shares"}
          </span>
        </td>
        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-sm">
          {isOpt && entry.strike ? `$${entry.strike.toFixed(2)}` : `$${entry.avgPrice.toFixed(2)}`}
        </td>
        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-sm">
          {entry.positionType === "short_put" ? (
            <div className="flex flex-col items-end">
              <span className="text-yellow-400">{formatCurrency(collateral)}</span>
              <span className="text-[10px] text-muted-foreground">collateral</span>
            </div>
          ) : isOpt ? (
            <span className={isShort ? "text-green-400" : "text-red-400"}>
              {isShort ? "+" : "-"}{formatCurrency(Math.abs(isShort ? premium : entry.avgPrice * 100 * entry.qty))}
            </span>
          ) : (
            currentPrice != null
              ? <span>{formatCurrency(currentPrice * entry.qty)}</span>
              : <span className="text-muted-foreground">—</span>
          )}
        </td>
        <td className="py-2.5 px-4 text-right font-mono tabular-nums text-sm">
          {entry.positionType === "stock" ? (
            pnl !== null
              ? <span className={pnl >= 0 ? "text-green-400" : "text-red-400"}>{pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}</span>
              : <span className="text-muted-foreground">—</span>
          ) : entry.positionType === "crypto" ? (
            cryptoPnl !== null
              ? <span className={cryptoPnl >= 0 ? "text-green-400" : "text-red-400"}>{cryptoPnl >= 0 ? "+" : ""}{formatCurrency(cryptoPnl)}</span>
              : <span className="text-muted-foreground">—</span>
          ) : isOpt && optPnl !== null ? (
            <div className="flex flex-col items-end">
              <span className={cn("tabular-nums", optPnl >= 0 ? "text-green-400" : "text-red-400")}>
                {optPnl >= 0 ? "+" : ""}{formatCurrency(optPnl)}
              </span>
              <span className="text-[10px] text-muted-foreground">@ ${optQuote!.midPrice!.toFixed(2)}</span>
            </div>
          ) : entry.positionType === "short_put" ? (
            <span className="text-green-400">+{formatCurrency(premium)}</span>
          ) : isOpt && entry.expiry ? (
            <span className={cn(
              "text-xs flex items-center justify-end gap-1",
              isExpired ? "text-muted-foreground/50" : expiryWarning ? "text-yellow-400" : "text-muted-foreground"
            )}>
              {expiryWarning && <AlertTriangle className="w-3 h-3" />}
              {isExpired ? "Expired" : dte === 0 ? "Today" : `${dte}d`}
            </span>
          ) : <span className="text-muted-foreground">—</span>}
        </td>
        <td className="py-2.5 px-4 text-right">
          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-all">
            <button onClick={() => onEdit(entry)}
              className="p-1 hover:bg-background/80 rounded transition-all text-muted-foreground hover:text-primary">
              <Pencil className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => onRemove(entry.id)}
              className="p-1 hover:bg-background/80 rounded transition-all text-muted-foreground hover:text-red-400">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </td>
      </tr>
      {isOpt && (hasLiveData || breakeven != null) && (
        <tr className="border-b border-border/20 bg-secondary/5">
          <td colSpan={7} className="px-4 py-1.5">
            <div className="flex items-center gap-5 text-xs font-mono tabular-nums text-muted-foreground">
              {optQuote?.delta != null && (
                <span>Δ <span className="text-foreground/70">{optQuote.delta.toFixed(3)}</span></span>
              )}
              {optQuote?.gamma != null && (
                <span>Γ <span className="text-foreground/70">{optQuote.gamma.toFixed(5)}</span></span>
              )}
              {optQuote?.theta != null && (
                <span>Θ <span className="text-foreground/70">{optQuote.theta.toFixed(4)}/day</span></span>
              )}
              {breakeven != null && (
                <span>BE <span className="text-foreground/70">${breakeven.toFixed(2)}</span></span>
              )}
              {optQuote?.impliedVolatility != null && (
                <span>IV <span className="text-foreground/70">{(optQuote.impliedVolatility * 100).toFixed(1)}%</span></span>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Portfolio box ─────────────────────────────────────────────────────────────

function PortfolioBox({ name, entries, priceMap, onEdit, onRemove, onAddPosition }: {
  name: string;
  entries: PortfolioEntry[];
  priceMap: Record<string, number | undefined>;
  onEdit: (entry: PortfolioEntry) => void;
  onRemove: (id: string) => void;
  onAddPosition: (portfolioName: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [sort, setSort]           = useState<{ col: SortCol; dir: "asc" | "desc" }>({ col: "ticker", dir: "asc" });

  const toggleSort = (col: SortCol) =>
    setSort(prev => prev.col === col
      ? { col, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { col, dir: "asc" }
    );

  const sortedEntries = useMemo(() =>
    [...entries].sort((a, b) => {
      const va = getSortValue(a, sort.col, priceMap);
      const vb = getSortValue(b, sort.col, priceMap);
      const cmp = typeof va === "string"
        ? (va as string).localeCompare(vb as string)
        : (va as number) - (vb as number);
      return sort.dir === "asc" ? cmp : -cmp;
    }),
  [entries, sort, priceMap]);

  const stats = useMemo(() => {
    let collateral = 0, premium = 0, stockValue = 0;
    entries.forEach(e => {
      if (e.positionType === "short_put") {
        collateral += cashCollateral(e); premium += premiumReceived(e);
      } else if (e.positionType === "short_call") {
        premium += premiumReceived(e);
      } else if (e.positionType === "stock") {
        stockValue += (priceMap[e.ticker] ?? e.avgPrice) * e.qty;
      }
    });
    return { collateral, premium, stockValue, total: collateral + premium + stockValue };
  }, [entries, priceMap]);

  return (
    <Card>
      {/* Box header */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-border/40">
        {/* Left: collapse toggle + name */}
        <button
          onClick={() => setCollapsed(v => !v)}
          className="flex items-center gap-2 hover:text-foreground transition-colors text-left"
        >
          {collapsed
            ? <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />
            : <ChevronDown  className="w-4 h-4 text-muted-foreground shrink-0" />}
          <span className="font-bold text-sm">{name}</span>
          <span className="text-xs text-white/60">
            {entries.length} position{entries.length !== 1 ? "s" : ""}
          </span>
        </button>

        {/* Right: stats + Add Position */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 text-xs font-mono tabular-nums">
            {stats.collateral > 0 && (
              <span className="text-yellow-400">
                <span className="text-white/60 font-sans mr-1">collateral</span>
                {formatCurrency(stats.collateral)}
              </span>
            )}
            {stats.premium > 0 && (
              <span className="text-green-400">
                <span className="text-white/60 font-sans mr-1">premium</span>
                +{formatCurrency(stats.premium)}
              </span>
            )}
            {stats.stockValue > 0 && (
              <span className="text-blue-400">
                <span className="text-white/60 font-sans mr-1">stock</span>
                {formatCurrency(stats.stockValue)}
              </span>
            )}
            {stats.total > 0 && (
              <span className="font-bold text-foreground border-l border-border pl-3">
                {formatCurrency(stats.total)}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => onAddPosition(name)}
            className="gap-1.5 h-7 text-xs shrink-0"
          >
            <Plus className="w-3 h-3" /> Add Position
          </Button>
        </div>
      </div>

      {/* Table */}
      {!collapsed && (
        <CardContent className="p-0">
          {entries.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm text-muted-foreground">No positions in {name} yet.</p>
              <button
                onClick={() => onAddPosition(name)}
                className="mt-2 text-xs text-primary hover:underline"
              >
                Add your first {name} position →
              </button>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border/40 bg-secondary/10">
                    {SORTABLE_COLS.map(({ col, label, align }) => (
                      <th
                        key={col}
                        onClick={() => toggleSort(col)}
                        className={cn(
                          "py-2.5 px-4 text-xs font-bold text-white uppercase tracking-wider",
                          "cursor-pointer select-none hover:text-foreground transition-colors",
                          align === "right" ? "text-right" : "text-left"
                        )}
                      >
                        <div className={cn("flex items-center gap-1", align === "right" && "justify-end")}>
                          {label}
                          {sort.col === col
                            ? sort.dir === "asc"
                              ? <ArrowUp className="w-3 h-3 text-primary" />
                              : <ArrowDown className="w-3 h-3 text-primary" />
                            : <ArrowUpDown className="w-3 h-3 opacity-30" />}
                        </div>
                      </th>
                    ))}
                    <th className="py-2 px-4 w-16" />
                  </tr>
                </thead>
                <tbody>
                  {sortedEntries.map(entry => (
                    <PositionRow
                      key={entry.id}
                      entry={entry}
                      currentPrice={priceMap[entry.ticker]}
                      onRemove={onRemove}
                      onEdit={onEdit}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

// ── Aggregate summary card ────────────────────────────────────────────────────

function AggCard({ label, value, sub, icon, highlight }: {
  label: string; value: string; sub?: string; icon: React.ReactNode; highlight?: boolean;
}) {
  return (
    <div className={cn(
      "rounded-xl border p-4 flex items-start gap-3",
      highlight ? "border-primary/40 bg-primary/5" : "border-border bg-card"
    )}>
      <div className="mt-0.5 text-white/60">{icon}</div>
      <div>
        <div className="text-xs font-semibold text-white/75 uppercase tracking-wider mb-1">{label}</div>
        <div className="text-2xl font-bold font-mono tabular-nums">{value}</div>
        {sub && <div className="text-xs text-white/60 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

// Convert Robinhood DB rows → PortfolioEntry for PortfolioAnalysis
function dbToEntries(
  positions: Array<{ id: number; symbol: string; quantity: string | null; avgCost: string | null; accountNickname: string | null; account: string }>,
  options: Array<{ id: number; symbol: string; direction: string | null; optionType: string | null; qty: string | null; avgPremium: string | null; strike: string | null; expiration: string | null; account: string }>,
  accountMap: Map<string, string>,
): PortfolioEntry[] {
  const posEntries: PortfolioEntry[] = positions.map(p => ({
    id: `rh-pos-${p.id}`,
    ticker: p.symbol,
    positionType: 'stock' as const,
    qty: parseFloat(p.quantity ?? '0'),
    avgPrice: parseFloat(p.avgCost ?? '0'),
    openedAt: new Date().toISOString().slice(0, 10),
    portfolioName: p.accountNickname ?? p.account,
  }))

  const optEntries: PortfolioEntry[] = options.flatMap(o => {
    const dir = o.direction ?? 'long'
    const kind = o.optionType ?? 'put'
    const typeMap: Record<string, PositionType> = {
      'short-put': 'short_put', 'short-call': 'short_call',
      'long-put':  'long_put',  'long-call':  'long_call',
    }
    const positionType: PositionType = typeMap[`${dir}-${kind}`] ?? 'short_put'
    const acct = accountMap.get(o.account) ?? o.account
    return [{
      id: `rh-opt-${o.id}`,
      ticker: o.symbol,
      positionType,
      qty: Math.abs(parseFloat(o.qty ?? '0')),
      avgPrice: parseFloat(o.avgPremium ?? '0'),
      strike: o.strike ? parseFloat(o.strike) : undefined,
      expiry: o.expiration ?? undefined,
      openedAt: new Date().toISOString().slice(0, 10),
      portfolioName: acct,
    }]
  })

  return [...posEntries, ...optEntries]
}

export default function Portfolio() {
  const {
    entries: _legacyEntries, portfolioNames: _legacyPortfolioNames, isLoaded,
    addEntry, removeEntry, updateEntry, addPortfolioName,
  } = usePortfolio();

  const [showAddPortfolio, setShowAddPortfolio] = useState(false);
  const [showAddPosition,  setShowAddPosition]  = useState(false);
  const [presetPortfolio,  setPresetPortfolio]  = useState<string | undefined>(undefined);
  const [editingEntry,     setEditingEntry]      = useState<PortfolioEntry | null>(null);

  // Robinhood snapshot (shared query key with RobinhoodPortfolio — no extra request)
  const { data: rhData } = useQuery<{
    snapshot: { id: number; importedAt: string; accountIds: string[]; totalValue: string | null } | null;
    positions: Array<{ id: number; symbol: string; quantity: string | null; avgCost: string | null; accountNickname: string | null; account: string }>;
    options: Array<{ id: number; symbol: string; direction: string | null; optionType: string | null; qty: string | null; avgPremium: string | null; strike: string | null; expiration: string | null; account: string }>;
  }>({
    queryKey: ['portfolio-snapshot-latest'],
    queryFn: async () => {
      const res = await fetch('/api/portfolio/snapshot/latest', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load portfolio')
      return res.json()
    },
  })

  const rhPositions = rhData?.positions ?? []
  const rhOptions   = rhData?.options   ?? []
  const accountMap  = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of rhPositions) { if (p.accountNickname) m.set(p.account, p.accountNickname) }
    return m
  }, [rhPositions])

  const entries = useMemo(() => dbToEntries(rhPositions, rhOptions, accountMap), [rhPositions, rhOptions, accountMap])
  const portfolioNames = useMemo(() => [...new Set(entries.map(e => e.portfolioName).filter(Boolean) as string[])], [entries])
  const uniqueTickers  = useMemo(() => [...new Set(entries.map(e => e.ticker))], [entries]);

  const priceQueries = useQueries({
    queries: uniqueTickers.map(ticker => ({
      ...getGetStockQuoteQueryOptions({ ticker }),
      staleTime: 5 * 60 * 1000,
    })),
  });

  const priceMap = useMemo(() => {
    const m: Record<string, number | undefined> = {};
    uniqueTickers.forEach((t, i) => { m[t] = priceQueries[i]?.data?.currentPrice ?? undefined; });
    return m;
  }, [uniqueTickers, priceQueries]);

  const stockDataMap = useMemo(() => {
    const m: Record<string, StockMetrics> = {};
    uniqueTickers.forEach((t, i) => { if (priceQueries[i]?.data) m[t] = priceQueries[i].data!; });
    return m;
  }, [uniqueTickers, priceQueries]);

  // Group entries by portfolio, using legacy notes fallback
  const grouped = useMemo(() => {
    const g: Record<string, PortfolioEntry[]> = {};
    entries.forEach(e => {
      const key = entryPortfolio(e) || "Unassigned";
      if (!g[key]) g[key] = [];
      g[key].push(e);
    });
    return g;
  }, [entries]);

  // Aggregate stats
  const agg = useMemo(() => {
    let totalCollateral = 0, totalPremium = 0, totalStockValue = 0, openOptions = 0, expiringThisWeek = 0;
    entries.forEach(e => {
      if (e.positionType === "short_put") {
        totalCollateral += cashCollateral(e); totalPremium += premiumReceived(e); openOptions++;
        if ((daysToExpiry(e.expiry) ?? 99) <= 7) expiringThisWeek++;
      } else if (e.positionType === "short_call") {
        totalPremium += premiumReceived(e); openOptions++;
        if ((daysToExpiry(e.expiry) ?? 99) <= 7) expiringThisWeek++;
      } else if (e.positionType === "stock") {
        totalStockValue += (priceMap[e.ticker] ?? e.avgPrice) * e.qty;
      } else { openOptions++; }
    });
    return { totalCollateral, totalPremium, totalStockValue, openOptions, expiringThisWeek,
      totalValue: totalCollateral + totalPremium + totalStockValue };
  }, [entries, priceMap]);

  // "Unassigned" entries — those not in any named portfolio
  const unassignedEntries = useMemo(() =>
    entries.filter(e => {
      const key = entryPortfolio(e);
      return !key || !portfolioNames.includes(key);
    }),
  [entries, portfolioNames]);

  const openAddPosition = (pName?: string) => {
    setPresetPortfolio(pName);
    setShowAddPosition(true);
  };

  if (!isLoaded) return null;

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar />

      <main className="flex-1 min-w-0" style={{ marginLeft: 'var(--sidebar-w, 220px)', transition: 'margin-left 200ms ease' }}>
        {/* Header */}
        <div className="p-5 border-b border-border/50 flex items-center justify-between gap-4 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">Portfolio</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {entries.length === 0
                ? "No positions yet"
                : `${entries.length} position${entries.length !== 1 ? "s" : ""} across ${uniqueTickers.length} ticker${uniqueTickers.length !== 1 ? "s" : ""} · ${portfolioNames.length} portfolio${portfolioNames.length !== 1 ? "s" : ""}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setShowAddPortfolio(true)} className="gap-1.5 h-8">
              <FolderPlus className="w-3.5 h-3.5" /> Add Portfolio
            </Button>
          </div>
        </div>

        <div className="p-5 space-y-5">
          {entries.length === 0 && portfolioNames.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-28 gap-5 text-center">
              <div className="w-16 h-16 rounded-2xl bg-secondary/50 flex items-center justify-center border border-dashed border-border">
                <TrendingUp className="w-8 h-8 text-muted-foreground/50" />
              </div>
              <div>
                <p className="text-sm font-medium">No positions tracked yet</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  Create portfolios (IRA, FILDI, MOM) then add positions to each.
                </p>
              </div>
              <Button onClick={() => setShowAddPortfolio(true)} className="gap-1.5">
                <FolderPlus className="w-4 h-4" /> Create first portfolio
              </Button>
            </div>
          ) : (
            <>
              {/* Aggregate summary */}
              {entries.length > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  <AggCard label="Total Portfolio Value" value={formatCurrency(agg.totalValue)}
                    sub="collateral + premium + stock"
                    icon={<Wallet className="w-4 h-4 text-primary" />} highlight />
                  <AggCard label="Cash Collateral Tied Up" value={formatCurrency(agg.totalCollateral)}
                    sub="locked for short puts (strike × 100 × qty)"
                    icon={<Wallet className="w-4 h-4 text-yellow-400" />} />
                  <AggCard label="Premium Collected" value={formatCurrency(agg.totalPremium)}
                    sub={`from ${agg.openOptions} option leg${agg.openOptions !== 1 ? "s" : ""}`}
                    icon={<TrendingUp className="w-4 h-4 text-green-400" />} />
                  <AggCard label="Expiring This Week" value={String(agg.expiringThisWeek)}
                    sub={`of ${agg.openOptions} open legs`}
                    icon={<Clock className={cn("w-4 h-4", agg.expiringThisWeek > 0 ? "text-yellow-400" : "")} />} />
                </div>
              )}

              {/* Robinhood CSV Portfolio */}
              <RobinhoodPortfolio />

              {/* Daily AI Highlights */}
              <DailyBrief tickers={uniqueTickers} />

              {/* Portfolio Analysis — driven by Robinhood snapshot */}
              {entries.length > 0 && (
                <PortfolioAnalysis
                  entries={entries}
                  priceMap={priceMap}
                  stockDataMap={stockDataMap}
                  portfolioNames={portfolioNames}
                />
              )}
            </>
          )}
        </div>
      </main>

      {/* Add Portfolio dialog */}
      <AddPortfolioDialog
        open={showAddPortfolio}
        onClose={() => setShowAddPortfolio(false)}
        onAdd={addPortfolioName}
        existing={portfolioNames}
      />

      {/* Add Position dialog */}
      <PositionDialog
        open={showAddPosition}
        onClose={() => { setShowAddPosition(false); setPresetPortfolio(undefined); }}
        onSubmit={addEntry}
        portfolioNames={portfolioNames}
        presetPortfolio={presetPortfolio}
        entries={entries}
      />

      {/* Edit Position dialog */}
      {editingEntry && (
        <PositionDialog
          open={!!editingEntry}
          onClose={() => setEditingEntry(null)}
          initial={editingEntry}
          onSubmit={patch => { updateEntry(editingEntry.id, patch); setEditingEntry(null); }}
          portfolioNames={portfolioNames}
          entries={entries}
        />
      )}
    </div>
  );
}
