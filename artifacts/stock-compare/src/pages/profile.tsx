import { useState } from "react"
import { useParams } from "wouter"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Sidebar } from "@/components/sidebar"
import { TradeCard, type TradePost } from "@/components/TradeCard"
import { useAuth } from "@/context/AuthContext"
import { cn } from "@/lib/utils"

// ── API helpers ────────────────────────────────────────────────────────────────

async function apiFeed(path: string, opts?: RequestInit) {
  const r = await fetch(`/api/feed${path}`, { credentials: "include", ...opts })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
}

// ── Submit form ────────────────────────────────────────────────────────────────

interface SubmitFormProps {
  onSuccess: () => void
}

function SubmitForm({ onSuccess }: SubmitFormProps) {
  const [ticker,      setTicker]      = useState("")
  const [strike,      setStrike]      = useState("")
  const [expiry,      setExpiry]      = useState("")
  const [contracts,   setContracts]   = useState("1")
  const [premium,     setPremium]     = useState("")
  const [confidence,  setConfidence]  = useState(0)
  const [notes,       setNotes]       = useState("")
  const [submitting,  setSubmitting]  = useState(false)
  const [error,       setError]       = useState<string | null>(null)
  const [success,     setSuccess]     = useState(false)

  const today = new Date().toISOString().split("T")[0]

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!confidence) { setError("Select a confidence level"); return }
    setSubmitting(true)
    setError(null)
    try {
      const r = await fetch("/api/feed/posts", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, strike: parseFloat(strike), expiry, contracts: parseInt(contracts), premiumPerContract: parseFloat(premium), confidence, notes: notes || undefined }),
      })
      if (r.status === 429) { setError("You already have 3 open trade ideas"); return }
      if (!r.ok) { const d = await r.json(); setError(d.error ?? "Submit failed"); return }
      setSuccess(true)
      setTimeout(() => { setSuccess(false); onSuccess() }, 1200)
      setTicker(""); setStrike(""); setExpiry(""); setContracts("1"); setPremium(""); setConfidence(0); setNotes("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-4 space-y-3 mb-4">
      <div className="text-sm font-semibold text-foreground">New Trade Idea</div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Ticker</label>
          <input required value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())}
            maxLength={10} placeholder="NVDA"
            className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Strike</label>
          <input required type="number" min="0" step="0.5" value={strike} onChange={e => setStrike(e.target.value)}
            placeholder="100"
            className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Expiry</label>
          <input required type="date" min={today} value={expiry} onChange={e => setExpiry(e.target.value)}
            className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Contracts</label>
          <input required type="number" min="1" step="1" value={contracts} onChange={e => setContracts(e.target.value)}
            className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Option bid price</label>
          <input required type="number" min="0" step="0.01" value={premium} onChange={e => setPremium(e.target.value)}
            placeholder="1.50"
            className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Confidence</label>
          <div className="flex items-center gap-1 h-[34px]">
            {[1,2,3,4,5].map(n => (
              <button key={n} type="button" onClick={() => setConfidence(n)}
                className={cn("text-lg leading-none transition-colors", n <= confidence ? "text-yellow-400" : "text-muted-foreground/30 hover:text-yellow-400/60")}>
                ●
              </button>
            ))}
          </div>
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

// ── Stats box ─────────────────────────────────────────────────────────────────

function StatBox({ label, value, colorClass }: { label: string; value: string; colorClass?: string }) {
  return (
    <div className="bg-card border border-border rounded-lg p-3 text-center">
      <div className={cn("text-lg font-bold", colorClass ?? "text-foreground")}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  )
}

// ── Profile page ──────────────────────────────────────────────────────────────

interface ProfileData {
  user: { id: number; username: string; avatarUrl: string | null; role: string; createdAt: string }
  stats: { totalPosts: number; openPosts: number; wins: number; losses: number; closed: number; winRate: number | null; totalPnl: number | null }
  posts: TradePost[]
}

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

  async function handleLike(postId: number) {
    await apiFeed(`/posts/${postId}/like`, { method: "POST" })
    invalidate()
  }

  async function handleUnlike(postId: number) {
    await apiFeed(`/posts/${postId}/like`, { method: "DELETE" })
    invalidate()
  }

  async function handleComment(postId: number, body: string) {
    await apiFeed(`/posts/${postId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    })
    invalidate()
  }

  async function handleClose(postId: number, closePremium: number) {
    await apiFeed(`/posts/${postId}/close`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ closePremium }),
    })
    invalidate()
  }

  async function handleDelete(postId: number) {
    await apiFeed(`/posts/${postId}`, { method: "DELETE" })
    invalidate()
  }

  const winRateColor = data?.stats.winRate == null
    ? "text-muted-foreground"
    : data.stats.winRate >= 0.6 ? "text-green-400"
    : data.stats.winRate >= 0.4 ? "text-yellow-400"
    : "text-red-400"

  const pnlColor = data?.stats.totalPnl == null
    ? "text-muted-foreground"
    : data.stats.totalPnl >= 0 ? "text-green-400" : "text-red-400"

  return (
    <div className="flex min-h-[100dvh] bg-background">
      <Sidebar />
      <main className="flex-1 ml-[var(--sidebar-w)] p-6 max-w-2xl">
        {isLoading && (
          <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
        )}
        {error && (
          <div className="text-sm text-red-400">Failed to load profile.</div>
        )}

        {data && (
          <div className="space-y-6">
            {/* User card */}
            <div className="bg-card border border-border rounded-xl p-5 flex items-center gap-4">
              <div className="w-14 h-14 rounded-full bg-primary/20 flex items-center justify-center text-2xl font-bold text-primary shrink-0">
                {data.user.avatarUrl
                  ? <img src={data.user.avatarUrl} alt={data.user.username} className="w-14 h-14 rounded-full object-cover" />
                  : data.user.username[0]?.toUpperCase()
                }
              </div>
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="text-xl font-bold text-white">{data.user.username}</span>
                  <span className={cn(
                    "text-xs font-semibold px-2 py-0.5 rounded border",
                    data.user.role === "admin"
                      ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
                      : "bg-secondary text-muted-foreground border-border"
                  )}>
                    {data.user.role}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground">
                  Member since {new Date(data.user.createdAt).getFullYear()}
                </div>
              </div>
            </div>

            {/* Stats */}
            <div className="grid grid-cols-4 gap-3">
              <StatBox label="Total Trades" value={String(data.stats.totalPosts)} />
              <StatBox label="Win Rate"
                value={data.stats.winRate != null ? `${Math.round(data.stats.winRate * 100)}%` : "—"}
                colorClass={winRateColor} />
              <StatBox label="Cumulative P&L"
                value={data.stats.totalPnl != null ? `$${data.stats.totalPnl.toFixed(0)}` : "—"}
                colorClass={pnlColor} />
              <StatBox label="Open" value={String(data.stats.openPosts)} />
            </div>

            {/* Post button (own profile only) */}
            {isOwnerProfile && (
              <button
                onClick={() => setShowForm(v => !v)}
                className="text-sm bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors"
              >
                {showForm ? "Cancel" : "Post Trade Idea"}
              </button>
            )}

            {/* Submit form */}
            {isOwnerProfile && showForm && (
              <SubmitForm onSuccess={() => { setShowForm(false); invalidate() }} />
            )}

            {/* Post list */}
            {data.posts.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-8">No trade ideas posted yet.</div>
            ) : (
              <div className="space-y-3">
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
        )}
      </main>
    </div>
  )
}
