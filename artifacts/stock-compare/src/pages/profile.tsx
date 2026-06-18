import { useState } from "react"
import { useParams } from "wouter"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Sidebar } from "@/components/sidebar"
import { TradeCard, type TradePost } from "@/components/TradeCard"
import { useAuth } from "@/context/AuthContext"
import { cn } from "@/lib/utils"
import { TrendingUp, TrendingDown, Minus, X, Plus, Search } from "lucide-react"

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

function SubmitForm({ onSuccess }: { onSuccess: () => void }) {
  const [ticker,     setTicker]     = useState("")
  const [strike,     setStrike]     = useState("")
  const [expiry,     setExpiry]     = useState("")
  const [contracts,  setContracts]  = useState("1")
  const [premium,    setPremium]    = useState("")
  const [confidence, setConfidence] = useState(0)
  const [notes,      setNotes]      = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState<string | null>(null)
  const [success,    setSuccess]    = useState(false)

  const today = new Date().toISOString().split("T")[0]

  const CONFIDENCE_OPTS = ["Speculative", "Low", "Moderate", "High", "Strong"]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!confidence) { setError("Select a confidence level"); return }
    setSubmitting(true); setError(null)
    try {
      const r = await fetch("/api/feed/posts", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, strike: parseFloat(strike), expiry, contracts: parseInt(contracts), premiumPerContract: parseFloat(premium), confidence, notes: notes || undefined }),
      })
      if (r.status === 429) { setError("You already have 3 open trade ideas"); return }
      if (!r.ok) { const d = await r.json(); setError(d.error ?? "Submit failed"); return }
      setSuccess(true)
      setTimeout(() => { setSuccess(false); onSuccess() }, 1200)
      setTicker(""); setStrike(""); setExpiry(""); setContracts("1"); setPremium(""); setConfidence(0); setNotes("")
    } finally { setSubmitting(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-4 space-y-3 mb-4">
      <div className="text-sm font-semibold text-foreground">New Trade Idea</div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: "Ticker", el: <input required value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} maxLength={10} placeholder="NVDA" className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Strike", el: <input required type="number" min="0" step="0.5" value={strike} onChange={e => setStrike(e.target.value)} placeholder="100" className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Expiry", el: <input required type="date" min={today} value={expiry} onChange={e => setExpiry(e.target.value)} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Contracts", el: <input required type="number" min="1" step="1" value={contracts} onChange={e => setContracts(e.target.value)} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Option bid", el: <input required type="number" min="0" step="0.01" value={premium} onChange={e => setPremium(e.target.value)} placeholder="1.50" className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
        ].map(({ label, el }) => (
          <div key={label} className="space-y-1">
            <label className="text-xs text-muted-foreground">{label}</label>
            {el}
          </div>
        ))}
      </div>

      {/* Confidence pill selector */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Confidence</label>
        <div className="flex gap-1.5 flex-wrap">
          {CONFIDENCE_OPTS.map((label, i) => {
            const val = i + 1
            const colors = ["text-muted-foreground border-border", "text-orange-400 border-orange-500/40", "text-yellow-400 border-yellow-500/40", "text-green-400 border-green-500/40", "text-emerald-400 border-emerald-500/40"]
            const active = ["bg-secondary", "bg-orange-500/15", "bg-yellow-500/15", "bg-green-500/15", "bg-emerald-500/15"]
            return (
              <button key={val} type="button" onClick={() => setConfidence(val)}
                className={cn("text-xs px-2.5 py-1 rounded-full border font-medium transition-all",
                  colors[i],
                  confidence === val ? active[i] : "bg-transparent opacity-50 hover:opacity-80"
                )}>
                {label}
              </button>
            )
          })}
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

      <button type="submit" disabled={submitting}
        className="bg-primary text-primary-foreground text-sm px-4 py-1.5 rounded hover:bg-primary/90 transition-colors disabled:opacity-50">
        {submitting ? "Posting…" : "Post Idea"}
      </button>
    </form>
  )
}

// ── Stock Buckets panel ────────────────────────────────────────────────────────

const BUCKETS = [
  { key: "BULLISH",  label: "Bullish",  icon: TrendingUp,   color: "text-green-400",  border: "border-green-500/30",  bg: "bg-green-500/5",  pill: "bg-green-500/15 text-green-400 border-green-500/30" },
  { key: "NEUTRAL",  label: "Neutral",  icon: Minus,        color: "text-yellow-400", border: "border-yellow-500/30", bg: "bg-yellow-500/5", pill: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30" },
  { key: "BEARISH",  label: "Bearish",  icon: TrendingDown, color: "text-red-400",    border: "border-red-500/30",    bg: "bg-red-500/5",    pill: "bg-red-500/15 text-red-400 border-red-500/30" },
] as const

type BucketKey = "BULLISH" | "NEUTRAL" | "BEARISH"

function BucketsPanel({ isOwner, viewUsername }: { isOwner: boolean; viewUsername: string }) {
  const qc = useQueryClient()
  const [inputs, setInputs] = useState<Record<BucketKey, string>>({ BULLISH: "", NEUTRAL: "", BEARISH: "" })
  const [adding, setAdding] = useState<Record<BucketKey, boolean>>({ BULLISH: false, NEUTRAL: false, BEARISH: false })

  // All users' buckets
  const { data: allBuckets = [], isLoading } = useQuery<BucketEntry[]>({
    queryKey: ["feed", "buckets"],
    queryFn: () => apiFeed("/buckets"),
    staleTime: 30000,
    refetchOnWindowFocus: false,
  })

  // My own buckets (for owner: to show which are mine so I can delete)
  const { data: mineBuckets = [] } = useQuery<{ ticker: string; bucket: BucketKey }[]>({
    queryKey: ["feed", "buckets", "mine"],
    queryFn: () => apiFeed("/buckets/mine"),
    staleTime: 30000,
    enabled: isOwner,
  })

  const myTickers = new Set(mineBuckets.map(b => b.ticker))

  async function addTicker(bucket: BucketKey) {
    const ticker = inputs[bucket].trim().toUpperCase()
    if (!ticker) return
    setAdding(prev => ({ ...prev, [bucket]: true }))
    try {
      await apiFeed("/buckets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, bucket }),
      })
      setInputs(prev => ({ ...prev, [bucket]: "" }))
      qc.invalidateQueries({ queryKey: ["feed", "buckets"] })
    } finally {
      setAdding(prev => ({ ...prev, [bucket]: false }))
    }
  }

  async function removeTicker(ticker: string) {
    await apiFeed(`/buckets/${ticker}`, { method: "DELETE" })
    qc.invalidateQueries({ queryKey: ["feed", "buckets"] })
  }

  // Group all buckets by bucket type, then group tickers by who picked them
  function bucketsFor(bucketKey: BucketKey) {
    return allBuckets.filter(b => b.bucket === bucketKey)
  }

  // Tickers in this bucket: deduplicate, show usernames per ticker
  function tickerGroups(bucketKey: BucketKey) {
    const entries = bucketsFor(bucketKey)
    const map = new Map<string, string[]>()
    for (const e of entries) {
      const list = map.get(e.ticker) ?? []
      list.push(e.username)
      map.set(e.ticker, list)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }

  return (
    <div className="space-y-2">
      <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Stock Sentiment</div>
      <div className="grid grid-cols-3 gap-3">
        {BUCKETS.map(({ key, label, icon: Icon, color, border, bg, pill }) => {
          const groups = tickerGroups(key)
          return (
            <div key={key} className={cn("rounded-xl border p-3 space-y-2.5", border, bg)}>
              {/* Bucket header */}
              <div className={cn("flex items-center gap-1.5 text-xs font-bold", color)}>
                <Icon className="w-3.5 h-3.5" />
                {label}
                <span className="ml-auto text-[10px] font-normal text-muted-foreground/60">{groups.length}</span>
              </div>

              {/* Ticker list */}
              <div className="space-y-1 min-h-[40px]">
                {isLoading ? (
                  <span className="text-[10px] text-muted-foreground/40 animate-pulse">Loading…</span>
                ) : groups.length === 0 ? (
                  <span className="text-[10px] text-muted-foreground/40">No picks yet</span>
                ) : (
                  groups.map(([ticker, usernames]) => (
                    <div key={ticker} className="flex items-center gap-1.5 group">
                      <span className={cn("text-xs font-bold px-1.5 py-0.5 rounded border", pill)}>
                        {ticker}
                      </span>
                      <span className="text-[10px] text-muted-foreground/50 truncate flex-1">
                        {usernames.join(", ")}
                      </span>
                      {isOwner && myTickers.has(ticker) && (
                        <button
                          onClick={() => removeTicker(ticker)}
                          className="opacity-0 group-hover:opacity-100 text-muted-foreground/40 hover:text-red-400 transition-all"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>

              {/* Add input (own profile only) */}
              {isOwner && (
                <div className="flex gap-1">
                  <input
                    value={inputs[key]}
                    onChange={e => setInputs(prev => ({ ...prev, [key]: e.target.value.toUpperCase() }))}
                    onKeyDown={e => e.key === "Enter" && addTicker(key)}
                    placeholder="Ticker"
                    maxLength={10}
                    className="flex-1 min-w-0 bg-background/60 border border-border/60 rounded px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                  <button
                    onClick={() => addTicker(key)}
                    disabled={!inputs[key].trim() || adding[key]}
                    className={cn("px-1.5 py-1 rounded text-xs transition-colors disabled:opacity-30", color, "hover:bg-white/10")}
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
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
    <div className="flex min-h-[100dvh] bg-background">
      <Sidebar />
      <main className="flex-1 ml-[var(--sidebar-w)] p-5 max-w-2xl space-y-5">

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

            {/* ── Stock Sentiment Buckets ── */}
            <BucketsPanel isOwner={isOwnerProfile} viewUsername={username} />

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
