import { useState, useRef, useCallback } from "react"
import { useParams, useLocation, Link } from "wouter"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react"
import { Sidebar } from "@/components/sidebar"
import { TradeCard, type TradePost } from "@/components/TradeCard"
import { useAuth } from "@/context/AuthContext"
import { useDebounce } from "@/hooks/use-debounce"
import { cn } from "@/lib/utils"
import { TrendingUp, TrendingDown, Minus, X, Search, Loader2 } from "lucide-react"

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
      if (r.status === 429) { setError("Max 3 open trade ideas at a time"); return }
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
        className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
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

// ── Stock Buckets panel ────────────────────────────────────────────────────────

function BucketTickerInput({
  onSelect,
  disabled,
  excludeTickers = [],
}: {
  onSelect: (ticker: string) => void
  disabled?: boolean
  excludeTickers?: string[]
}) {
  const [inputText, setInputText] = useState("")
  const [open, setOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)

  const debouncedSearch = useDebounce(inputText, 180)
  const exclude = new Set(excludeTickers.map(t => t.toUpperCase()))

  const { data: apiResults, isFetching } = useSearchStocks(
    { q: debouncedSearch },
    {
      query: {
        enabled: debouncedSearch.length >= 2,
        queryKey: getSearchStocksQueryKey({ q: debouncedSearch }),
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
      },
    },
  )

  const results = (apiResults ?? []).filter(r => !exclude.has(r.ticker.toUpperCase()))
  const showDropdown = open && debouncedSearch.length >= 2

  const selectTicker = useCallback((ticker: string) => {
    const upper = ticker.toUpperCase().trim()
    if (upper) onSelect(upper)
    setInputText("")
    setOpen(false)
    setFocusedIndex(-1)
  }, [onSelect])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open || results.length === 0) {
      if (e.key === "Enter" && inputText.trim()) {
        e.preventDefault()
        selectTicker(inputText.trim())
      }
      return
    }
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setFocusedIndex(i => Math.min(i + 1, results.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setFocusedIndex(i => Math.max(i - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      if (focusedIndex >= 0 && results[focusedIndex]) selectTicker(results[focusedIndex].ticker)
      else if (inputText.trim()) selectTicker(inputText.trim())
    } else if (e.key === "Escape") {
      setOpen(false)
    }
  }

  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground/50 z-10" />
      {isFetching && debouncedSearch.length >= 2 && (
        <Loader2 className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground animate-spin z-10" />
      )}
      <input
        ref={inputRef}
        type="text"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={inputText}
        onChange={e => { setInputText(e.target.value.toUpperCase()); setOpen(true); setFocusedIndex(-1) }}
        onFocus={() => { if (closeTimeout.current) clearTimeout(closeTimeout.current); if (inputText.length >= 2) setOpen(true) }}
        onBlur={() => { closeTimeout.current = setTimeout(() => setOpen(false), 150) }}
        onKeyDown={handleKeyDown}
        placeholder="Search…"
        maxLength={10}
        className="w-full min-w-0 bg-background/60 border border-border/60 rounded pl-7 pr-7 py-1 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
      />
      {showDropdown && (
        <div className="absolute top-full left-0 right-0 min-w-[200px] mt-1 z-50 rounded-md border border-border bg-card shadow-xl overflow-hidden">
          {isFetching && results.length === 0 ? (
            <div className="px-3 py-2 text-[10px] text-muted-foreground flex items-center gap-1.5">
              <Loader2 className="h-3 w-3 animate-spin" /> Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="px-3 py-2 text-[10px] text-muted-foreground">No results</div>
          ) : (
            <ul className="max-h-40 overflow-y-auto py-0.5">
              {results.map((r, i) => (
                <li
                  key={r.ticker}
                  onMouseDown={e => { e.preventDefault(); selectTicker(r.ticker) }}
                  className={cn(
                    "flex items-center justify-between px-3 py-1.5 cursor-pointer text-[10px]",
                    "hover:bg-primary/10",
                    i === focusedIndex && "bg-primary/15",
                  )}
                >
                  <span className="font-mono font-bold">{r.ticker}</span>
                  <span className="text-muted-foreground truncate ml-2 max-w-[100px]">{r.name}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

const BUCKETS = [
  { key: "BULLISH",  label: "Bullish",  icon: TrendingUp,   color: "text-green-400",  border: "border-green-500/30",  bg: "bg-green-500/5",  pill: "bg-green-500/15 text-green-400 border-green-500/30" },
  { key: "NEUTRAL",  label: "Neutral",  icon: Minus,        color: "text-yellow-400", border: "border-yellow-500/30", bg: "bg-yellow-500/5", pill: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  { key: "BEARISH",  label: "Bearish",  icon: TrendingDown, color: "text-red-400",    border: "border-red-500/30",    bg: "bg-red-500/5",    pill: "bg-red-500/15 text-red-400 border-red-500/30" },
] as const

type BucketKey = "BULLISH" | "NEUTRAL" | "BEARISH"

function BucketsPanel({ isOwner, profileUsername }: { isOwner: boolean; profileUsername: string }) {
  const qc = useQueryClient()
  const [adding, setAdding] = useState<Record<BucketKey, boolean>>({ BULLISH: false, NEUTRAL: false, BEARISH: false })

  const { data: allBuckets = [], isLoading } = useQuery<{ ticker: string; bucket: BucketKey; addedAt: string }[]>({
    queryKey: ["feed", "buckets", profileUsername],
    queryFn: () => apiFeed(`/buckets/${profileUsername}`),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  })

  function invalidateBuckets() {
    qc.invalidateQueries({ queryKey: ["feed", "buckets", profileUsername] })
  }

  async function addTicker(bucket: BucketKey, ticker: string) {
    const t = ticker.trim().toUpperCase()
    if (!t) return
    setAdding(prev => ({ ...prev, [bucket]: true }))
    try {
      await apiFeed("/buckets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: t, bucket }),
      })
      invalidateBuckets()
    } finally {
      setAdding(prev => ({ ...prev, [bucket]: false }))
    }
  }

  async function removeTicker(ticker: string) {
    await apiFeed(`/buckets/${ticker}`, { method: "DELETE" })
    invalidateBuckets()
  }

  // Group all buckets by bucket type, then group tickers by who picked them
  function tickersFor(bucketKey: BucketKey) {
    return allBuckets.filter(b => b.bucket === bucketKey).sort((a, b) => a.ticker.localeCompare(b.ticker))
  }

  const myTickers = new Set(allBuckets.map(b => b.ticker))

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stock Views</div>
      <div className="grid grid-cols-3 gap-3">
        {BUCKETS.map(({ key, label, icon: Icon, color, border, bg, pill }) => {
          const tickers = tickersFor(key)
          return (
            <div key={key} className={cn("rounded-xl border p-3 space-y-2.5", border, bg)}>
              <div className={cn("flex items-center gap-1.5 text-xs font-bold", color)}>
                <Icon className="w-3.5 h-3.5" />
                {label}
                <span className="ml-auto text-[10px] font-normal text-muted-foreground/60">{tickers.length}</span>
              </div>

              <div className="space-y-1 min-h-[40px]">
                {isLoading ? (
                  <span className="text-[10px] text-muted-foreground/40 animate-pulse">Loading…</span>
                ) : tickers.length === 0 ? (
                  <span className="text-[10px] text-muted-foreground/40">No picks yet</span>
                ) : (
                  tickers.map(({ ticker }) => (
                    <div key={ticker} className="flex items-center gap-1.5 group">
                      <span className={cn("text-xs font-bold px-1.5 py-0.5 rounded border", pill)}>
                        {ticker}
                      </span>
                      {isOwner && (
                        <button
                          onClick={() => removeTicker(ticker)}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-red-400 transition-all ml-auto"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              {isOwner && (
                <BucketTickerInput
                  disabled={adding[key]}
                  excludeTickers={[...myTickers]}
                  onSelect={t => addTicker(key, t)}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Compact stats bar ──────────────────────────────────────────────────────────

function StatsBar({ stats }: { stats: ProfileData["stats"] }) {
  const winRate = stats.winRate != null ? `${Math.round(stats.winRate * 100)}%` : "—"
  const pnl = stats.totalPnl != null ? (stats.totalPnl >= 0 ? `+$${stats.totalPnl.toFixed(0)}` : `-$${Math.abs(stats.totalPnl).toFixed(0)}`) : "—"

  const items = [
    { label: "Trades",   value: String(stats.totalPosts),          color: "text-foreground" },
    { label: "Open",     value: String(stats.openPosts),            color: "text-blue-400" },
    { label: "Win Rate", value: winRate, color: stats.winRate == null ? "text-muted-foreground" : stats.winRate >= 0.6 ? "text-green-400" : stats.winRate >= 0.4 ? "text-yellow-400" : "text-red-400" },
    { label: "P&L",      value: pnl,    color: stats.totalPnl == null ? "text-muted-foreground" : stats.totalPnl >= 0 ? "text-green-400" : "text-red-400" },
    { label: "Wins",     value: String(stats.wins),                 color: "text-green-400" },
    { label: "Losses",   value: String(stats.losses),               color: "text-red-400" },
  ]

  return (
    <div className="flex items-center gap-0 bg-card border border-border rounded-xl overflow-hidden">
      {items.map(({ label, value, color }, i) => (
        <div key={label} className={cn(
          "flex-1 flex flex-col items-center py-2.5 px-1",
          i < items.length - 1 && "border-r border-border"
        )}>
          <div className={cn("text-base font-bold leading-tight", color)}>{value}</div>
          <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide mt-0.5">{label}</div>
        </div>
      ))}
    </div>
  )
}

// ── Profile page ──────────────────────────────────────────────────────────────

export default function Profile() {
  const { username: routeUsername } = useParams<{ username: string }>()
  const { user: me } = useAuth()
  const qc = useQueryClient()
  const [, navigate] = useLocation()
  const [userSearch, setUserSearch] = useState("")
  const [userDropdownOpen, setUserDropdownOpen] = useState(false)

  const username = routeUsername === "me" ? (me?.username ?? "") : routeUsername
  const [showForm, setShowForm] = useState(false)

  const { data: allUsers = [] } = useQuery<{ username: string; avatarUrl: string | null }[]>({
    queryKey: ["feed", "users"],
    queryFn: () => apiFeed("/users"),
    staleTime: 60000,
  })

  const filteredUsers = userSearch.trim()
    ? allUsers.filter(u => u.username.toLowerCase().includes(userSearch.toLowerCase()))
    : allUsers

  function goToUser(uname: string) {
    setUserSearch("")
    setUserDropdownOpen(false)
    navigate(`/profile/${uname}`)
  }

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
    <div className="flex min-h-[100dvh] bg-background">
      <Sidebar />
      <main className="flex-1 ml-[var(--sidebar-w)] p-5 max-w-2xl space-y-5">

        {/* ── Nav bar: back to my profile + find user ── */}
        <div className="flex items-center gap-3">
          {!isOwnerProfile && me && (
            <Link href="/profile/me" className="text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0">
              ← My Profile
            </Link>
          )}
          <div className="relative ml-auto">
            <input
              value={userSearch}
              onChange={e => setUserSearch(e.target.value)}
              onFocus={() => setUserDropdownOpen(true)}
              onBlur={() => setTimeout(() => setUserDropdownOpen(false), 150)}
              placeholder="Find user…"
              className="bg-secondary border border-border rounded px-2.5 py-1 text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary w-36"
            />
            {userDropdownOpen && filteredUsers.length > 0 && (
              <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-card border border-border rounded-lg shadow-xl overflow-hidden">
                {filteredUsers.map(u => (
                  <button
                    key={u.username}
                    onMouseDown={() => goToUser(u.username)}
                    className={cn(
                      "w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-muted/40 transition-colors text-left",
                      u.username === username && "bg-primary/10 text-primary"
                    )}
                  >
                    <div className="w-5 h-5 rounded-full bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                      {u.avatarUrl
                        ? <img src={u.avatarUrl} alt={u.username} className="w-5 h-5 rounded-full object-cover" />
                        : u.username[0]?.toUpperCase()}
                    </div>
                    <span className="font-medium text-foreground">{u.username}</span>
                    {u.username === me?.username && <span className="ml-auto text-[10px] text-muted-foreground">you</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

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
            <StatsBar stats={data.stats} />

            {/* ── Stock Views Buckets ── */}
            <BucketsPanel isOwner={isOwnerProfile} profileUsername={username} />

            {/* ── Submit form ── */}
            {isOwnerProfile && showForm && (
              <SubmitForm onSuccess={() => { setShowForm(false); invalidate() }} />
            )}

            {/* ── Trade ideas ── */}
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Trade Ideas
                {data.posts.length > 0 && <span className="ml-1.5 text-muted-foreground/50">({data.posts.length})</span>}
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
