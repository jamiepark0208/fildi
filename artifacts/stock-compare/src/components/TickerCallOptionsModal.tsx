import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { cn } from "@/lib/utils"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { CreateSellPutDialog, type OptionRow, type OptionsChainResult } from "@/components/strike-detail-panel"

// Lightweight, ticker-scoped call chain — deliberately not the full scanner scoring
// pipeline (RSI/IV-rank/technicals), just enough to pick a strike. Submitting reuses
// the real trade-creation dialog (CreateSellPutDialog) rather than rebuilding it.

export function TickerCallOptionsModal({ ticker, availableShares, onClose, onPosted }: {
  ticker: string
  availableShares: number
  onClose: () => void
  onPosted: () => void
}) {
  const [selected, setSelected] = useState<{ put: OptionRow; chain: OptionsChainResult } | null>(null)

  const { data: chains, isFetching, error } = useQuery<OptionsChainResult[]>({
    queryKey: ["options-chain", ticker],
    queryFn: () => fetch(`/api/options/${ticker}`, { credentials: "include" }).then(r => r.json()),
    staleTime: 5 * 60 * 1000,
  })

  const maxContracts = Math.max(0, Math.floor(availableShares / 100))

  return (
    <>
      <Dialog open onOpenChange={v => !v && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sell Call — {ticker}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            <div className="text-xs text-amber-200/50">
              {maxContracts > 0
                ? `Covered by ${availableShares} available shares — up to ${maxContracts} contract${maxContracts === 1 ? "" : "s"}.`
                : "No available shares to cover a call right now."}
            </div>
            {isFetching && <div className="text-xs text-amber-200/50 animate-pulse">Loading chain…</div>}
            {error && <div className="text-xs text-red-400">Failed to load options chain.</div>}
            {chains?.map(chain => (
              <div key={chain.expiry} className="border border-[#d4af37]/15 rounded-md overflow-hidden">
                <div className="bg-[#d4af37]/5 px-2.5 py-1 text-[10px] uppercase tracking-widest text-amber-200/40">
                  {chain.expiry} · {chain.daysToExpiry}d
                </div>
                <table className="w-full border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-[#d4af37]/10">
                      <th className="text-left py-1 px-2.5 font-medium text-[10px] uppercase tracking-widest text-amber-200/40">Strike</th>
                      <th className="text-right py-1 px-2.5 font-medium text-[10px] uppercase tracking-widest text-amber-200/40">Premium</th>
                      <th className="text-right py-1 px-2.5 font-medium text-[10px] uppercase tracking-widest text-amber-200/40">IV</th>
                      <th className="text-right py-1 px-2.5 font-medium text-[10px] uppercase tracking-widest text-amber-200/40">Delta</th>
                      <th className="text-right py-1 px-2.5 font-medium text-[10px] uppercase tracking-widest text-amber-200/40">OTM%</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {chain.calls
                      .filter(c => c.strike > chain.spot)
                      .sort((a, b) => a.strike - b.strike)
                      .map(c => {
                        const premium = c.bid > 0 ? c.bid : c.lastPrice
                        const otmPct = ((c.strike - chain.spot) / chain.spot) * 100
                        return (
                          <tr key={c.strike} className="border-b border-[#d4af37]/5 last:border-b-0 hover:bg-[#d4af37]/5">
                            <td className="py-1 px-2.5 font-mono text-amber-100">${c.strike.toFixed(2)}</td>
                            <td className="py-1 px-2.5 text-right font-mono text-amber-200/60">${premium.toFixed(2)}</td>
                            <td className="py-1 px-2.5 text-right font-mono text-amber-200/60">{c.iv != null ? `${(c.iv * 100).toFixed(0)}%` : "—"}</td>
                            <td className="py-1 px-2.5 text-right font-mono text-amber-200/60">{c.delta != null ? c.delta.toFixed(2) : "—"}</td>
                            <td className="py-1 px-2.5 text-right font-mono text-amber-200/60">{otmPct.toFixed(1)}%</td>
                            <td className="py-1 px-2.5 text-right">
                              <button
                                disabled={maxContracts === 0}
                                onClick={() => setSelected({ put: c, chain })}
                                className={cn(
                                  "text-[10px] font-semibold px-1.5 py-0.5 rounded border border-[#d4af37]/30 text-[#d4af37]/80 hover:bg-[#d4af37]/10",
                                  maxContracts === 0 && "opacity-30 cursor-not-allowed"
                                )}
                              >
                                Sell
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {selected && (
        <CreateSellPutDialog
          open
          onClose={() => { setSelected(null); onPosted() }}
          put={selected.put}
          chain={selected.chain}
          isCall
        />
      )}
    </>
  )
}
