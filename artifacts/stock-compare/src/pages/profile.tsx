import { useState, useRef, useCallback, useMemo, Fragment } from "react"
import { AreaChart, Area, BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts"
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
import { TickerCallOptionsModal } from "@/components/TickerCallOptionsModal"

// ── API helpers ────────────────────────────────────────────────────────────────

async function apiFeed(path: string, opts?: RequestInit) {
  const r = await fetch(`/api/feed${path}`, { credentials: "include", ...opts })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

// ── Types ──────────────────────────────────────────────────────────────────────

interface StockHolding {
  id: number
  ticker: string
  shares: number
  costBasis: number
  source: "PUT_ASSIGNMENT" | "LONG_TRADE" | "SHORT_TRADE"
  status: "OPEN" | "CALLED_AWAY" | "CLOSED"
  notes: string | null
  openedAt: string
  closedAt: string | null
  realizedPnl: number | null
  currentPrice: number | null
  unrealizedPnl: number | null
  availableForCall: number
}

interface TickerPnl {
  ticker: string
  realizedPnl: number
  unrealizedPnl: number
  totalPnl: number
}

interface ProfileData {
  user: { id: number; username: string; avatarUrl: string | null; role: string; createdAt: string }
  account: { cashBalance: number; buyingPower: number }
  stats: { totalPosts: number; openPosts: number; wins: number; losses: number; closed: number; winRate: number | null; totalPnl: number | null; unrealizedPnl: number }
  posts: TradePost[]
  holdings: StockHolding[]
  tickerPnl: TickerPnl[]
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
const CONF_COLORS = ["text-white/70 border-[#d4af37]/20 bg-zinc-900", "text-orange-400 border-orange-500/40 bg-orange-500/15", "text-yellow-400 border-yellow-500/40 bg-yellow-500/15", "text-green-400 border-green-500/40 bg-green-500/15", "text-emerald-400 border-emerald-500/40 bg-emerald-500/15"]

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

  const inp = "w-full bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50"

  return (
    <form onSubmit={handleSubmit} className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-2 mb-2">
      <div className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">New Trade Idea</div>

      {/* Trade type tabs */}
      <div className="flex flex-wrap gap-1.5">
        {TRADE_TYPES.map(t => (
          <button key={t.id} type="button" onClick={() => { setTradeType(t.id); setSelectedStrike(null); setSelectedPremium(null); setSelectedExpiry("") }}
            className={cn("text-[11px] font-semibold px-2.5 py-1 rounded-full border transition-all",
              tradeType === t.id
                ? "bg-[#d4af37] text-black border-[#d4af37]"
                : "bg-zinc-950 text-white/70 border-[#d4af37]/20 hover:text-[#d4af37]"
            )}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Ticker search (reuses BucketTickerInput pattern inline) */}
      <TickerSearch value={ticker} onChange={t => { setTicker(t); setSelectedExpiry(""); setSelectedStrike(null); setSelectedPremium(null) }} />

      {/* ── OPTIONS: expiry tabs + strike chain ── */}
      {isOption && ticker && (
        <div className="space-y-1.5">
          {chainLoading && <p className="text-xs text-white/70 animate-pulse">Loading chain…</p>}
          {!chainLoading && expiryChains.length > 0 && (
            <>
              {/* Expiry selector */}
              <div className="flex gap-1.5 flex-wrap">
                {expiryChains.slice(0, 6).map(c => (
                  <button key={c.expiry} type="button" onClick={() => selectExpiry(c.expiry)}
                    className={cn("text-[10px] px-2 py-0.5 rounded border transition-all",
                      (selectedExpiry || expiryChains[0]?.expiry) === c.expiry
                        ? "bg-[#d4af37] text-black border-[#d4af37]"
                        : "text-white/70 border-[#d4af37]/20 hover:text-[#d4af37]"
                    )}>
                    {c.expiry} <span className="opacity-60">{c.dte}d</span>
                  </button>
                ))}
              </div>

              {/* Strike table */}
              {activeChain && (
                <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
                  <table className="w-full text-xs">
                    <thead className="bg-black text-[#d4af37]">
                      <tr className="border-b border-[#d4af37]/25">
                        <th className="text-left font-semibold text-[10px] uppercase tracking-wider px-2 py-1.5">Strike</th>
                        <th className="text-right font-semibold text-[10px] uppercase tracking-wider px-2 py-1.5">Bid</th>
                        <th className="text-right font-semibold text-[10px] uppercase tracking-wider px-2 py-1.5">Ask</th>
                        <th className="text-right font-semibold text-[10px] uppercase tracking-wider px-2 py-1.5">Mid</th>
                        <th className="text-right font-semibold text-[10px] uppercase tracking-wider px-2 py-1.5">IV</th>
                        <th className="text-right font-semibold text-[10px] uppercase tracking-wider px-2 py-1.5">OI</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {(activeChain[chainSide] ?? []).map(row => {
                        const mid = ((row.bid + row.ask) / 2).toFixed(2)
                        const isSelected = selectedStrike === row.strike
                        return (
                          <tr key={row.strike}
                            onClick={() => selectRow(row.strike, row.bid, row.ask)}
                            className={cn("cursor-pointer h-8 transition-colors bg-zinc-900/70 even:bg-zinc-800/60",
                              isSelected ? "bg-amber-500/15 text-[#d4af37]" : "hover:bg-amber-500/10"
                            )}>
                            <td className="px-2 font-mono font-bold text-white">{row.strike}</td>
                            <td className="px-2 text-right font-mono text-sky-300/80">{row.bid.toFixed(2)}</td>
                            <td className="px-2 text-right font-mono text-sky-300/80">{row.ask.toFixed(2)}</td>
                            <td className="px-2 text-right font-mono font-semibold text-white">{mid}</td>
                            <td className="px-2 text-right font-mono text-sky-300/80">{(row.iv * 100).toFixed(0)}%</td>
                            <td className="px-2 text-right font-mono text-sky-300/80">{row.openInterest ?? "—"}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Selected summary + contracts */}
              {selectedStrike != null && (
                <div className="flex items-center gap-3 bg-amber-500/10 border border-[#d4af37]/30 rounded px-3 py-2">
                  <span className="text-xs font-bold text-[#d4af37]">{tradeType.replace("_"," ")} {selectedStrike} @ ${selectedPremium}</span>
                  <div className="ml-auto flex items-center gap-1.5">
                    <label className="text-xs text-white/70">Contracts</label>
                    <input type="number" min="1" step="1" value={contracts} onChange={e => setContracts(e.target.value)}
                      className="w-14 bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1 text-xs text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50" />
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
              <label className="text-xs text-white/70">{label}</label>
              <input required={required} type="number" min={min ?? "0"} step={step ?? "0.01"}
                value={val} onChange={e => set(e.target.value)} placeholder={placeholder}
                className={inp} />
            </div>
          ))}
        </div>
      )}

      {/* Confidence */}
      <div className="space-y-1">
        <label className="text-xs text-white/70">Confidence</label>
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
        <label className="text-xs text-white/70">Rationale</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
          placeholder="Your rationale…"
          className="w-full bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50 resize-none" />
      </div>

      {error && <div className="text-xs text-red-400">{error}</div>}
      {success && <div className="text-xs text-green-400">Trade idea posted!</div>}

      <button type="submit" disabled={submitting || (isOption && !selectedStrike) || !ticker}
        className="bg-[#d4af37] text-black text-sm font-semibold px-4 py-1.5 rounded hover:bg-[#d4af37]/90 transition-colors disabled:opacity-40">
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
      <label className="text-xs text-white/70">Ticker</label>
      <input value={input}
        onChange={e => { setInput(e.target.value.toUpperCase()); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search ticker…"
        className="w-full bg-white border border-[#d4af37]/30 rounded px-2 py-1.5 text-sm text-black placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-[#d4af37]/50" />
      {open && debouncedQ.length >= 1 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-zinc-950 border border-[#d4af37]/25 rounded-md shadow-xl overflow-hidden max-h-40 overflow-y-auto">
          {isFetching && <div className="px-3 py-2 text-xs text-white/70 animate-pulse">Searching…</div>}
          {!isFetching && results.length === 0 && <div className="px-3 py-2 text-xs text-white/70">No results</div>}
          {results.map((r: { ticker: string; name?: string }) => (
            <button key={r.ticker} type="button" onMouseDown={() => pick(r.ticker)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-amber-500/10 transition-colors text-left">
              <span className="font-bold text-white w-14 shrink-0">{r.ticker}</span>
              <span className="text-white/70 truncate">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Stock Views panel (reflects the user's tagged Watchlist) ───────────────────

/** Readable text color for a solid-color tile background (yellow needs black, the rest read fine in white). */
function boxTextColor(hex: string): string {
  return hex.toLowerCase() === "#eab308" ? "#000" : "#fff"
}

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
        className="w-full text-left space-y-1.5 rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 hover:border-[#d4af37]/40 transition-colors"
      >
        <div className="flex items-center justify-between">
          <div className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Stock Views</div>
          <span className="text-[10px] text-white/70">{taggedCount} tagged →</span>
        </div>
        {isLoading ? (
          <span className="text-[10px] text-white/70 animate-pulse">Loading…</span>
        ) : taggedCount === 0 ? (
          <span className="text-[10px] text-white/70">No tagged tickers yet</span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {groups.map(g => (
              <div
                key={g.color}
                className="flex-1 min-w-[110px] rounded-md border overflow-hidden"
                style={{ borderColor: `${g.color}55` }}
              >
                <div className="flex items-center gap-1 px-1.5 py-1" style={{ backgroundColor: `${g.color}30` }}>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                  <span className="text-[9px] font-bold uppercase tracking-wide text-white truncate">{g.label}</span>
                  <span className="ml-auto text-[9px] font-mono text-white/70 shrink-0">{g.tickers.length}</span>
                </div>
                <div className="flex flex-wrap gap-1 p-1.5 min-h-[26px] bg-zinc-950">
                  {g.tickers.length === 0 ? (
                    <span className="text-[9px] text-white/50">—</span>
                  ) : (
                    <>
                      {g.tickers.slice(0, 6).map(ticker => (
                        <span
                          key={ticker}
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded text-white"
                          style={{ backgroundColor: `${g.color}40` }}
                        >
                          {ticker}
                        </span>
                      ))}
                      {g.tickers.length > 6 && (
                        <span className="text-[10px] font-bold text-white/70 px-1.5 py-0.5 rounded bg-white/10">
                          +{g.tickers.length - 6}
                        </span>
                      )}
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg bg-zinc-950 border-[#d4af37]/25">
          <DialogHeader>
            <DialogTitle>Stock Views{!isOwner ? ` — ${profileUsername}` : ""}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {groups.map(g => (
              <div key={g.color} className="space-y-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-white">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: g.color }} />
                  {g.label}
                  <span className="ml-auto text-[10px] font-normal text-white/70">{g.tickers.length}</span>
                </div>
                {g.tickers.length === 0 ? (
                  <span className="text-[10px] text-white/70">None</span>
                ) : (
                  <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                    {g.tickers.map(ticker => (
                      <span
                        key={ticker}
                        className="text-sm font-extrabold text-center px-2 py-2.5 rounded-lg shadow-sm"
                        style={{ backgroundColor: g.color, color: boxTextColor(g.color) }}
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
              className="w-full text-[10px] font-medium text-white/70 hover:text-[#d4af37] border border-[#d4af37]/20 hover:border-[#d4af37]/40 rounded px-1.5 py-1.5 transition-colors"
            >
              Open all in scanner →
            </button>
          )}
          {isOwner && (
            <button
              onClick={() => navigate("/watchlist")}
              className="w-full text-[10px] text-white/70 hover:text-[#d4af37] transition-colors"
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

function StatsBar({ stats, posts, account }: { stats: ProfileData["stats"]; posts: TradePost[]; account: ProfileData["account"] }) {
  const lowSample = stats.closed < 5
  const winRateColor = stats.winRate == null ? "text-white/70" : stats.winRate >= 0.6 ? "text-green-400" : stats.winRate >= 0.4 ? "text-yellow-400" : "text-red-400"
  const pnlColor = stats.totalPnl == null ? "text-white/70" : stats.totalPnl >= 0 ? "text-green-400" : "text-red-400"
  const pnl = stats.totalPnl != null ? (stats.totalPnl >= 0 ? `+$${stats.totalPnl.toFixed(0)}` : `-$${Math.abs(stats.totalPnl).toFixed(0)}`) : "—"
  const avgPnl = stats.closed > 0 && stats.totalPnl != null ? stats.totalPnl / stats.closed : null
  const streak = computeStreak(posts)

  const items = [
    {
      label: "Win Rate",
      value: stats.winRate != null ? `${Math.round(stats.winRate * 100)}% (${stats.wins}-${stats.losses})` : "—",
      color: winRateColor,
      dim: lowSample,
    },
    { label: "P&L", value: pnl, color: pnlColor, dim: lowSample },
    {
      label: "Avg",
      value: avgPnl != null ? (avgPnl >= 0 ? `+$${avgPnl.toFixed(0)}` : `-$${Math.abs(avgPnl).toFixed(0)}`) : "—",
      color: avgPnl == null ? "text-white/70" : avgPnl >= 0 ? "text-green-400" : "text-red-400",
      dim: lowSample,
    },
    { label: "Open", value: String(stats.openPosts), color: "text-sky-300/80", dim: false },
    {
      label: "Streak",
      value: streak ? `${streak.win ? "W" : "L"}${streak.n}` : "—",
      color: !streak ? "text-white/70" : streak.win ? "text-green-400" : "text-red-400",
      dim: false,
    },
    ...(stats.unrealizedPnl !== 0
      ? [{
          label: "Unrealized",
          value: `${stats.unrealizedPnl >= 0 ? "+" : "-"}$${Math.abs(stats.unrealizedPnl).toFixed(0)}`,
          color: stats.unrealizedPnl >= 0 ? "text-green-400" : "text-red-400",
          dim: false,
        }]
      : []),
    { label: "Cash", value: `$${account.cashBalance.toFixed(0)}`, color: "text-white/80", dim: false },
    {
      label: "Buying Power",
      value: `$${account.buyingPower.toFixed(0)}`,
      color: account.buyingPower >= 0 ? "text-white/80" : "text-red-400",
      dim: false,
    },
  ]

  return (
    <div className="w-full flex flex-wrap rounded border border-[#d4af37]/20 overflow-hidden">
      {items.map((it, i) => (
        <div
          key={it.label}
          className={cn(
            "flex-1 min-w-[76px] flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 bg-[#d4af37]/5",
            i > 0 && "border-l border-[#d4af37]/10",
            it.dim && "opacity-60"
          )}
        >
          <span className="text-[9px] font-medium uppercase tracking-widest text-white/50 whitespace-nowrap">{it.label}</span>
          <span className={cn("text-xs font-mono font-bold tabular-nums whitespace-nowrap", it.color)}>{it.value}</span>
        </div>
      ))}
    </div>
  )
}

// ── Holdings (wheel-strategy assigned shares) ────────────────────────────────

const HOLDINGS_GRID_HEADER = "border-b border-[#d4af37]/20 bg-[#d4af37]/5"
const HOLDINGS_GRID_TH     = "py-1 px-2.5 font-medium text-[10px] uppercase tracking-widest text-white/50 whitespace-nowrap"
const HOLDINGS_GRID_TD     = "py-1.5 px-2.5 text-xs tabular-nums"

function HoldingsSection({ holdings, isOwnerProfile, onChanged }: { holdings: StockHolding[]; isOwnerProfile: boolean; onChanged: () => void }) {
  const [expanded, setExpanded]   = useState<Set<number>>(new Set())
  const [closingId, setClosingId] = useState<number | null>(null)
  const [callModal, setCallModal] = useState<{ ticker: string; availableShares: number } | null>(null)
  const open = holdings
    .filter(h => h.status === "OPEN")
    .slice()
    .sort((a, b) => (b.unrealizedPnl ?? 0) - (a.unrealizedPnl ?? 0))
  if (open.length === 0) return null

  async function closeHolding(id: number) {
    setClosingId(id)
    try {
      await apiFeed(`/holdings/${id}/close`, { method: "POST" })
      onChanged()
    } finally { setClosingId(null) }
  }

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-2">
      <div className="flex items-center gap-2">
        <div className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Holdings</div>
        <span className="text-[10px] text-white/50">({open.length})</span>
      </div>

      <div className="border border-[#d4af37]/15 rounded-md overflow-hidden bg-black/30">
        <table className="w-full border-collapse">
          <thead>
            <tr className={HOLDINGS_GRID_HEADER}>
              <th className={cn(HOLDINGS_GRID_TH, "text-left")}>Ticker</th>
              <th className={cn(HOLDINGS_GRID_TH, "text-right")}>Shares</th>
              <th className={cn(HOLDINGS_GRID_TH, "text-right")}>Cost Basis</th>
              <th className={cn(HOLDINGS_GRID_TH, "text-right")}>Price</th>
              <th className={cn(HOLDINGS_GRID_TH, "text-right")}>Unrealized</th>
              {isOwnerProfile && <th className={cn(HOLDINGS_GRID_TH, "text-right")}></th>}
            </tr>
          </thead>
          <tbody>
            {open.map((h, rowIdx) => {
              const pnl = h.unrealizedPnl
              const pnlColor = pnl == null ? "text-white/70" : pnl >= 0 ? "text-green-400" : "text-red-400"
              const pnlLabel = pnl == null ? "—" : `${pnl >= 0 ? "+" : "-"}$${Math.abs(pnl).toFixed(0)}`
              const isExpanded = expanded.has(h.id)
              return (
                <Fragment key={h.id}>
                  <tr
                    className={cn(
                      rowIdx % 2 === 0 ? "bg-transparent" : "bg-[#d4af37]/[0.02]",
                      "border-b border-[#d4af37]/10 last:border-b-0 cursor-pointer hover:bg-[#d4af37]/5"
                    )}
                    onClick={() => setExpanded(prev => {
                      const next = new Set(prev)
                      if (next.has(h.id)) next.delete(h.id)
                      else next.add(h.id)
                      return next
                    })}
                  >
                    <td className={HOLDINGS_GRID_TD}>
                      <span className="text-amber-100 font-semibold font-mono">{h.ticker}</span>
                    </td>
                    <td className={cn(HOLDINGS_GRID_TD, "text-right text-white/80")}>{h.shares}</td>
                    <td className={cn(HOLDINGS_GRID_TD, "text-right text-white/80")}>${h.costBasis.toFixed(2)}</td>
                    <td className={cn(HOLDINGS_GRID_TD, "text-right text-white/80")}>
                      {h.currentPrice != null ? `$${h.currentPrice.toFixed(2)}` : "—"}
                    </td>
                    <td className={cn(HOLDINGS_GRID_TD, "text-right font-bold", pnlColor)}>{pnlLabel}</td>
                    {isOwnerProfile && (
                      <td className={cn(HOLDINGS_GRID_TD, "text-right")} onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1">
                          {h.shares > 0 && (
                            <button
                              onClick={() => setCallModal({ ticker: h.ticker, availableShares: h.availableForCall })}
                              className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-[#d4af37]/30 text-[#d4af37]/80 hover:bg-[#d4af37]/10"
                            >
                              Sell Call
                            </button>
                          )}
                          <button
                            onClick={() => closeHolding(h.id)}
                            disabled={closingId === h.id}
                            className="text-[10px] font-semibold px-1.5 py-0.5 rounded border border-red-500/30 text-red-400/80 hover:bg-red-500/10 disabled:opacity-40"
                          >
                            {closingId === h.id ? "…" : "Close"}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                  {isExpanded && h.notes && (
                    <tr className="border-b border-[#d4af37]/10 last:border-b-0">
                      <td colSpan={isOwnerProfile ? 6 : 5} className="px-2.5 py-1.5 bg-black/40 text-[10px] text-white/50">
                        {h.notes}
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {callModal && (
        <TickerCallOptionsModal
          ticker={callModal.ticker}
          availableShares={callModal.availableShares}
          onClose={() => setCallModal(null)}
          onPosted={() => { setCallModal(null); onChanged() }}
        />
      )}
    </div>
  )
}

// ── Cumulative P&L chart ─────────────────────────────────────────────────────

function CumulativePnlChart({ posts, holdings }: { posts: TradePost[]; holdings: StockHolding[] }) {
  const { timeline, unrealizedTotal } = useMemo(() => {
    // Realized events: closed/expired trade posts + wheel lots closed via CALLED_AWAY
    // (that gain/loss lives on the holding, not on any trade_posts row — see trade-post-expiry.ts).
    const events = [
      ...posts
        .filter(p => p.status !== "OPEN" && p.resolvedPnl != null)
        .map(p => ({ date: p.createdAt, pnl: p.resolvedPnl ?? 0, label: p.ticker })),
      ...holdings
        .filter(h => h.status === "CALLED_AWAY" && h.realizedPnl != null && h.closedAt != null)
        .map(h => ({ date: h.closedAt as string, pnl: h.realizedPnl ?? 0, label: `${h.ticker} (called away)` })),
    ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())

    let running = 0
    const points = events.map(e => {
      running += e.pnl
      return { date: e.date, cumulative: running, ticker: e.label, unrealized: false }
    })

    // Mark-to-market: fold open wheel positions' unrealized P&L into a final point
    // dated today, so an assigned-but-still-underwater put shows the paper loss
    // instead of just the premium win.
    const unrealizedTotal = holdings
      .filter(h => h.status === "OPEN" && h.unrealizedPnl != null)
      .reduce((sum, h) => sum + (h.unrealizedPnl ?? 0), 0)

    if (unrealizedTotal !== 0) {
      points.push({
        date: new Date().toISOString(),
        cumulative: running + unrealizedTotal,
        ticker: "open positions",
        unrealized: true,
      })
    }

    return { timeline: points, unrealizedTotal }
  }, [posts, holdings])

  const total = timeline.length > 0 ? timeline[timeline.length - 1]!.cumulative : 0

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-1">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Cumulative P&L</div>
        {timeline.length > 0 && (
          <div className="text-right">
            <span className={cn("text-xs font-bold tabular-nums", total >= 0 ? "text-green-400" : "text-red-400")}>
              {total >= 0 ? "+" : ""}${total.toFixed(0)}
            </span>
            {unrealizedTotal !== 0 && (
              <div className="text-[9px] text-white/50 tabular-nums">incl. {unrealizedTotal >= 0 ? "+" : "-"}${Math.abs(unrealizedTotal).toFixed(0)} unrealized</div>
            )}
          </div>
        )}
      </div>
      {timeline.length === 0 ? (
        <div className="h-[120px] flex items-center justify-center text-xs text-white/70">No closed trades yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={150}>
          <AreaChart data={timeline} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="profilePnlFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={total >= 0 ? "#1D9E75" : "#ff4466"} stopOpacity={0.35} />
                <stop offset="100%" stopColor={total >= 0 ? "#1D9E75" : "#ff4466"} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 9, fill: "#d4af37" }}
              tickFormatter={d => new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
              axisLine={{ stroke: "#3f3f46" }}
              tickLine={false}
              minTickGap={30}
            />
            <YAxis
              tick={{ fontSize: 9, fill: "#d4af37" }}
              domain={["auto", "auto"]}
              axisLine={{ stroke: "#3f3f46" }}
              tickLine={false}
              width={44}
              tickFormatter={v => `$${v}`}
            />
            <Tooltip content={(p) => {
              const d = p.payload?.[0]?.payload as { date: string; cumulative: number; ticker: string; unrealized: boolean } | undefined
              if (!p.active || !d) return null
              return (
                <div className="bg-zinc-950 border border-[#d4af37]/25 rounded-md px-2.5 py-1.5 shadow-xl text-xs space-y-0.5">
                  <div className="text-white/70">{new Date(d.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {d.ticker}{d.unrealized ? " (unrealized)" : ""}</div>
                  <div className={cn("font-bold tabular-nums", d.cumulative >= 0 ? "text-green-400" : "text-red-400")}>
                    {d.cumulative >= 0 ? "+" : ""}${d.cumulative.toFixed(0)}
                  </div>
                </div>
              )
            }} />
            <Area type="monotone" dataKey="cumulative" stroke={total >= 0 ? "#1D9E75" : "#ff4466"} strokeWidth={1.5} fill="url(#profilePnlFill)" />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

// ── Top tickers breakdown ────────────────────────────────────────────────────

interface TickerRow { ticker: string; count: number; pnl: number; unrealizedPnl: number }

/** Custom XAxis tick: ticker on top line, contract quantity ("2×") below it. */
function TickerAxisTick({ x, y, payload, rows }: { x?: number; y?: number; payload?: { value: string }; rows: TickerRow[] }) {
  const row = rows.find(r => r.ticker === payload?.value)
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={0} y={0} dy={12} textAnchor="middle" fill="#fff" fontSize={10} fontWeight={700}>{payload?.value}</text>
      <text x={0} y={0} dy={25} textAnchor="middle" fill="#d4af37" fontSize={9} fillOpacity={0.7}>{row?.count}×</text>
    </g>
  )
}

function TopTickers({ posts, tickerPnl }: { posts: TradePost[]; tickerPnl: TickerPnl[] }) {
  const rows = useMemo<TickerRow[]>(() => {
    // Count comes from post activity; P&L comes from the backend rollup (trade_posts
    // + stock_holdings realized/unrealized combined — fixes a bug where this chart
    // only summed resolvedPnl and missed wheel-holdings P&L entirely).
    const counts = new Map<string, number>()
    for (const p of posts) counts.set(p.ticker.toUpperCase(), (counts.get(p.ticker.toUpperCase()) ?? 0) + 1)
    return tickerPnl
      .map(t => ({ ticker: t.ticker, count: counts.get(t.ticker) ?? 0, pnl: t.totalPnl, unrealizedPnl: t.unrealizedPnl }))
      .sort((a, b) => b.pnl - a.pnl)
      .slice(0, 6)
  }, [posts, tickerPnl])

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-1.5">
      <div className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Top Tickers</div>
      {rows.length === 0 ? (
        <div className="h-[150px] flex items-center justify-center text-xs text-white/70">No trade ideas yet</div>
      ) : (
        <ResponsiveContainer width="100%" height={150}>
          <BarChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <XAxis dataKey="ticker" tick={<TickerAxisTick rows={rows} />} height={34} axisLine={{ stroke: "#3f3f46" }} tickLine={false} interval={0} />
            <YAxis tick={{ fontSize: 9, fill: "#d4af37" }} axisLine={{ stroke: "#3f3f46" }} tickLine={false} width={44} tickFormatter={v => `$${v}`} />
            <Tooltip content={(p) => {
              const d = p.payload?.[0]?.payload as TickerRow | undefined
              if (!p.active || !d) return null
              return (
                <div className="bg-zinc-950 border border-[#d4af37]/25 rounded-md px-2.5 py-1.5 shadow-xl text-xs space-y-0.5">
                  <div className="text-white font-bold">{d.ticker} · {d.count}×</div>
                  <div className={cn("font-bold tabular-nums", d.pnl >= 0 ? "text-green-400" : "text-red-400")}>
                    {d.pnl >= 0 ? "+" : ""}${d.pnl.toFixed(0)}
                  </div>
                  {d.unrealizedPnl !== 0 && (
                    <div className="text-[10px] text-white/50 tabular-nums">
                      incl. {d.unrealizedPnl >= 0 ? "+" : "-"}${Math.abs(d.unrealizedPnl).toFixed(0)} unrealized
                    </div>
                  )}
                </div>
              )
            }} />
            <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
              {rows.map(r => <Cell key={r.ticker} fill={r.pnl >= 0 ? "#1D9E75" : "#ff4466"} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
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

  const [resetting, setResetting] = useState(false)
  async function handleReset() {
    if (!confirm("Reset your paper-trading account? Any gain on open holdings will be locked in as cash; losses are forgiven. Cash and holdings reset — your trade ideas, win rate, and streak stay exactly as they are."))
      return
    setResetting(true)
    try {
      await apiFeed("/portfolio/reset", { method: "POST" })
      invalidate()
    } finally { setResetting(false) }
  }

  return (
    <div className="min-h-[100dvh] bg-zinc-900">
      <TopNav />
      <main className="pt-14 p-5 max-w-2xl space-y-2">

        {!isOwnerProfile && me && (
          <Link href="/profile/me" className="text-xs text-white/70 hover:text-[#d4af37] transition-colors shrink-0">
            ← My Profile
          </Link>
        )}

        {isLoading && <span className="text-xs text-white/70 animate-pulse">Loading…</span>}
        {error    && <div className="text-sm text-red-400">Failed to load profile.</div>}

        {data && (
          <>
            {/* ── Compact user header + stats grid ── */}
            <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-2.5">
              <div className="flex items-center gap-2.5 flex-wrap">
                <div className="flex items-center gap-2.5 shrink-0">
                  {/* Avatar */}
                  <div className="w-9 h-9 rounded-full bg-[#d4af37]/20 flex items-center justify-center text-sm font-bold text-[#d4af37] shrink-0 ring-2 ring-[#d4af37]/30">
                    {data.user.avatarUrl
                      ? <img src={data.user.avatarUrl} alt={data.user.username} className="w-9 h-9 rounded-full object-cover" />
                      : data.user.username[0]?.toUpperCase()
                    }
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold text-white leading-none">{data.user.username}</span>
                    <span className={cn(
                      "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
                      data.user.role === "admin"
                        ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                        : "bg-zinc-900 text-white/70 border-[#d4af37]/20"
                    )}>
                      {data.user.role}
                    </span>
                  </div>
                </div>

                {/* Reset + Post buttons */}
                {isOwnerProfile && (
                  <div className="flex items-center gap-2 ml-auto shrink-0">
                    <button
                      onClick={handleReset}
                      disabled={resetting}
                      title="Reset cash and holdings — trade ideas, win rate, and streak are preserved"
                      className="text-[11px] font-semibold px-3 py-1.5 rounded border border-[#d4af37]/20 bg-zinc-900 text-white/70 hover:text-red-400 hover:border-red-400/40 transition-all disabled:opacity-40"
                    >
                      {resetting ? "Resetting…" : "Reset Account"}
                    </button>
                    <button
                      onClick={() => setShowForm(v => !v)}
                      className={cn(
                        "text-[11px] font-semibold px-3 py-1.5 rounded border transition-all shrink-0",
                        showForm
                          ? "bg-zinc-900 text-white/70 border-[#d4af37]/20"
                          : "bg-[#d4af37] text-black border-[#d4af37] hover:bg-[#d4af37]/90"
                      )}
                    >
                      {showForm ? "Cancel" : "+ Trade Idea"}
                    </button>
                  </div>
                )}
              </div>

              {/* Compact ag-grid-style stats row */}
              <StatsBar stats={data.stats} posts={data.posts} account={data.account} />
            </div>

            {/* ── Holdings (wheel-strategy assigned shares) ── */}
            <HoldingsSection holdings={data.holdings} isOwnerProfile={isOwnerProfile} onChanged={invalidate} />

            {/* ── Cumulative P&L + Top Tickers ── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <CumulativePnlChart posts={data.posts} holdings={data.holdings} />
              <TopTickers posts={data.posts} tickerPnl={data.tickerPnl} />
            </div>

            {/* ── Stock Views (reflects tagged Watchlist) ── */}
            <StockViewsPanel isOwner={isOwnerProfile} profileUsername={username} />

            {/* ── Submit form ── */}
            {isOwnerProfile && showForm && (
              <SubmitForm onSuccess={() => { setShowForm(false); invalidate() }} />
            )}

            {/* ── Trade ideas ── */}
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">
                Trade Ideas
                {data.posts.length > 0 && <span className="ml-1.5 text-white/70">({data.posts.length})</span>}
              </div>

              {data.posts.length === 0 ? (
                <div className="text-sm text-white/70 text-center py-8 rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60">
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
