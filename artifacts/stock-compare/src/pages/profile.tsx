import { useState, useRef, useCallback, useMemo } from "react"
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"
import { useParams, Link, useLocation } from "wouter"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react"
import { TopNav } from "@/components/top-nav"
import { TradeCard, type TradePost } from "@/components/TradeCard"
import { useAuth } from "@/context/AuthContext"
import { useDebounce } from "@/hooks/use-debounce"
import { cn } from "@/lib/utils"
import { X, Search, Loader2 } from "lucide-react"
import { addToScannerShelf } from "@/lib/ticker-shelf-storage"
import { PRESET_COLORS, COLOR_LABELS, fetchWatchlistFor } from "@/hooks/use-watchlist"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"

// ── API helpers ────────────────────────────────────────────────────────────────

async function apiFeed(path: string, opts?: RequestInit) {
  const r = await fetch(`/api/feed${path}`, { credentials: "include", ...opts })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface ProfileData {
  user: { id: number; username: string; avatarUrl: string | null; role: string; createdAt: string }
  stats: { totalPosts: number; openPosts: number; wins: number; losses: number; closed: number; winRate: number | null; totalPnl: number | null }
  posts: TradePost[]
}

interface BucketEntry {
  userId: number
  username: string
  ticker: string
  bucket: "BULLISH" | "NEUTRAL" | "BEARISH"
  addedAt: string
}

// ── Submit form ────────────────────────────────────────────────────────────────

// ── Types for options chain ────────────────────────────────────────────────────
interface OptionRow { strike: number; bid: number; ask: number; iv: number; volume: number | null; openInterest: number | null }
interface OptionsChain { expiry: string; dte: number; calls: OptionRow[]; puts: OptionRow[] }

const TRADE_TYPES = [
  { id: "SELL_PUT",  label: "Sell Put",  cat: "option" },
  { id: "BUY_PUT",   label: "Buy Put",   cat: "option" },
  { id: "SELL_CALL", label: "Sell Call", cat: "option" },
  { id: "BUY_CALL",  label: "Buy Call",  cat: "option" },
  { id: "LONG",      label: "Long",      cat: "equity" },
  { id: "SHORT",     label: "Short",     cat: "equity" },
] as const

type TradeTypeId = typeof TRADE_TYPES[number]["id"]

const CONFIDENCE_OPTS = ["Speculative", "Low", "Moderate", "High", "Strong"]
const CONF_COLORS = ["text-muted-foreground border-border bg-secondary", "text-orange-400 border-orange-500/40 bg-orange-500/15", "text-yellow-400 border-yellow-500/40 bg-yellow-500/15", "text-green-400 border-green-500/40 bg-green-500/15", "text-emerald-400 border-emerald-500/40 bg-emerald-500/15"]

function SubmitForm({ onSuccess }: { onSuccess: () => void }) {
  const [tradeType, setTradeType] = useState<TradeTypeId>("SELL_PUT")
  const [ticker,     setTicker]    = useState("")
  const [confidence, setConf]      = useState(0)
  const [notes,      setNotes]     = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]     = useState<string | null>(null)
  const [success,    setSuccess]   = useState(false)

  // Options fields
  const [selectedExpiry, setSelectedExpiry] = useState("")
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null)
  const [selectedPremium, setSelectedPremium] = useState<number | null>(null)
  const [contracts, setContracts] = useState("1")

  // Equity fields
  const [entryPrice,   setEntryPrice]   = useState("")
  const [shares,       setShares]       = useState("1")
  const [stopLoss,     setStopLoss]     = useState("")
  const [targetPrice,  setTargetPrice]  = useState("")

  const isOption = ["SELL_PUT","BUY_PUT","SELL_CALL","BUY_CALL"].includes(tradeType)
  const chainSide = tradeType.includes("PUT") ? "puts" : "calls"

  // Fetch options chain when ticker set and trade is option type
  const { data: chains, isFetching: chainLoading } = useQuery<OptionsChain[]>({
    queryKey: ["options-chain", ticker],
    queryFn: () => fetch(`/api/options/${ticker}`, { credentials: "include" }).then(r => r.json()),
    enabled: isOption && ticker.length >= 1,
    staleTime: 15 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  })

  // Auto-select first expiry when chain loads
  const expiryChains = chains ?? []
  const activeChain = expiryChains.find(c => c.expiry === selectedExpiry) ?? expiryChains[0]

  function selectExpiry(exp: string) {
    setSelectedExpiry(exp)
    setSelectedStrike(null)
    setSelectedPremium(null)
  }

  function selectRow(strike: number, bid: number, ask: number) {
    setSelectedStrike(strike)
    setSelectedPremium(parseFloat(((bid + ask) / 2).toFixed(2)))
  }

  function reset() {
    setTicker(""); setConf(0); setNotes("")
    setSelectedExpiry(""); setSelectedStrike(null); setSelectedPremium(null); setContracts("1")
    setEntryPrice(""); setShares("1"); setStopLoss(""); setTargetPrice("")
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!confidence) { setError("Select a confidence level"); return }
    if (isOption && !selectedStrike) { setError("Select a strike from the chain"); return }
    setSubmitting(true); setError(null)
    try {
      const body: Record<string, unknown> = { ticker, tradeType, confidence, notes: notes || undefined }
      if (isOption) {
        body.strike = selectedStrike
        body.expiry = selectedExpiry || activeChain?.expiry
        body.contracts = parseInt(contracts)
        body.premiumPerContract = selectedPremium
      } else {
        body.entryPrice = parseFloat(entryPrice)
        body.shares = parseInt(shares)
        if (stopLoss)    body.stopLoss    = parseFloat(stopLoss)
        if (targetPrice) body.targetPrice = parseFloat(targetPrice)
      }
      const r = await fetch("/api/feed/posts", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!r.ok) { const d = await r.json(); setError(d.error ?? "Submit failed"); return }
      setSuccess(true)
      setTimeout(() => { setSuccess(false); reset(); onSuccess() }, 1200)
    } finally { setSubmitting(false) }
  }

  const inp = "w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"

  return (
    <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-4 space-y-4 mb-4">
      <div className="text-sm font-semibold text-foreground">New Trade Idea</div>

      {/* Trade type tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TRADE_TYPES.map(t => (
          <button key={t.id} type="button" onClick={() => { setTradeType(t.id); setSelectedStrike(null); setSelectedPremium(null); setSelectedExpiry("") }}
            className={cn("text-xs px-2.5 py-1 rounded-full border font-medium transition-all",
              tradeType === t.id
                ? t.cat === "option" ? "bg-blue-500/20 text-blue-400 border-blue-500/40" : "bg-purple-500/20 text-purple-400 border-purple-500/40"
                : "bg-transparent text-muted-foreground border-border opacity-50 hover:opacity-80"
            )}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Ticker search (reuses BucketTickerInput pattern inline) */}
      <TickerSearch value={ticker} onChange={t => { setTicker(t); setSelectedExpiry(""); setSelectedStrike(null); setSelectedPremium(null) }} />

      {/* ── OPTIONS: expiry tabs + strike chain ── */}
      {isOption && ticker && (
        <div className="space-y-2">
          {chainLoading && <p className="text-xs text-muted-foreground animate-pulse">Loading chain…</p>}
          {!chainLoading && expiryChains.length > 0 && (
            <>
              {/* Expiry selector */}
              <div className="flex gap-1.5 flex-wrap">
                {expiryChains.slice(0, 6).map(c => (
                  <button key={c.expiry} type="button" onClick={() => selectExpiry(c.expiry)}
                    className={cn("text-[10px] px-2 py-0.5 rounded border transition-all",
                      (selectedExpiry || expiryChains[0]?.expiry) === c.expiry
                        ? "bg-primary/20 text-primary border-primary/40"
                        : "text-muted-foreground border-border hover:border-muted-foreground"
                    )}>
                    {c.expiry} <span className="opacity-60">{c.dte}d</span>
                  </button>
                ))}
              </div>

              {/* Strike table */}
              {activeChain && (
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-[10px] text-muted-foreground uppercase tracking-wider border-b border-border bg-muted/20">
                        <th className="text-left px-2 py-1.5 font-semibold">Strike</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Bid</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Ask</th>
                        <th className="text-right px-2 py-1.5 font-semibold">Mid</th>
                        <th className="text-right px-2 py-1.5 font-semibold">IV</th>
                        <th className="text-right px-2 py-1.5 font-semibold">OI</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(activeChain[chainSide] ?? []).map(row => {
                        const mid = ((row.bid + row.ask) / 2).toFixed(2)
                        const isSelected = selectedStrike === row.strike
                        return (
                          <tr key={row.strike}
                            onClick={() => selectRow(row.strike, row.bid, row.ask)}
                            className={cn("cursor-pointer border-b border-border/40 h-8 transition-colors",
                              isSelected ? "bg-primary/15 text-primary" : "hover:bg-muted/20"
                            )}>
                            <td className="px-2 font-bold tabular-nums">{row.strike}</td>
                            <td className="px-2 text-right tabular-nums text-muted-foreground">{row.bid.toFixed(2)}</td>
                            <td className="px-2 text-right tabular-nums text-muted-foreground">{row.ask.toFixed(2)}</td>
                            <td className="px-2 text-right tabular-nums font-semibold">{mid}</td>
                            <td className="px-2 text-right tabular-nums text-muted-foreground">{(row.iv * 100).toFixed(0)}%</td>
                            <td className="px-2 text-right tabular-nums text-muted-foreground">{row.openInterest ?? "—"}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Selected summary + contracts */}
              {selectedStrike != null && (
                <div className="flex items-center gap-3 bg-primary/10 border border-primary/30 rounded-lg px-3 py-2">
                  <span className="text-xs font-bold text-primary">{tradeType.replace("_"," ")} {selectedStrike} @ ${selectedPremium}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <label className="text-xs text-muted-foreground">Contracts</label>
                    <input type="number" min="1" step="1" value={contracts} onChange={e => setContracts(e.target.value)}
                      className="w-14 bg-secondary border border-border rounded px-2 py-1 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ── EQUITY fields ── */}
      {!isOption && (
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Entry Price", val: entryPrice, set: setEntryPrice, placeholder: "150.00", required: true },
            { label: "Shares",      val: shares,     set: setShares,     placeholder: "10",     required: true, step: "1", min: "1" },
            { label: "Stop Loss",   val: stopLoss,   set: setStopLoss,   placeholder: "optional" },
            { label: "Target",      val: targetPrice, set: setTargetPrice, placeholder: "optional" },
          ].map(({ label, val, set, placeholder, required, step, min }) => (
            <div key={label} className="space-y-1">
              <label className="text-xs text-muted-foreground">{label}</label>
              <input required={required} type="number" min={min ?? "0"} step={step ?? "0.01"}
                value={val} onChange={e => set(e.target.value)} placeholder={placeholder}
                className={inp} />
            </div>
          ))}
        </div>
      )}

      {/* Confidence */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Confidence</label>
        <div className="flex gap-1.5 flex-wrap">
          {CONFIDENCE_OPTS.map((label, i) => (
            <button key={i} type="button" onClick={() => setConf(i + 1)}
              className={cn("text-xs px-2.5 py-1 rounded-full border font-medium transition-all",
                CONF_COLORS[i],
                confidence !== i + 1 && "opacity-40 hover:opacity-70"
              )}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Rationale</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          placeholder="Your rationale…"
          className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {success && <div className="text-xs text-green-400">Trade idea posted!</div>}

      <button type="submit" disabled={submitting || (isOption && !selectedStrike) || !ticker}
        className="bg-primary text-primary-foreground text-sm px-4 py-1.5 rounded hover:bg-primary/90 transition-colors disabled:opacity-40">
        {submitting ? "Posting…" : "Post Idea"}
      </button>
    </form>
  )
}

// ── Inline ticker search for SubmitForm ────────────────────────────────────────
function TickerSearch({ value, onChange }: { value: string; onChange: (t: string) => void }) {
  const [input, setInput]   = useState(value)
  const [open, setOpen]     = useState(false)
  const debouncedQ          = useDebounce(input, 180)
  const { data: results = [], isFetching } = useSearchStocks(
    { q: debouncedQ },
    { query: { enabled: debouncedQ.length >= 1, staleTime: 5 * 60 * 1000, gcTime: 10 * 60 * 1000,
        queryKey: getSearchStocksQueryKey({ q: debouncedQ }) } }
  )
  function pick(ticker: string) { onChange(ticker); setInput(ticker); setOpen(false) }
  return (
    <div className="relative space-y-1">
      <label className="text-xs text-muted-foreground">Ticker</label>
      <input value={input}
        onChange={e => { setInput(e.target.value.toUpperCase()); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search ticker…"
        className="w-full bg-white border border-white/20 rounded px-2 py-1.5 text-sm text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-primary" />
      {open && debouncedQ.length >= 1 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-card border border-border rounded-lg shadow-xl overflow-hidden max-h-40 overflow-y-auto">
          {isFetching && <div className="px-3 py-2 text-xs text-muted-foreground animate-pulse">Searching…</div>}
          {!isFetching && results.length === 0 && <div className="px-3 py-2 text-xs text-muted-foreground">No results</div>}
          {results.map((r: { ticker: string; name?: string }) => (
            <button key={r.ticker} type="button" onMouseDown={() => pick(r.ticker)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/40 transition-colors text-left">
              <span className="font-bold text-foreground w-14 shrink-0">{r.ticker}</span>
              <span className="text-muted-foreground truncate">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Stock Views panel (reflects the user's tagged Watchlist) ───────────────────

function StockViewsPanel({ isOwner, profileUsername }: { isOwner: boolean; profileUsername: string }) {
  const [, navigate] = useLocation()
  const [open, setOpen] = useState(false)

  const { data: entries = [], isLoading } = useQuery({
    queryKey: ["watchlist", "user", profileUsername],
    queryFn: () => fetchWatchlistFor(profileUsername),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  })

  // Only the 5 labeled colors from the Watchlist legend — the 6th preset (orange) has no label there either.
  const groups = PRESET_COLORS
    .filter(color => COLOR_LABELS[color])
    .map(color => ({
      color,
      label: COLOR_LABELS[color]!,
      tickers: entries.filter(e => e.colorTag === color).map(e => e.ticker).sort(),
    }))

  const taggedCount = groups.reduce((n, g) => n + g.tickers.length, 0)

  function openInScanner(tickers: string[]) {
    tickers.forEach(t => addToScannerShelf(t))
    navigate("/options-scanner")
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full text-left space-y-2 rounded-xl border border-border p-3 hover:border-border/80 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stock Views</div>
          <span className="text-[10px] text-muted-foreground">{taggedCount} tagged →</span>
        </div>
        {isLoading ? (
          <span className="text-[10px] text-muted-foreground animate-pulse">Loading…</span>
        ) : taggedCount === 0 ? (
          <span className="text-[10px] text-muted-foreground">No tagged tickers yet</span>
        ) : (
          <div className="flex flex-wrap gap-2">
            {groups.filter(g => g.tickers.length > 0).map(g => (
              <span key={g.color} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                {g.tickers.slice(0, 3).join(", ")}{g.tickers.length > 3 ? ` +${g.tickers.length - 3}` : ""}
              </span>
            ))}
          </div>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Stock Views{!isOwner ? ` — ${profileUsername}` : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 max-h-[60vh] overflow-y-auto">
            {groups.map(g => (
              <div key={g.color} className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                  {g.label}
                  <span className="ml-auto text-[10px] font-normal text-muted-foreground">{g.tickers.length}</span>
                </div>
                {g.tickers.length === 0 ? (
                  <span className="text-[10px] text-muted-foreground">None</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {g.tickers.map(ticker => (
                      <span
                        key={ticker}
                        className="text-xs font-bold px-1.5 py-0.5 rounded border"
                        style={{ borderColor: g.color, color: g.color, backgroundColor: `${g.color}15` }}
                      >
                        {ticker}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
          {taggedCount > 0 && (
            <button
              onClick={() => openInScanner(groups.flatMap(g => g.tickers))}
              className="w-full text-[10px] font-medium text-muted-foreground hover:text-foreground border border-border/60 hover:border-border rounded px-1.5 py-1.5 transition-colors"
            >
              Open all in scanner →
            </button>
          )}
          {isOwner && (
            <button
              onClick={() => navigate("/watchlist")}
              className="w-full text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              Edit tags on Watchlist →
            </button>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

// ── Compact stats bar ──────────────────────────────────────────────────────────

/** Most recent run of same-outcome closed trades, newest-first. Empty posts array (or all-open) → null. */
function computeStreak(posts: TradePost[]): { n: number; win: boolean } | null {
  const resolved = posts
    .filter(p => p.status !== "OPEN" && p.resolvedPnl != null)
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
  if (resolved.length === 0) return null
  const first = (resolved[0]!.resolvedPnl ?? 0) >= 0
  let n = 0
  for (const p of resolved) {
    const win = (p.resolvedPnl ?? 0) >= 0
    if (win !== first) break
    n++
  }
  return { n, win: first }
}

function StatsBar({ stats, posts }: { stats: ProfileData["stats"]; posts: TradePost[] }) {
  const lowSample = stats.closed < 5
  const winRateColor = stats.winRate == null ? "text-muted-foreground" : stats.winRate >= 0.6 ? "text-green-400" : stats.winRate >= 0.4 ? "text-yellow-400" : "text-red-400"
  const pnlColor = stats.totalPnl == null ? "text-muted-foreground" : stats.totalPnl >= 0 ? "text-green-400" : "text-red-400"
  const pnl = stats.totalPnl != null ? (stats.totalPnl >= 0 ? `+$${stats.totalPnl.toFixed(0)}` : `-$${Math.abs(stats.totalPnl).toFixed(0)}`) : "—"
  const avgPnl = stats.closed > 0 && stats.totalPnl != null ? stats.totalPnl / stats.closed : null
  const streak = computeStreak(posts)

  const items = [
    {
      label: "Win Rate",
      value: stats.winRate != null ? `${Math.round(stats.winRate * 100)}%` : "—",
      sub: `${stats.wins}-${stats.losses}`,
      color: winRateColor,
      dim: lowSample,
    },
    { label: "Total P&L", value: pnl, sub: `${stats.closed} closed`, color: pnlColor, dim: lowSample },
    {
      label: "Avg/Trade",
      value: avgPnl != null ? (avgPnl >= 0 ? `+$${avgPnl.toFixed(0)}` : `-$${Math.abs(avgPnl).toFixed(0)}`) : "—",
      sub: "per closed",
      color: avgPnl == null ? "text-muted-foreground" : avgPnl >= 0 ? "text-green-400" : "text-red-400",
      dim: lowSample,
    },
    { label: "Open", value: String(stats.openPosts), sub: `${stats.totalPosts} total`, color: "text-blue-400", dim: false },
    {
      label: "Streak",
      value: streak ? `${streak.win ? "W" : "L"}${streak.n}` : "—",
      sub: streak ? (streak.win ? "winning" : "losing") : "no closed trades",
      color: !streak ? "text-muted-foreground" : streak.win ? "text-green-400" : "text-red-400",
      dim: false,
    },
  ]

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="flex items-stretch gap-0">
        {items.map(({ label, value, sub, color, dim }, i) => (
          <div key={label} className={cn(
            "flex-1 flex flex-col items-center py-2.5 px-1 min-w-0",
            i < items.length - 1 && "border-r border-border",
            dim && "opacity-70"
          )}>
            <div className={cn("text-base font-bold leading-tight tabular-nums", color)}>{value}</div>
            <div className="text-[10px] text-foreground/60 uppercase tracking-wide mt-0.5">{label}</div>
            <div className="text-[10px] text-muted-foreground mt-px truncate max-w-full">{sub}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Cumulative P&L chart ─────────────────────────────────────────────────────

function CumulativePnlChart({ posts }: { posts: TradePost[] }) {
  const timeline = useMemo(() => {
    const resolved = posts
      .filter(p => p.status !== "OPEN" && p.resolvedPnl != null)
      .slice()
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    let running = 0
    return resolved.map(p => {
      running += p.resolvedPnl ?? 0
      return { date: p.createdAt, cumulative: running, ticker: p.ticker }
    })
  }, [posts])

  const total = timeline.length > 0 ? timeline[timeline.length - 1]!.cumulative : 0

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-foreground/80 uppercase tracking-wider">Cumulative P&L</div>
        {timeline.length > 0 && (
          <span className={cn("text-xs font-bold tabular-nums", total >= 0 ? "text-green-400" : "text-red-400")}>
            {total >= 0 ? "+" : ""}${total.toFixed(0)}
          </span>
        )}
      </div>
      {timeline.length === 0 ? (
        <div className="h-[120px] flex items-center justify-center text-xs text-muted-foreground">No closed trades yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={120}>
          <AreaChart data={timeline} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="profilePnlFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={total >= 0 ? "#34d399" : "#f87171"} stopOpacity={0.35} />
                <stop offset="100%" stopColor={total >= 0 ? "#34d399" : "#f87171"} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis dataKey="date" hide />
            <YAxis hide domain={["auto", "auto"]} />
            <Tooltip content={(p) => {
              const d = p.payload?.[0]?.payload as { date: string; cumulative: number; ticker: string } | undefined
              if (!p.active || !d) return null
              return (
                <div className="bg-popover border border-border rounded-lg px-2.5 py-1.5 shadow-xl text-xs space-y-0.5">
                  <div className="text-foreground/70">{new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {d.ticker}</div>
                  <div className={cn("font-bold tabular-nums", d.cumulative >= 0 ? "text-green-400" : "text-red-400")}>
                    {d.cumulative >= 0 ? "+" : ""}${d.cumulative.toFixed(0)}
                  </div>
                </div>
              )
            }} />
            <Area type="monotone" dataKey="cumulative" stroke={total >= 0 ? "#34d399" : "#f87171"} strokeWidth={1.5} fill="url(#profilePnlFill)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ── Top tickers breakdown ────────────────────────────────────────────────────

function TopTickers({ posts }: { posts: TradePost[] }) {
  const rows = useMemo(() => {
    const map = new Map<string, { ticker: string; count: number; wins: number; losses: number }>()
    for (const p of posts) {
      const entry = map.get(p.ticker) ?? { ticker: p.ticker, count: 0, wins: 0, losses: 0 }
      entry.count++
      if (p.status !== "OPEN" && p.resolvedPnl != null) {
        if (p.resolvedPnl >= 0) entry.wins++
        else entry.losses++
      }
      map.set(p.ticker, entry)
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 5)
  }, [posts])

  return (
    <div className="bg-card border border-border rounded-xl p-3 space-y-1.5">
      <div className="text-xs font-semibold text-foreground/80 uppercase tracking-wider">Top Tickers</div>
      {rows.length === 0 ? (
        <div className="h-[120px] flex items-center justify-center text-xs text-muted-foreground">No trade ideas yet</div>
      ) : (
        <div className="space-y-1.5">
          {rows.map(r => {
            const resolved = r.wins + r.losses
            const winRate = resolved > 0 ? r.wins / resolved : null
            const wrColor = winRate == null ? "text-muted-foreground" : winRate >= 0.6 ? "text-green-400" : winRate >= 0.4 ? "text-yellow-400" : "text-red-400"
            return (
              <div key={r.ticker} className="flex items-center gap-2 text-xs">
                <span className="font-bold text-white bg-white/10 px-1.5 py-0.5 rounded w-14 text-center shrink-0">{r.ticker}</span>
                <div className="flex-1 h-1.5 rounded-full bg-secondary overflow-hidden">
                  {resolved > 0 && (
                    <div
                      className={cn("h-full rounded-full", winRate! >= 0.6 ? "bg-green-400" : winRate! >= 0.4 ? "bg-yellow-400" : "bg-red-400")}
                      style={{ width: `${Math.round(winRate! * 100)}%` }}
                    />
                  )}
                </div>
                <span className={cn("font-semibold tabular-nums shrink-0 w-9 text-right", wrColor)}>
                  {winRate != null ? `${Math.round(winRate * 100)}%` : "—"}
                </span>
                <span className="text-muted-foreground tabular-nums shrink-0 w-6 text-right">{r.count}×</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── Monthly summary (own profile) ───────────────────────────────────────────────

function MonthlySummary({ posts }: { posts: TradePost[] }) {
  const months = new Map<string, { wins: number; losses: number; pnl: number }>()

  for (const post of posts) {
    if (post.status === "OPEN") continue
    const d = new Date(post.createdAt)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`
    const entry = months.get(key) ?? { wins: 0, losses: 0, pnl: 0 }
    const pnl = post.resolvedPnl ?? 0
    if (pnl >= 0) entry.wins++
    else entry.losses++
    entry.pnl += pnl
    months.set(key, entry)
  }

  const rows = [...months.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 6)
  if (rows.length === 0) return null

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Monthly Summary</div>
      <div className="bg-card border border-border rounded-xl divide-y divide-border">
        {rows.map(([key, { wins, losses, pnl }]) => {
          const [y, m] = key.split("-")
          const label = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString(undefined, { month: "short", year: "numeric" })
          const n = wins + losses
          return (
            <div key={key} className="flex items-center justify-between px-3 py-2 text-xs">
              <span className="text-foreground font-medium">{label}</span>
              <div className="flex items-center gap-3 text-muted-foreground">
                <span>{wins}W / {losses}L</span>
                <span className={cn("font-semibold", pnl >= 0 ? "text-green-400" : "text-red-400")}>
                  {pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}
                </span>
                <span className="text-muted-foreground">({n})</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Profile page ──────────────────────────────────────────────────────────────

export default function Profile() {
  const { username: routeUsername } = useParams<{ username: string }>()
  const { user: me } = useAuth()
  const qc = useQueryClient()
  const username = routeUsername === "me" ? (me?.username ?? "") : routeUsername
  const [showForm, setShowForm] = useState(false)

  const { data, isLoading, error } = useQuery<ProfileData>({
    queryKey: ["feed", "profile", username],
    queryFn: () => apiFeed(`/profile/${username}`),
    enabled: !!username,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  })

  const isOwnerProfile = !!me && data?.user.username === me.username

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["feed", "profile", username] })
  }

  async function handleLike(postId: number)    { await apiFeed(`/posts/${postId}/like`,    { method: "POST" });  invalidate() }
  async function handleUnlike(postId: number)  { await apiFeed(`/posts/${postId}/like`,    { method: "DELETE" }); invalidate() }
  async function handleComment(postId: number, body: string) {
    await apiFeed(`/posts/${postId}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) })
    invalidate()
  }
  async function handleClose(postId: number, closePremium: number) {
    await apiFeed(`/posts/${postId}/close`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ closePremium }) })
    invalidate()
  }
  async function handleDelete(postId: number) {
    await apiFeed(`/posts/${postId}`, { method: "DELETE" })
    invalidate()
  }

  return (
    <div className="min-h-[100dvh] bg-background">
      <TopNav />
      <main className="pt-14 p-5 max-w-2xl space-y-5">

        {!isOwnerProfile && me && (
          <Link href="/profile/me" className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0">
            ← My Profile
          </Link>
        )}

        {isLoading && <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>}
        {error    && <div className="text-sm text-red-400">Failed to load profile.</div>}

        {data && (
          <>
            {/* ── Compact user header ── */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                {/* Avatar */}
                <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center text-sm font-bold text-primary shrink-0 ring-2 ring-primary/30">
                  {data.user.avatarUrl
                    ? <img src={data.user.avatarUrl} alt={data.user.username} className="w-9 h-9 rounded-full object-cover" />
                    : data.user.username[0]?.toUpperCase()
                  }
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-lg font-bold text-foreground leading-none">{data.user.username}</span>
                  <span className={cn(
                    "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
                    data.user.role === "admin"
                      ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                      : "bg-secondary text-muted-foreground border-border"
                  )}>
                    {data.user.role}
                  </span>
                </div>
              </div>

              {/* Post button */}
              {isOwnerProfile && (
                <button
                  onClick={() => setShowForm(v => !v)}
                  className={cn(
                    "text-xs px-3 py-1.5 rounded-lg border font-medium transition-all",
                    showForm
                      ? "bg-secondary text-muted-foreground border-border"
                      : "bg-primary/15 text-primary border-primary/30 hover:bg-primary/25"
                  )}
                >
                  {showForm ? "Cancel" : "+ Trade Idea"}
                </button>
              )}
            </div>

            {/* ── Stats bar ── */}
            <StatsBar stats={data.stats} posts={data.posts} />

            {/* ── Cumulative P&L + Top Tickers ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <CumulativePnlChart posts={data.posts} />
              <TopTickers posts={data.posts} />
            </div>

            {/* ── Monthly summary (own profile only) ── */}
            {isOwnerProfile && <MonthlySummary posts={data.posts} />}

            {/* ── Stock Views (reflects tagged Watchlist) ── */}
            <StockViewsPanel isOwner={isOwnerProfile} profileUsername={username} />

            {/* ── Submit form ── */}
            {isOwnerProfile && showForm && (
              <SubmitForm onSuccess={() => { setShowForm(false); invalidate() }} />
            )}

            {/* ── Trade ideas ── */}
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-foreground/80 uppercase tracking-wider">
                Trade Ideas
                {data.posts.length > 0 && <span className="ml-1.5 text-muted-foreground">({data.posts.length})</span>}
              </div>

              {data.posts.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-8 bg-card border border-border rounded-xl">
                  No trade ideas posted yet.
                </div>
              ) : (
                <div className="space-y-2">
                  {data.posts.map(post => (
                    <TradeCard
                      key={post.id}
                      post={post}
                      showUser={false}
                      isOwner={!!me && post.username === me.username}
                      onLike={() => handleLike(post.id)}
                      onUnlike={() => handleUnlike(post.id)}
                      onComment={body => handleComment(post.id, body)}
                      onClose={cp => handleClose(post.id, cp)}
                      onDelete={() => handleDelete(post.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
