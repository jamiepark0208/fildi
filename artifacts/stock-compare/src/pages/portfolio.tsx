import { useState, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { getGetStockQuoteQueryOptions } from "@workspace/api-client-react";
import { Sidebar } from "@/components/sidebar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  usePortfolio, PortfolioEntry, PositionType,
  positionLabel, isOptionsPosition, isShortPosition,
  notionalValue, premiumReceived, daysToExpiry,
} from "@/hooks/use-portfolio";
import { formatCurrency, formatLargeNumber } from "@/lib/format";
import { Plus, Trash2, TrendingUp, TrendingDown, Clock, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Constants ─────────────────────────────────────────────────────────────────

const POSITION_TYPES: { type: PositionType; label: string; desc: string; color: string }[] = [
  { type: "short_put",  label: "Short Put",  desc: "Sell put, collect premium",  color: "text-green-400" },
  { type: "short_call", label: "Short Call", desc: "Sell call, collect premium", color: "text-green-400" },
  { type: "stock",      label: "Stock",      desc: "Long equity position",       color: "text-blue-400" },
  { type: "long_put",   label: "Long Put",   desc: "Buy put for protection",     color: "text-orange-400" },
  { type: "long_call",  label: "Long Call",  desc: "Buy call for upside",        color: "text-purple-400" },
];

// ── Add position dialog ───────────────────────────────────────────────────────

function AddPositionDialog({ open, onClose, onAdd }: {
  open: boolean;
  onClose: () => void;
  onAdd: (entry: Omit<PortfolioEntry, "id" | "openedAt">) => void;
}) {
  const [step, setStep] = useState<"type" | "details">("type");
  const [posType, setPosType] = useState<PositionType | null>(null);
  const [ticker, setTicker] = useState("");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [strike, setStrike] = useState("");
  const [expiry, setExpiry] = useState("");
  const [notes, setNotes] = useState("");

  const reset = () => {
    setStep("type"); setPosType(null); setTicker(""); setQty("");
    setPrice(""); setStrike(""); setExpiry(""); setNotes("");
  };

  const handleClose = () => { reset(); onClose(); };

  const handleSubmit = () => {
    if (!posType || !ticker || !qty || !price) return;
    const entry: Omit<PortfolioEntry, "id" | "openedAt"> = {
      ticker: ticker.toUpperCase(),
      positionType: posType,
      qty: Number(qty),
      avgPrice: Number(price),
      notes: notes || undefined,
    };
    if (isOptionsPosition(posType)) {
      entry.strike = strike ? Number(strike) : undefined;
      entry.expiry = expiry || undefined;
    }
    onAdd(entry);
    reset();
    onClose();
  };

  const isOptionsType = posType ? isOptionsPosition(posType) : false;
  const isShort = posType ? isShortPosition(posType) : false;
  const valid = !!(posType && ticker.trim() && qty && Number(qty) > 0 && price && Number(price) >= 0);

  const inputCls = "w-full h-9 px-3 text-sm bg-background border border-border rounded-md focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-colors";
  const labelCls = "block text-xs font-medium text-muted-foreground mb-1";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{step === "type" ? "Add Position — Select Type" : `Add ${posType ? positionLabel(posType) : ""}`}</DialogTitle>
        </DialogHeader>

        {step === "type" ? (
          <div className="space-y-2 pt-1">
            {POSITION_TYPES.map(pt => (
              <button
                key={pt.type}
                onClick={() => { setPosType(pt.type); setStep("details"); }}
                className="w-full flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-secondary/50 hover:border-primary/40 transition-all text-left"
              >
                <div className="flex-1">
                  <div className={cn("font-semibold text-sm", pt.color)}>{pt.label}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">{pt.desc}</div>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-4 pt-1">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Ticker *</label>
                <input
                  className={cn(inputCls, "uppercase")}
                  placeholder="NVDA"
                  value={ticker}
                  onChange={e => setTicker(e.target.value.toUpperCase())}
                  autoFocus
                />
              </div>
              <div>
                <label className={labelCls}>{isOptionsType ? "Contracts *" : "Shares *"}</label>
                <input
                  className={inputCls}
                  type="number"
                  min="1"
                  placeholder="1"
                  value={qty}
                  onChange={e => setQty(e.target.value)}
                />
              </div>
            </div>

            <div>
              <label className={labelCls}>
                {isShort ? "Premium Received (per contract) *" : isOptionsType ? "Premium Paid (per contract) *" : "Avg Price Per Share *"}
              </label>
              <input
                className={inputCls}
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={price}
                onChange={e => setPrice(e.target.value)}
              />
            </div>

            {isOptionsType && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={labelCls}>Strike Price</label>
                  <input
                    className={inputCls}
                    type="number"
                    step="0.50"
                    min="0"
                    placeholder="850.00"
                    value={strike}
                    onChange={e => setStrike(e.target.value)}
                  />
                </div>
                <div>
                  <label className={labelCls}>Expiry Date</label>
                  <input
                    className={inputCls}
                    type="date"
                    value={expiry}
                    onChange={e => setExpiry(e.target.value)}
                  />
                </div>
              </div>
            )}

            <div>
              <label className={labelCls}>Notes (optional)</label>
              <input
                className={inputCls}
                placeholder="e.g. RSI 34 / MFI 18 at entry"
                value={notes}
                onChange={e => setNotes(e.target.value)}
              />
            </div>

            <div className="flex gap-2 pt-1">
              <Button variant="outline" className="flex-1" onClick={() => setStep("type")}>Back</Button>
              <Button className="flex-1" onClick={handleSubmit} disabled={!valid}>Add Position</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Summary cards ─────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">{icon}</div>
        <div>
          <div className="text-xs text-muted-foreground font-medium mb-1">{label}</div>
          <div className="text-xl font-bold font-mono tabular-nums">{value}</div>
          {sub && <div className="text-xs text-muted-foreground mt-0.5">{sub}</div>}
        </div>
      </CardContent>
    </Card>
  );
}

// ── Position row ──────────────────────────────────────────────────────────────

function PositionRow({ entry, currentPrice, onRemove }: {
  entry: PortfolioEntry;
  currentPrice: number | undefined;
  onRemove: (id: string) => void;
}) {
  const isOpt = isOptionsPosition(entry.positionType);
  const isShort = isShortPosition(entry.positionType);
  const dte = daysToExpiry(entry.expiry);
  const premium = premiumReceived(entry);

  const pnl = useMemo(() => {
    if (!currentPrice || entry.positionType !== "stock") return null;
    return (currentPrice - entry.avgPrice) * entry.qty;
  }, [currentPrice, entry]);

  const expiryWarning = dte !== null && dte >= 0 && dte <= 7;
  const isExpired = dte !== null && dte < 0;

  return (
    <tr className="border-b border-border/30 hover:bg-secondary/20 transition-colors group">
      <td className="py-2.5 px-4">
        <div className="font-mono font-bold text-sm">{entry.ticker}</div>
        {entry.notes && <div className="text-[10px] text-muted-foreground truncate max-w-[120px]">{entry.notes}</div>}
      </td>
      <td className="py-2.5 px-4">
        <Badge variant="outline" className={cn(
          "text-[10px] font-medium",
          isShort ? "text-green-400 border-green-500/30 bg-green-500/10" :
          isOpt   ? "text-orange-400 border-orange-500/30 bg-orange-500/10" :
                    "text-blue-400 border-blue-500/30 bg-blue-500/10"
        )}>
          {positionLabel(entry.positionType)}
        </Badge>
      </td>
      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-sm">
        {entry.qty}
        <span className="text-muted-foreground text-xs ml-1">{isOpt ? "ct" : "sh"}</span>
      </td>
      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-sm">
        {isOpt && entry.strike ? (
          <span>${entry.strike.toFixed(2)}</span>
        ) : (
          <span>${entry.avgPrice.toFixed(2)}</span>
        )}
      </td>
      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-sm">
        {isOpt ? (
          <span className={cn("text-green-400", !isShort && "text-red-400")}>
            {isShort ? "+" : "-"}{formatCurrency(Math.abs(isShort ? premium : entry.avgPrice * 100 * entry.qty))}
          </span>
        ) : (
          currentPrice ? <span className="text-foreground">{formatCurrency(currentPrice * entry.qty)}</span> : <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-sm">
        {pnl !== null ? (
          <span className={pnl >= 0 ? "text-green-400" : "text-red-400"}>
            {pnl >= 0 ? "+" : ""}{formatCurrency(pnl)}
          </span>
        ) : isOpt && entry.expiry ? (
          <span className={cn(
            "text-xs flex items-center justify-end gap-1",
            isExpired ? "text-muted-foreground/50" : expiryWarning ? "text-yellow-400" : "text-muted-foreground"
          )}>
            {expiryWarning && <AlertTriangle className="w-3 h-3" />}
            {isExpired ? "Expired" : dte === 0 ? "Today" : `${dte}d`}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </td>
      <td className="py-2.5 px-4 text-right">
        <button
          onClick={() => onRemove(entry.id)}
          className="opacity-0 group-hover:opacity-100 p-1 hover:bg-background/80 rounded transition-all text-muted-foreground hover:text-red-400"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </td>
    </tr>
  );
}

// ── Concentration bar ─────────────────────────────────────────────────────────

function ConcentrationBar({ ticker, pct, color }: { ticker: string; pct: number; color: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-14 font-mono font-bold text-right">{ticker}</span>
      <div className="flex-1 bg-secondary rounded-full h-1.5 overflow-hidden">
        <div className={cn("h-full rounded-full", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-10 text-right text-muted-foreground tabular-nums">{pct.toFixed(0)}%</span>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Portfolio() {
  const { entries, isLoaded, addEntry, removeEntry } = usePortfolio();
  const [showAdd, setShowAdd] = useState(false);

  const uniqueTickers = useMemo(() => [...new Set(entries.map(e => e.ticker))], [entries]);

  const priceQueries = useQueries({
    queries: uniqueTickers.map(ticker => ({
      ...getGetStockQuoteQueryOptions({ ticker }),
      staleTime: 60 * 1000,
    })),
  });

  const priceMap = useMemo(() => {
    const m: Record<string, number | undefined> = {};
    uniqueTickers.forEach((t, i) => { m[t] = priceQueries[i]?.data?.currentPrice ?? undefined; });
    return m;
  }, [uniqueTickers, priceQueries]);

  // Summary stats
  const { totalPremium, totalStockValue, totalStockPnL, openOptions, expiringThisWeek } = useMemo(() => {
    let totalPremium = 0;
    let totalStockValue = 0;
    let totalStockPnL = 0;
    let openOptions = 0;
    let expiringThisWeek = 0;

    entries.forEach(e => {
      if (isShortPosition(e.positionType)) {
        totalPremium += premiumReceived(e);
        openOptions++;
        const dte = daysToExpiry(e.expiry);
        if (dte !== null && dte >= 0 && dte <= 7) expiringThisWeek++;
      } else if (e.positionType === "stock") {
        const price = priceMap[e.ticker];
        totalStockValue += (price ?? e.avgPrice) * e.qty;
        totalStockPnL += price ? (price - e.avgPrice) * e.qty : 0;
      } else {
        openOptions++;
      }
    });

    return { totalPremium, totalStockValue, totalStockPnL, openOptions, expiringThisWeek };
  }, [entries, priceMap]);

  // Concentration by notional
  const concentration = useMemo(() => {
    const byTicker: Record<string, number> = {};
    entries.forEach(e => {
      const n = e.positionType === "stock"
        ? (priceMap[e.ticker] ?? e.avgPrice) * e.qty
        : notionalValue(e);
      byTicker[e.ticker] = (byTicker[e.ticker] ?? 0) + n;
    });
    const total = Object.values(byTicker).reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    return Object.entries(byTicker)
      .map(([ticker, val]) => ({ ticker, pct: (val / total) * 100 }))
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 10);
  }, [entries, priceMap]);

  // Upcoming expirations (options only, sorted by date)
  const upcoming = useMemo(() =>
    entries
      .filter(e => isOptionsPosition(e.positionType) && e.expiry)
      .map(e => ({ entry: e, dte: daysToExpiry(e.expiry) }))
      .filter(x => x.dte !== null && x.dte >= 0)
      .sort((a, b) => (a.dte ?? 999) - (b.dte ?? 999))
      .slice(0, 8),
  [entries]);

  if (!isLoaded) return null;

  const TABLE_HEADS = ["Ticker", "Type", "Qty", "Strike / Price", "Value / Premium", "P&L / DTE", ""];

  return (
    <div className="min-h-[100dvh] bg-background text-foreground selection:bg-primary/30 flex">
      <Sidebar />

      <main className="flex-1 ml-[220px] min-w-0">
        {/* Header */}
        <div className="p-5 border-b border-border/50 flex items-center justify-between gap-4 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div>
            <h1 className="text-lg font-bold tracking-tight leading-none">Portfolio</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              {entries.length === 0 ? "No positions yet" : `${entries.length} position${entries.length !== 1 ? "s" : ""} across ${uniqueTickers.length} ticker${uniqueTickers.length !== 1 ? "s" : ""}`}
            </p>
          </div>
          <Button size="sm" onClick={() => setShowAdd(true)} className="gap-1.5 h-8">
            <Plus className="w-3.5 h-3.5" /> Add Position
          </Button>
        </div>

        <div className="p-5 space-y-5">
          {entries.length === 0 ? (
            /* Empty state */
            <div className="flex flex-col items-center justify-center py-28 gap-5 text-center">
              <div className="w-16 h-16 rounded-2xl bg-secondary/50 flex items-center justify-center border border-dashed border-border">
                <TrendingUp className="w-8 h-8 text-muted-foreground/50" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">No positions tracked yet</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  Add your stock and options holdings to track P&L, concentration risk, and upcoming expirations.
                </p>
              </div>
              <Button onClick={() => setShowAdd(true)} className="gap-1.5">
                <Plus className="w-4 h-4" /> Add your first position
              </Button>
            </div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <SummaryCard
                  label="Premium Collected"
                  value={formatCurrency(totalPremium)}
                  sub={`from ${openOptions} option leg${openOptions !== 1 ? "s" : ""}`}
                  icon={<TrendingUp className="w-4 h-4" />}
                />
                <SummaryCard
                  label="Stock Exposure"
                  value={formatLargeNumber(totalStockValue) ?? "—"}
                  sub={totalStockPnL >= 0
                    ? `+${formatCurrency(totalStockPnL)} unrealized`
                    : `${formatCurrency(totalStockPnL)} unrealized`}
                  icon={totalStockPnL >= 0
                    ? <TrendingUp className="w-4 h-4 text-green-400" />
                    : <TrendingDown className="w-4 h-4 text-red-400" />}
                />
                <SummaryCard
                  label="Expiring This Week"
                  value={String(expiringThisWeek)}
                  sub="option legs"
                  icon={<Clock className={cn("w-4 h-4", expiringThisWeek > 0 ? "text-yellow-400" : "")} />}
                />
                <SummaryCard
                  label="Open Legs"
                  value={String(openOptions)}
                  sub="options positions"
                  icon={<TrendingUp className="w-4 h-4" />}
                />
              </div>

              {/* Holdings table */}
              <Card>
                <CardHeader className="pb-2 px-4 pt-4">
                  <CardTitle className="text-sm font-semibold">Holdings</CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-border/40">
                          {TABLE_HEADS.map(h => (
                            <th key={h} className="text-left py-2 px-4 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider last:text-right">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map(entry => (
                          <PositionRow
                            key={entry.id}
                            entry={entry}
                            currentPrice={priceMap[entry.ticker]}
                            onRemove={removeEntry}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Bottom panels */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Concentration */}
                {concentration.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2 px-4 pt-4">
                      <CardTitle className="text-sm font-semibold">Concentration by Notional</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-2">
                      {concentration.map((c, i) => (
                        <ConcentrationBar
                          key={c.ticker}
                          ticker={c.ticker}
                          pct={c.pct}
                          color={
                            i === 0 ? "bg-blue-500" :
                            i === 1 ? "bg-purple-500" :
                            i === 2 ? "bg-green-500" :
                                      "bg-secondary-foreground/30"
                          }
                        />
                      ))}
                      {concentration.length === 1 && (
                        <p className="text-xs text-muted-foreground pt-1">Add more positions to see concentration risk.</p>
                      )}
                    </CardContent>
                  </Card>
                )}

                {/* Upcoming expirations */}
                {upcoming.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2 px-4 pt-4">
                      <CardTitle className="text-sm font-semibold">Upcoming Expirations</CardTitle>
                    </CardHeader>
                    <CardContent className="px-4 pb-4 space-y-2">
                      {upcoming.map(({ entry, dte }) => (
                        <div key={entry.id} className="flex items-center justify-between text-xs py-1 border-b border-border/20 last:border-0">
                          <div className="flex items-center gap-2">
                            <span className="font-mono font-bold">{entry.ticker}</span>
                            <Badge variant="outline" className={cn(
                              "text-[10px]",
                              isShortPosition(entry.positionType)
                                ? "text-green-400 border-green-500/30 bg-green-500/10"
                                : "text-orange-400 border-orange-500/30 bg-orange-500/10"
                            )}>
                              {positionLabel(entry.positionType)}
                            </Badge>
                            {entry.strike && <span className="text-muted-foreground">${entry.strike}</span>}
                          </div>
                          <span className={cn(
                            "font-mono font-semibold",
                            (dte ?? 99) <= 3 ? "text-red-400" :
                            (dte ?? 99) <= 7 ? "text-yellow-400" : "text-muted-foreground"

                          )}>
                            {dte === 0 ? "Today" : `${dte}d`}
                          </span>
                        </div>
                      ))}
                    </CardContent>
                  </Card>
                )}
              </div>
            </>
          )}
        </div>
      </main>

      <AddPositionDialog
        open={showAdd}
        onClose={() => setShowAdd(false)}
        onAdd={addEntry}
      />
    </div>
  );
}
