import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ChevronDown, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'

// ── API types ─────────────────────────────────────────────────────────────────

interface Snapshot {
  id: number
  importedAt: string
  accountIds: string[]
  totalValue: string | null
}

interface DBPosition {
  id: number
  snapshotId: number
  account: string
  accountNickname: string | null
  symbol: string
  quantity: string | null
  avgCost: string | null
  lastPrice: string | null
  marketValue: string | null
  costBasis: string | null
  unrealizedPnL: string | null
  pnlPct: string | null
  dayChangePct: string | null
  bid: string | null
  ask: string | null
}

interface DBOption {
  id: number
  snapshotId: number
  account: string
  symbol: string
  optionType: string | null
  strike: string | null
  expiration: string | null
  direction: string | null
  qty: string | null
  avgPremium: string | null
  totalPremium: string | null
  markPrice: string | null
  unrealizedPnL: string | null
  pnlPct: string | null
  delta: string | null
  theta: string | null
}

interface SnapshotResponse {
  snapshot: Snapshot | null
  positions: DBPosition[]
  options: DBOption[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 })
const fmtPct = (v: string | null) => v == null ? '—' : `${parseFloat(v) >= 0 ? '+' : ''}${parseFloat(v).toFixed(2)}%`
const fmtUsd = (v: string | null) => v == null ? '—' : fmt.format(parseFloat(v))
const fmtNum = (v: string | null) => v == null ? '—' : parseFloat(v).toLocaleString()

function pnlColor(v: string | null) {
  if (v == null) return 'text-muted-foreground'
  const n = parseFloat(v)
  return n > 0 ? 'text-green-400' : n < 0 ? 'text-red-400' : 'text-muted-foreground'
}

function PnlIcon({ v }: { v: string | null }) {
  if (v == null) return <Minus className="h-3 w-3 text-muted-foreground" />
  const n = parseFloat(v)
  if (n > 0) return <TrendingUp className="h-3 w-3 text-green-400" />
  if (n < 0) return <TrendingDown className="h-3 w-3 text-red-400" />
  return <Minus className="h-3 w-3 text-muted-foreground" />
}

const KNOWN_PORTFOLIOS = ['IRA', 'FILDI']

function groupByAccount<T extends { accountNickname?: string | null; account: string }>(
  rows: T[]
): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const row of rows) {
    const key = row.accountNickname ?? row.account
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(row)
  }
  return map
}

// ── Sub-components ────────────────────────────────────────────────────────────

const TH = 'py-2 px-3 font-medium text-[10px] uppercase tracking-widest text-[#d4af37]'
const TD = 'py-2 px-3 text-xs text-white tabular-nums'
const TDr = `${TD} text-right`

interface MetricPill {
  label: string
  value: string
  color?: string
}

function MetricBanner({ metrics }: { metrics: MetricPill[] }) {
  return (
    <div className="flex items-center gap-3 flex-wrap">
      {metrics.map(m => (
        <span key={m.label} className="flex items-center gap-1 text-[10px]">
          <span className="text-amber-200/50 uppercase tracking-widest">{m.label}</span>
          <span className={cn('font-mono font-semibold tabular-nums', m.color ?? 'text-amber-200/70')}>{m.value}</span>
        </span>
      ))}
    </div>
  )
}

function AccountGroup({
  name,
  metrics,
  children,
  defaultOpen = true,
}: {
  name: string
  metrics?: MetricPill[]
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 w-full py-2 px-3 hover:bg-amber-500/10 transition-colors text-left"
      >
        {open
          ? <ChevronDown className="h-3 w-3 text-amber-200/50" />
          : <ChevronRight className="h-3 w-3 text-amber-200/50" />
        }
        <span className="text-[11px] font-semibold text-amber-200/70 uppercase tracking-widest mr-2">{name}</span>
        {metrics && <MetricBanner metrics={metrics} />}
      </button>
      {open && children}
    </div>
  )
}

/** Prefer live quote % when present; else snapshot CSV dayChangePct. */
function resolveDayPct(symbol: string, csv: string | null, livePctByTicker?: Record<string, number | null>): string | null {
  const live = livePctByTicker?.[symbol.toUpperCase()] ?? livePctByTicker?.[symbol]
  if (live != null && Number.isFinite(live)) return String(live)
  return csv
}

function equityGroupMetrics(rows: DBPosition[], livePctByTicker?: Record<string, number | null>): MetricPill[] {
  let mktVal = 0, pnl = 0, costBasis = 0, dodWeighted = 0, dodWeight = 0
  for (const r of rows) {
    const mv = r.marketValue != null ? parseFloat(r.marketValue) : 0
    if (r.marketValue != null) mktVal += mv
    if (r.unrealizedPnL != null) pnl += parseFloat(r.unrealizedPnL)
    if (r.costBasis != null) costBasis += parseFloat(r.costBasis)
    const d = resolveDayPct(r.symbol, r.dayChangePct, livePctByTicker)
    if (d != null && mv > 0) {
      dodWeighted += parseFloat(d) * mv
      dodWeight += mv
    }
  }
  const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : null
  const pnlTone = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : undefined
  const dod = dodWeight > 0 ? dodWeighted / dodWeight : null
  const dodTone = dod != null ? (dod > 0 ? 'text-green-400' : dod < 0 ? 'text-red-400' : undefined) : undefined
  return [
    { label: 'Mkt Value', value: fmt.format(mktVal) },
    ...(dod != null ? [{ label: 'DoD', value: `${dod >= 0 ? '+' : ''}${dod.toFixed(2)}%`, color: dodTone }] : []),
    { label: 'Unrealized P&L', value: `${pnl >= 0 ? '+' : ''}${fmt.format(pnl)}`, color: pnlTone },
    ...(pnlPct != null ? [{ label: 'P&L %', value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`, color: pnlTone }] : []),
    { label: 'Holdings', value: String(rows.length) },
  ]
}

function EquityTable({
  positions,
  livePctByTicker,
}: {
  positions: DBPosition[]
  /** Live day-change % (already ×100, e.g. 1.25 = +1.25%). */
  livePctByTicker?: Record<string, number | null>
}) {
  const groups = groupByAccount(positions)
  const order = [...KNOWN_PORTFOLIOS, ...Array.from(groups.keys()).filter(k => !KNOWN_PORTFOLIOS.includes(k))]
  const orderedGroups = order.filter(k => groups.has(k))

  if (positions.length === 0) {
    return <p className="text-xs text-amber-200/40 px-3 py-3">No equity positions in this snapshot.</p>
  }

  return (
    <div>
      {orderedGroups.map(acct => (
        <AccountGroup key={acct} name={acct} metrics={equityGroupMetrics(groups.get(acct)!, livePctByTicker)}>
          <table className="w-full">
            <thead>
              <tr className="border-y border-[#d4af37]/20 bg-black">
                <th className={`${TH} text-left`}>Symbol</th>
                <th className={`${TH} text-right`}>Qty</th>
                <th className={`${TH} text-right`}>Avg Cost</th>
                <th className={`${TH} text-right`}>Last</th>
                <th className={`${TH} text-right`}>DoD</th>
                <th className={`${TH} text-right`}>Mkt Value</th>
                <th className={`${TH} text-right`}>Unrealized P&L</th>
                <th className={`${TH} text-right`}>P&L %</th>
              </tr>
            </thead>
            <tbody>
              {groups.get(acct)!.map((p, i) => {
                const dod = resolveDayPct(p.symbol, p.dayChangePct, livePctByTicker)
                return (
                  <tr key={p.id} className={cn('border-b border-zinc-800 hover:bg-amber-500/10 transition-colors', i % 2 === 0 ? 'bg-zinc-900/70' : 'bg-zinc-800/60')}>
                    <td className={`${TD} text-left font-semibold text-white`}>{p.symbol}</td>
                    <td className={TDr}>{fmtNum(p.quantity)}</td>
                    <td className={TDr}>{fmtUsd(p.avgCost)}</td>
                    <td className={TDr}>{fmtUsd(p.lastPrice)}</td>
                    <td className={cn(TDr, pnlColor(dod))}>{fmtPct(dod)}</td>
                    <td className={TDr}>{fmtUsd(p.marketValue)}</td>
                    <td className={cn(TDr, pnlColor(p.unrealizedPnL))}>
                      <span className="inline-flex items-center justify-end gap-1">
                        <PnlIcon v={p.unrealizedPnL} />
                        {fmtUsd(p.unrealizedPnL)}
                      </span>
                    </td>
                    <td className={cn(TDr, pnlColor(p.pnlPct))}>{fmtPct(p.pnlPct)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </AccountGroup>
      ))}
    </div>
  )
}

function optionGroupMetrics(rows: DBOption[]): MetricPill[] {
  let markVal = 0, pnl = 0, netDelta = 0, dailyTheta = 0, maxAssign = 0
  for (const o of rows) {
    const qty = Math.abs(parseFloat(o.qty ?? '0'))
    const isShort = o.direction === 'short'
    const sign = isShort ? -1 : 1
    if (o.markPrice != null) markVal += parseFloat(o.markPrice) * 100 * qty
    if (o.unrealizedPnL != null) pnl += parseFloat(o.unrealizedPnL)
    if (o.delta != null) netDelta += parseFloat(o.delta) * 100 * qty * sign
    if (o.theta != null) dailyTheta += parseFloat(o.theta) * 100 * qty * sign
    if (isShort && o.optionType === 'put' && o.strike != null) maxAssign += parseFloat(o.strike) * 100 * qty
  }
  const pnlColor = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : undefined
  const deltaColor = Math.abs(netDelta) > 500 ? 'text-orange-400' : undefined
  return [
    { label: 'Mark Value', value: fmt.format(markVal) },
    { label: 'Unrealized P&L', value: `${pnl >= 0 ? '+' : ''}${fmt.format(pnl)}`, color: pnlColor },
    { label: 'Net Δ', value: `${netDelta >= 0 ? '+' : ''}${netDelta.toFixed(0)}`, color: deltaColor },
    { label: 'Daily θ', value: `${dailyTheta >= 0 ? '+' : ''}${fmt.format(dailyTheta)}`, color: 'text-green-400' },
    ...(maxAssign > 0 ? [{ label: 'Max Assign Risk', value: fmt.format(maxAssign), color: 'text-yellow-400' }] : []),
    { label: 'Contracts', value: String(rows.length) },
  ]
}

const today = new Date(); today.setHours(0, 0, 0, 0);
function isExpired(expiration: string | null): boolean {
  if (!expiration) return false;
  return new Date(expiration + 'T16:00:00') < today;
}

function OptionsTable({
  options,
  accountMap,
  livePctByTicker,
}: {
  options: DBOption[]
  accountMap: Map<string, string>
  /** Underlying equity DoD % (×100). */
  livePctByTicker?: Record<string, number | null>
}) {
  const withNickname = options
    .filter(o => !isExpired(o.expiration))
    .map(o => ({ ...o, accountNickname: accountMap.get(o.account) ?? o.account }))
  const groups = groupByAccount(withNickname)
  const order = [...KNOWN_PORTFOLIOS, ...Array.from(groups.keys()).filter(k => !KNOWN_PORTFOLIOS.includes(k))]
  const orderedGroups = order.filter(k => groups.has(k))

  if (options.length === 0) {
    return <p className="text-xs text-amber-200/40 px-3 py-3">No option positions in this snapshot.</p>
  }

  return (
    <div>
      {orderedGroups.map(acct => (
        <AccountGroup key={acct} name={acct} metrics={optionGroupMetrics(groups.get(acct)!)}>
          <table className="w-full">
            <thead>
              <tr className="border-y border-[#d4af37]/20 bg-black">
                <th className={`${TH} text-left`}>Symbol</th>
                <th className={`${TH} text-left`}>Type</th>
                <th className={`${TH} text-right`}>Strike</th>
                <th className={`${TH} text-right`}>Expiry</th>
                <th className={`${TH} text-right`}>Qty</th>
                <th className={`${TH} text-right`}>Mark</th>
                <th className={`${TH} text-right`}>U DoD</th>
                <th className={`${TH} text-right`}>Unrealized P&L</th>
                <th className={`${TH} text-right`}>P&L %</th>
              </tr>
            </thead>
            <tbody>
              {groups.get(acct)!.map((o, i) => {
                const dod = resolveDayPct(o.symbol, null, livePctByTicker)
                return (
                  <tr key={o.id} className={cn('border-b border-zinc-800 hover:bg-amber-500/10 transition-colors', i % 2 === 0 ? 'bg-zinc-900/70' : 'bg-zinc-800/60')}>
                    <td className={`${TD} text-left font-semibold text-white`}>{o.symbol}</td>
                    <td className={`${TD} text-left`}>
                      <span className={cn(
                        'inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded',
                        o.direction?.toLowerCase() === 'short'
                          ? 'bg-green-500/15 text-green-400'
                          : 'bg-blue-500/15 text-blue-400'
                      )}>
                        {o.direction?.toLowerCase() === 'short' ? 'Short' : 'Long'} {o.optionType?.charAt(0).toUpperCase()}{o.optionType?.slice(1).toLowerCase()}
                      </span>
                    </td>
                    <td className={TDr}>{o.strike ? `$${parseFloat(o.strike).toFixed(0)}` : '—'}</td>
                    <td className={TDr}>{o.expiration ?? '—'}</td>
                    <td className={TDr}>{fmtNum(o.qty)}</td>
                    <td className={TDr}>{fmtUsd(o.markPrice)}</td>
                    <td className={cn(TDr, pnlColor(dod))}>{fmtPct(dod)}</td>
                    <td className={cn(TDr, pnlColor(o.unrealizedPnL))}>
                      <span className="inline-flex items-center justify-end gap-1">
                        <PnlIcon v={o.unrealizedPnL} />
                        {fmtUsd(o.unrealizedPnL)}
                      </span>
                    </td>
                    <td className={cn(TDr, pnlColor(o.pnlPct))}>
                      {fmtPct(o.pnlPct)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </AccountGroup>
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

// Exported so the unified sub-tab panel in portfolio-analysis.tsx can share the
// same cached snapshot (same queryKey — react-query dedupes, no extra request).
export function useSnapshotQuery() {
  return useQuery<SnapshotResponse>({
    queryKey: ['portfolio-snapshot-latest'],
    queryFn: async () => {
      const res = await fetch('/api/portfolio/snapshot/latest', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load portfolio')
      return res.json()
    },
  })
}

export { EquityTable, OptionsTable, MetricBanner, equityGroupMetrics, optionGroupMetrics, isExpired }
export type { DBPosition, DBOption }
