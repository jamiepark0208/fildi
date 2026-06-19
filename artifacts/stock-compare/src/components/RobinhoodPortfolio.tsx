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

function AccountGroup({
  name,
  children,
  defaultOpen = true,
}: {
  name: string
  children: React.ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1.5 w-full py-1.5 px-2 rounded hover:bg-secondary/50 transition-colors text-left"
      >
        {open
          ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        }
        <span className="text-xs font-semibold text-foreground/80 uppercase tracking-wide">{name}</span>
      </button>
      {open && <div className="mt-0.5">{children}</div>}
    </div>
  )
}

function EquityTable({ positions }: { positions: DBPosition[] }) {
  const groups = groupByAccount(positions)
  const order = [...KNOWN_PORTFOLIOS, ...Array.from(groups.keys()).filter(k => !KNOWN_PORTFOLIOS.includes(k))]
  const orderedGroups = order.filter(k => groups.has(k))

  if (positions.length === 0) {
    return <p className="text-xs text-muted-foreground px-2 py-3">No equity positions in this snapshot.</p>
  }

  return (
    <div className="space-y-1">
      {orderedGroups.map(acct => (
        <AccountGroup key={acct} name={acct}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground/60 border-b border-border">
                <th className="text-left py-1 px-2 font-medium">Symbol</th>
                <th className="text-right py-1 px-2 font-medium">Qty</th>
                <th className="text-right py-1 px-2 font-medium">Avg Cost</th>
                <th className="text-right py-1 px-2 font-medium">Last</th>
                <th className="text-right py-1 px-2 font-medium">Mkt Value</th>
                <th className="text-right py-1 px-2 font-medium">Unreal P&L</th>
                <th className="text-right py-1 px-2 font-medium">P&L%</th>
              </tr>
            </thead>
            <tbody>
              {groups.get(acct)!.map(p => (
                <tr key={p.id} className="border-b border-border/30 hover:bg-secondary/30 transition-colors">
                  <td className="py-1.5 px-2 font-semibold text-foreground">{p.symbol}</td>
                  <td className="py-1.5 px-2 text-right text-muted-foreground">{fmtNum(p.quantity)}</td>
                  <td className="py-1.5 px-2 text-right text-muted-foreground">{fmtUsd(p.avgCost)}</td>
                  <td className="py-1.5 px-2 text-right text-muted-foreground">{fmtUsd(p.lastPrice)}</td>
                  <td className="py-1.5 px-2 text-right text-muted-foreground">{fmtUsd(p.marketValue)}</td>
                  <td className={cn('py-1.5 px-2 text-right', pnlColor(p.unrealizedPnL))}>
                    <span className="flex items-center justify-end gap-1">
                      <PnlIcon v={p.unrealizedPnL} />
                      {fmtUsd(p.unrealizedPnL)}
                    </span>
                  </td>
                  <td className={cn('py-1.5 px-2 text-right', pnlColor(p.pnlPct))}>
                    {fmtPct(p.pnlPct)}
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

function OptionsTable({ options, accountMap }: { options: DBOption[]; accountMap: Map<string, string> }) {
  // Resolve raw account IDs to nicknames using the map built from positions
  const withNickname = options.map(o => ({ ...o, accountNickname: accountMap.get(o.account) ?? o.account }))
  const groups = groupByAccount(withNickname)
  const order = [...KNOWN_PORTFOLIOS, ...Array.from(groups.keys()).filter(k => !KNOWN_PORTFOLIOS.includes(k))]
  const orderedGroups = order.filter(k => groups.has(k))

  if (options.length === 0) {
    return <p className="text-xs text-muted-foreground px-2 py-3">No option positions in this snapshot.</p>
  }

  return (
    <div className="space-y-1">
      {orderedGroups.map(acct => (
        <AccountGroup key={acct} name={acct}>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-muted-foreground/60 border-b border-border">
                <th className="text-left py-1 px-2 font-medium">Symbol</th>
                <th className="text-left py-1 px-2 font-medium">Type</th>
                <th className="text-right py-1 px-2 font-medium">Strike</th>
                <th className="text-right py-1 px-2 font-medium">Expiry</th>
                <th className="text-right py-1 px-2 font-medium">Qty</th>
                <th className="text-right py-1 px-2 font-medium">Mark</th>
                <th className="text-right py-1 px-2 font-medium">Unreal P&L</th>
                <th className="text-right py-1 px-2 font-medium">P&L%</th>
              </tr>
            </thead>
            <tbody>
              {groups.get(acct)!.map(o => (
                <tr key={o.id} className="border-b border-border/30 hover:bg-secondary/30 transition-colors">
                  <td className="py-1.5 px-2 font-semibold text-foreground">{o.symbol}</td>
                  <td className="py-1.5 px-2">
                    <span className={cn(
                      'inline-flex items-center gap-1 text-xs font-medium',
                      o.direction === 'short' ? 'text-green-400' : 'text-blue-400'
                    )}>
                      {o.direction === 'short' ? 'Short' : 'Long'}{' '}
                      {o.optionType?.charAt(0).toUpperCase()}{o.optionType?.slice(1)}
                    </span>
                  </td>
                  <td className="py-1.5 px-2 text-right text-muted-foreground">
                    {o.strike ? `$${parseFloat(o.strike).toFixed(0)}` : '—'}
                  </td>
                  <td className="py-1.5 px-2 text-right text-muted-foreground">{o.expiration ?? '—'}</td>
                  <td className="py-1.5 px-2 text-right text-muted-foreground">{fmtNum(o.qty)}</td>
                  <td className="py-1.5 px-2 text-right text-muted-foreground">{fmtUsd(o.markPrice)}</td>
                  <td className={cn('py-1.5 px-2 text-right', pnlColor(o.unrealizedPnL))}>
                    <span className="flex items-center justify-end gap-1">
                      <PnlIcon v={o.unrealizedPnL} />
                      {fmtUsd(o.unrealizedPnL)}
                    </span>
                  </td>
                  <td className={cn('py-1.5 px-2 text-right', pnlColor(o.pnlPct))}>
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
          <h2 className="text-sm font-semibold text-foreground">Robinhood Portfolio</h2>
          {importedAt && (
            <p className="text-xs text-muted-foreground/70">Last import: {importedAt}</p>
          )}
        </div>
        <div className="w-72">
          <PortfolioUpload onSuccess={() => refetch()} />
        </div>
      </div>

      {/* Account summary */}
      {snapshot && (
        <div className="flex gap-4">
          <div className="bg-card border border-border rounded-lg px-4 py-2.5">
            <p className="text-xs text-muted-foreground/70">Total Value</p>
            <p className="text-sm font-semibold text-foreground">
              {totalValue != null ? fmt.format(totalValue) : '—'}
            </p>
          </div>
          <div className="bg-card border border-border rounded-lg px-4 py-2.5">
            <p className="text-xs text-muted-foreground/70">Accounts</p>
            <p className="text-sm font-semibold text-foreground">
              {[...new Set(positions.map(p => p.accountNickname ?? p.account))].join(', ') || '—'}
            </p>
          </div>
        </div>
      )}

      {isLoading && (
        <p className="text-xs text-muted-foreground animate-pulse px-2">Loading portfolio…</p>
      )}

      {error && (
        <p className="text-xs text-red-400 px-2">Failed to load portfolio data.</p>
      )}

      {!isLoading && !error && !snapshot && (
        <p className="text-xs text-muted-foreground px-2">
          No snapshot yet. Upload a Robinhood CSV above to get started.
        </p>
      )}

      {/* Equity positions */}
      {positions.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border">
            <h3 className="text-xs font-semibold text-foreground/80 uppercase tracking-wide">
              Equity Positions
              <span className="ml-2 text-muted-foreground/60 font-normal normal-case">
                {positions.length} holdings
              </span>
            </h3>
          </div>
          <div className="px-2 py-1.5">
            <EquityTable positions={positions} />
          </div>
        </div>
      )}

      {/* Option positions */}
      {options.length > 0 && (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border">
            <h3 className="text-xs font-semibold text-foreground/80 uppercase tracking-wide">
              Option Positions
              <span className="ml-2 text-muted-foreground/60 font-normal normal-case">
                {options.length} contracts
              </span>
            </h3>
          </div>
          <div className="px-2 py-1.5">
            <OptionsTable options={options} accountMap={accountMap} />
          </div>
        </div>
      )}
    </div>
  )
}
