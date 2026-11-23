// Profile "post a trade" form + its ticker search (moved out of pages/profile.tsx).
import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSearchStocks, getSearchStocksQueryKey } from "@workspace/api-client-react"
import { useDebounce } from "@/hooks/use-debounce"
import { cn } from "@/lib/utils"
import { getJson } from "@/lib/get-json";

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
const CONF_COLORS = ["text-amber-100 border-[#d4af37]/20 bg-zinc-900", "text-orange-400 border-orange-500/40 bg-orange-500/15", "text-yellow-400 border-yellow-500/40 bg-yellow-500/15", "text-green-400 border-green-500/40 bg-green-500/15", "text-emerald-400 border-emerald-500/40 bg-emerald-500/15"]

export function SubmitForm({ onSuccess }: { onSuccess: () => void }) {
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
    queryFn: () => getJson(`/api/options/${ticker}`, { credentials: "include" }),
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
                : "bg-zinc-950 text-amber-100 border-[#d4af37]/20 hover:text-[#d4af37]"
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
          {chainLoading && <p className="text-xs text-amber-100 animate-pulse">Loading chain…</p>}
          {!chainLoading && expiryChains.length > 0 && (
            <>
              {/* Expiry selector */}
              <div className="flex gap-1.5 flex-wrap">
                {expiryChains.slice(0, 6).map(c => (
                  <button key={c.expiry} type="button" onClick={() => selectExpiry(c.expiry)}
                    className={cn("text-[10px] px-2 py-0.5 rounded border transition-all",
                      (selectedExpiry || expiryChains[0]?.expiry) === c.expiry
                        ? "bg-[#d4af37] text-black border-[#d4af37]"
                        : "text-amber-100 border-[#d4af37]/20 hover:text-[#d4af37]"
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
                    <label className="text-xs text-amber-100">Contracts</label>
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
              <label className="text-xs text-amber-100">{label}</label>
              <input required={required} type="number" min={min ?? "0"} step={step ?? "0.01"}
                value={val} onChange={e => set(e.target.value)} placeholder={placeholder}
                className={inp} />
            </div>
          ))}
        </div>
      )}

      {/* Confidence */}
      <div className="space-y-1">
        <label className="text-xs text-amber-100">Confidence</label>
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
        <label className="text-xs text-amber-100">Rationale</label>
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
      <label className="text-xs text-amber-100">Ticker</label>
      <input value={input}
        onChange={e => { setInput(e.target.value.toUpperCase()); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder="Search ticker…"
        className="w-full bg-white border border-[#d4af37]/30 rounded px-2 py-1.5 text-sm text-black placeholder:text-amber-100/80 focus:outline-none focus:ring-2 focus:ring-[#d4af37]/50" />
      {open && debouncedQ.length >= 1 && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-zinc-950 border border-[#d4af37]/25 rounded-md shadow-xl overflow-hidden max-h-40 overflow-y-auto">
          {isFetching && <div className="px-3 py-2 text-xs text-amber-100 animate-pulse">Searching…</div>}
          {!isFetching && results.length === 0 && <div className="px-3 py-2 text-xs text-amber-100">No results</div>}
          {results.map((r: { ticker: string; name?: string }) => (
            <button key={r.ticker} type="button" onMouseDown={() => pick(r.ticker)}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs hover:bg-amber-500/10 transition-colors text-left">
              <span className="font-bold text-white w-14 shrink-0">{r.ticker}</span>
              <span className="text-amber-100 truncate">{r.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Stock Views panel (reflects the user's tagged Watchlist) ───────────────────
