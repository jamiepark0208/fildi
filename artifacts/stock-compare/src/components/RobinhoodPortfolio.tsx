import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronRight, ChevronDown, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PortfolioUpload } from './PortfolioUpload'

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

const TH = 'py-2 px-3 font-medium text-[10px] uppercase tracking-widest text-white/35'
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
          <span className="text-white/30 uppercase tracking-widest">{m.label}</span>
          <span className={cn('font-mono font-semibold tabular-nums', m.color ?? 'text-white/70')}>{m.value}</span>
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
        className="flex items-center gap-2 w-full py-2 px-3 hover:bg-white/5 transition-colors text-left"
      >
        {open
          ? <ChevronDown className="h-3 w-3 text-white/30" />
          : <ChevronRight className="h-3 w-3 text-white/30" />
        }
        <span className="text-[11px] font-semibold text-white/60 uppercase tracking-widest mr-2">{name}</span>
        {metrics && <MetricBanner metrics={metrics} />}
      </button>
      {open && children}
    </div>
  )
}

function equityGroupMetrics(rows: DBPosition[]): MetricPill[] {
  let mktVal = 0, pnl = 0, costBasis = 0
  for (const r of rows) {
    if (r.marketValue != null) mktVal += parseFloat(r.marketValue)
    if (r.unrealizedPnL != null) pnl += parseFloat(r.unrealizedPnL)
    if (r.costBasis != null) costBasis += parseFloat(r.costBasis)
  }
  const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : null
  const pnlColor = pnl > 0 ? 'text-green-400' : pnl < 0 ? 'text-red-400' : undefined
  return [
    { label: 'Mkt Value', value: fmt.format(mktVal) },
    { label: 'Unrealized P&L', value: `${pnl >= 0 ? '+' : ''}${fmt.format(pnl)}`, color: pnlColor },
    ...(pnlPct != null ? [{ label: 'P&L %', value: `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%`, color: pnlColor }] : []),
    { label: 'Holdings', value: String(rows.length) },
  ]
}

function EquityTable({ positions }: { positions: DBPosition[] }) {
  const groups = groupByAccount(positions)
  const order = [...KNOWN_PORTFOLIOS, ...Array.from(groups.keys()).filter(k => !KNOWN_PORTFOLIOS.includes(k))]
  const orderedGroups = order.filter(k => groups.has(k))

  if (positions.length === 0) {
    return <p className="text-xs text-white/30 px-3 py-3">No equity positions in this snapshot.</p>
  }

  return (
    <div>
      {orderedGroups.map(acct => (
        <AccountGroup key={acct} name={acct} metrics={equityGroupMetrics(groups.get(acct)!)}>
          <table className="w-full">
            <thead>
              <tr className="border-y border-white/8 bg-white/3">
                <th className={`${TH} text-left`}>Symbol</th>
                <th className={`${TH} text-right`}>Qty</th>
                <th className={`${TH} text-right`}>Avg Cost</th>
                <th className={`${TH} text-right`}>Last</th>
                <th className={`${TH} text-right`}>Mkt Value</th>
                <th className={`${TH} text-right`}>Unrealized P&L</th>
                <th className={`${TH} text-right`}>P&L %</th>
              </tr>
            </thead>
            <tbody>
              {groups.get(acct)!.map((p, i) => (
                <tr key={p.id} className={cn('border-b border-white/5 hover:bg-white/5 transition-colors', i % 2 === 0 ? '' : 'bg-white/[0.02]')}>
                  <td className={`${TD} text-left font-semibold text-white`}>{p.symbol}</td>
                  <td className={TDr}>{fmtNum(p.quantity)}</td>
                  <td className={TDr}>{fmtUsd(p.avgCost)}</td>
                  <td className={TDr}>{fmtUsd(p.lastPrice)}</td>
                  <td className={TDr}>{fmtUsd(p.marketValue)}</td>
                  <td className={cn(TDr, pnlColor(p.unrealizedPnL))}>
                    <span className="inline-flex items-center justify-end gap-1">
                      <PnlIcon v={p.unrealizedPnL} />
                      {fmtUsd(p.unrealizedPnL)}
                    </span>
                  </td>
                  <td className={cn(TDr, pnlColor(p.pnlPct))}>{fmtPct(p.pnlPct)}</td>
                </tr>
              ))}
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

function OptionsTable({ options, accountMap }: { options: DBOption[]; accountMap: Map<string, string> }) {
  const withNickname = options.map(o => ({ ...o, accountNickname: accountMap.get(o.account) ?? o.account }))
  const groups = groupByAccount(withNickname)
  const order = [...KNOWN_PORTFOLIOS, ...Array.from(groups.keys()).filter(k => !KNOWN_PORTFOLIOS.includes(k))]
  const orderedGroups = order.filter(k => groups.has(k))

  if (options.length === 0) {
    return <p className="text-xs text-white/30 px-3 py-3">No option positions in this snapshot.</p>
  }

  return (
    <div>
      {orderedGroups.map(acct => (
        <AccountGroup key={acct} name={acct} metrics={optionGroupMetrics(groups.get(acct)!)}>
          <table className="w-full">
            <thead>
              <tr className="border-y border-white/8 bg-white/3">
                <th className={`${TH} text-left`}>Symbol</th>
                <th className={`${TH} text-left`}>Type</th>
                <th className={`${TH} text-right`}>Strike</th>
                <th className={`${TH} text-right`}>Expiry</th>
                <th className={`${TH} text-right`}>Qty</th>
                <th className={`${TH} text-right`}>Mark</th>
                <th className={`${TH} text-right`}>Unrealized P&L</th>
                <th className={`${TH} text-right`}>P&L %</th>
              </tr>
            </thead>
            <tbody>
              {groups.get(acct)!.map((o, i) => (
                <tr key={o.id} className={cn('border-b border-white/5 hover:bg-white/5 transition-colors', i % 2 === 0 ? '' : 'bg-white/[0.02]')}>
                  <td className={`${TD} text-left font-semibold text-white`}>{o.symbol}</td>
                  <td className={`${TD} text-left`}>
                    <span className={cn(
                      'inline-flex items-center text-[11px] font-semibold px-1.5 py-0.5 rounded',
                      o.direction === 'short'
                        ? 'bg-green-500/15 text-green-400'
                        : 'bg-blue-500/15 text-blue-400'
                    )}>
                      {o.direction === 'short' ? 'Short' : 'Long'} {o.optionType?.charAt(0).toUpperCase()}{o.optionType?.slice(1)}
                    </span>
                  </td>
                  <td className={TDr}>{o.strike ? `$${parseFloat(o.strike).toFixed(0)}` : '—'}</td>
                  <td className={TDr}>{o.expiration ?? '—'}</td>
                  <td className={TDr}>{fmtNum(o.qty)}</td>
                  <td className={TDr}>{fmtUsd(o.markPrice)}</td>
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
              ))}
            </tbody>
          </table>
        </AccountGroup>
      ))}
    </div>
  )
}

// ── Main component ─────────────────────────────────────────────────────────────

export function RobinhoodPortfolio() {
  const { data, isLoading, error, refetch } = useQuery<SnapshotResponse>({
    queryKey: ['portfolio-snapshot-latest'],
    queryFn: async () => {
      const res = await fetch('/api/portfolio/snapshot/latest', { credentials: 'include' })
      if (!res.ok) throw new Error('Failed to load portfolio')
      return res.json()
    },
  })

  const snapshot = data?.snapshot ?? null
  const positions = data?.positions ?? []
  const options = data?.options ?? []

  // Build account ID → nickname map from positions (which carry accountNickname)
  const accountMap = new Map<string, string>()
  for (const p of positions) {
    if (p.accountNickname) accountMap.set(p.account, p.accountNickname)
  }

  const totalValue = snapshot?.totalValue ? parseFloat(snapshot.totalValue) : null
  const importedAt = snapshot?.importedAt
    ? new Date(snapshot.importedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null

  return (
    <div className="space-y-4">
      {/* Header + upload */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Robinhood Portfolio</h2>
          {importedAt && (
            <p className="text-[11px] text-white/35 mt-0.5">Last import: {importedAt}</p>
          )}
        </div>
        <div className="w-72">
          <PortfolioUpload onSuccess={() => refetch()} />
        </div>
      </div>

      {isLoading && (
        <p className="text-xs text-white/30 animate-pulse px-2">Loading portfolio…</p>
      )}

      {error && (
        <p className="text-xs text-red-400 px-2">Failed to load portfolio data.</p>
      )}

      {!isLoading && !error && !snapshot && (
        <p className="text-xs text-white/40 px-2">
          No snapshot yet — upload a Robinhood CSV above.
        </p>
      )}

      {/* Equity positions */}
      {positions.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/8">
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-xs font-semibold text-white uppercase tracking-widest">Equity Positions</h3>
              <span className="text-[10px] text-white/30">{positions.length} holdings</span>
            </div>
            <MetricBanner metrics={equityGroupMetrics(positions)} />
          </div>
          <EquityTable positions={positions} />
        </div>
      )}

      {/* Option positions */}
      {options.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-white/8">
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-xs font-semibold text-white uppercase tracking-widest">Option Positions</h3>
              <span className="text-[10px] text-white/30">{options.length} contracts</span>
            </div>
            <MetricBanner metrics={optionGroupMetrics(options.map(o => ({ ...o, accountNickname: accountMap.get(o.account) ?? o.account })))} />
          </div>
          <OptionsTable options={options} accountMap={accountMap} />
        </div>
      )}
    </div>
  )
}
