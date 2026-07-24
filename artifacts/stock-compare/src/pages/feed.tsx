import { useState, useMemo } from "react"
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "wouter"
import { X } from "lucide-react"
import { TopNav } from "@/components/top-nav"
import { TradeCard, type TradePost } from "@/components/TradeCard"
import { useAuth } from "@/context/AuthContext"
import { useDebounce } from "@/hooks/use-debounce"
import { cn } from "@/lib/utils"

// ── API ────────────────────────────────────────────────────────────────────────

async function apiFeed(path: string, opts?: RequestInit) {
  const r = await fetch(`/api/feed${path}`, { credentials: "include", ...opts })
  if (!r.ok) throw new Error(await r.text())
  return r.json()
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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!confidence) { setError("Select a confidence level"); return }
    setSubmitting(true); setError(null)
    try {
      const r = await fetch("/api/feed/posts", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, tradeType: "SELL_PUT", strike: parseFloat(strike), expiry, contracts: parseInt(contracts), premiumPerContract: parseFloat(premium), confidence, notes: notes || undefined }),
      })
      if (!r.ok) { const d = await r.json(); setError(d.error ?? "Submit failed"); return }
      setSuccess(true)
      setTimeout(() => { setSuccess(false); onSuccess() }, 1000)
      setTicker(""); setStrike(""); setExpiry(""); setContracts("1"); setPremium(""); setConfidence(0); setNotes("")
    } finally { setSubmitting(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-card border border-border rounded-xl p-4 space-y-3 mb-4">
      <div className="text-sm font-semibold text-foreground">New Trade Idea</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: "Ticker", node: <input required value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} maxLength={10} placeholder="NVDA" className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Strike", node: <input required type="number" min="0" step="0.5" value={strike} onChange={e => setStrike(e.target.value)} placeholder="100" className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Expiry", node: <input required type="date" min={today} value={expiry} onChange={e => setExpiry(e.target.value)} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Contracts", node: <input required type="number" min="1" step="1" value={contracts} onChange={e => setContracts(e.target.value)} className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Option bid price", node: <input required type="number" min="0" step="0.01" value={premium} onChange={e => setPremium(e.target.value)} placeholder="1.50" className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary" /> },
          { label: "Confidence", node: (
            <div className="flex items-center gap-1 h-[34px]">
              {[1,2,3,4,5].map(n => (
                <button key={n} type="button" onClick={() => setConfidence(n)}
                  className={cn("text-lg leading-none transition-colors", n <= confidence ? "text-yellow-400" : "text-muted-foreground/30 hover:text-yellow-400/60")}>●</button>
              ))}
            </div>
          )},
        ].map(({ label, node }) => (
          <div key={label} className="space-y-1">
            <label className="text-xs text-muted-foreground">{label}</label>
            {node}
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Rationale</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Your rationale…"
          className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none" />
      </div>
      {error   && <div className="text-xs text-red-400">{error}</div>}
      {success && <div className="text-xs text-green-400">Posted!</div>}
      <button type="submit" disabled={submitting}
        className="bg-primary text-primary-foreground text-sm px-4 py-1.5 rounded hover:bg-primary/90 transition-colors disabled:opacity-50">
        {submitting ? "Posting…" : "Post Idea"}
      </button>
    </form>
  )
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3 animate-pulse">
      <div className="flex gap-2">
        <div className="h-5 w-16 bg-white/10 rounded" />
        <div className="h-5 w-12 bg-white/10 rounded" />
        <div className="h-5 w-10 bg-white/10 rounded" />
      </div>
      <div className="h-4 w-3/4 bg-white/10 rounded" />
      <div className="h-4 w-1/2 bg-white/10 rounded" />
      <div className="h-3 w-1/4 bg-white/10 rounded" />
    </div>
  )
}

// ── Top Performers ─────────────────────────────────────────────────────────────

type UserStat = { username: string; avatarUrl: string | null; winRate: number; totalPnl: number; resolved: number }

function topPerformers(posts: TradePost[]): UserStat[] {
  const map = new Map<string, { username: string; avatarUrl: string | null; wins: number; losses: number; pnl: number }>()

  for (const p of posts) {
    if (!map.has(p.username)) {
      map.set(p.username, { username: p.username, avatarUrl: p.avatarUrl, wins: 0, losses: 0, pnl: 0 })
    }
    const u = map.get(p.username)!
    const resolved = p.status === "CLOSED" || p.status === "EXPIRED_WIN" || p.status === "EXPIRED_LOSS"
    if (resolved && p.resolvedPnl != null) {
      if (p.resolvedPnl > 0 || p.status === "EXPIRED_WIN") u.wins++
      else u.losses++
      u.pnl += p.resolvedPnl
    }
  }

  return [...map.values()]
    .filter(u => (u.wins + u.losses) >= 2)
    .map(u => ({
      username: u.username,
      avatarUrl: u.avatarUrl,
      winRate: u.wins / (u.wins + u.losses),
      totalPnl: u.pnl,
      resolved: u.wins + u.losses,
    }))
    .sort((a, b) => b.winRate - a.winRate || b.totalPnl - a.totalPnl)
    .slice(0, 3)
}

function TopPerformers({ posts }: { posts: TradePost[] }) {
  const performers = useMemo(() => topPerformers(posts), [posts])

  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3 sticky top-6">
      <div className="text-sm font-semibold text-foreground">Top Performers</div>
      {performers.length === 0 ? (
        <div className="text-xs text-muted-foreground">Not enough data yet</div>
      ) : (
        <div className="space-y-3">
          {performers.map((u, i) => (
            <Link key={u.username} href={`/profile/${u.username}`}>
              <div className="flex items-center gap-3 hover:bg-white/5 rounded-lg px-2 py-1.5 -mx-2 transition-colors cursor-pointer">
                <div className="w-7 h-7 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                  {u.avatarUrl
                    ? <img src={u.avatarUrl} alt={u.username} className="w-7 h-7 rounded-full object-cover" />
                    : u.username[0]?.toUpperCase()
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-muted-foreground/50">#{i + 1}</span>
                    <span className="text-sm font-medium text-foreground truncate">{u.username}</span>
                  </div>
                  <div className={cn("flex items-center gap-2 text-xs", u.resolved < 5 && "opacity-60")}>
                    <span className={cn(u.winRate >= 0.6 ? "text-green-400" : u.winRate >= 0.4 ? "text-yellow-400" : "text-red-400")}>
                      {Math.round(u.winRate * 100)}% WR
                    </span>
                    <span className={cn(u.totalPnl >= 0 ? "text-green-400" : "text-red-400")}>
                      {u.totalPnl >= 0 ? "+" : ""}${u.totalPnl.toFixed(0)}
                    </span>
                    <span className="text-muted-foreground/50">
                      ({u.resolved}{u.resolved < 5 ? " · low n" : ""})
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Feed ───────────────────────────────────────────────────────────────────────

type SortMode = "recent" | "top"

const LIMIT = 50

export default function Feed() {
  const { user: me } = useAuth()
  const qc = useQueryClient()

  const [showForm, setShowForm] = useState(false)
  const [search,   setSearch]   = useState("")
  const [sort,     setSort]     = useState<SortMode>("recent")

  const debouncedSearch = useDebounce(search, 400)

  const isUsername = debouncedSearch.startsWith("@")
  const ticker     = !isUsername && debouncedSearch ? debouncedSearch.toUpperCase() : undefined
  const username   = isUsername ? debouncedSearch.slice(1) : undefined

  const queryKey = ["feed", "posts", ticker, username, sort]

  const {
    data,
    isLoading,
    hasNextPage,
    fetchNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<TradePost[]>({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const params = new URLSearchParams()
      if (ticker)   params.set("ticker", ticker)
      if (username) params.set("username", username)
      params.set("sort", sort)
      params.set("limit", String(LIMIT))
      params.set("offset", String(pageParam))
      const r = await fetch(`/api/feed/posts?${params}`, { credentials: "include" })
      if (!r.ok) throw new Error()
      return r.json()
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => lastPage.length === LIMIT ? allPages.length * LIMIT : undefined,
    staleTime: 60000,
    refetchOnWindowFocus: false,
  })

  const allPosts = useMemo(() => data?.pages.flat() ?? [], [data])

  // Separate "top 100" query for the performers panel — always runs
  const { data: topPosts = [] } = useQuery<TradePost[]>({
    queryKey: ["feed", "posts", "top100"],
    queryFn: () => fetch("/api/feed/posts?sort=top&limit=100", { credentials: "include" }).then(r => r.json()),
    staleTime: 120000,
    refetchOnWindowFocus: false,
  })

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["feed", "posts"] })
  }

  async function handleLike(postId: number) {
    await fetch(`/api/feed/posts/${postId}/like`, { method: "POST", credentials: "include" })
    invalidate()
  }
  async function handleUnlike(postId: number) {
    await fetch(`/api/feed/posts/${postId}/like`, { method: "DELETE", credentials: "include" })
    invalidate()
  }
  async function handleComment(postId: number, body: string) {
    await fetch(`/api/feed/posts/${postId}/comments`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body }) })
    invalidate()
  }
  async function handleClose(postId: number, closePremium: number) {
    await fetch(`/api/feed/posts/${postId}/close`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ closePremium }) })
    invalidate()
  }
  async function handleDelete(postId: number) {
    await fetch(`/api/feed/posts/${postId}`, { method: "DELETE", credentials: "include" })
    invalidate()
  }

  return (
    <div className="min-h-[100dvh] bg-background">
      <TopNav />
      <main className="pt-14 p-6">
        <div className="max-w-5xl mx-auto flex gap-6">

          {/* Feed column */}
          <div className="flex-1 min-w-0 max-w-xl mx-auto lg:mx-0 space-y-4">

            {/* Top bar */}
            <div className="flex items-center justify-between">
              <h1 className="text-xl font-bold text-foreground tracking-tight">Feed</h1>
              <button
                onClick={() => setShowForm(v => !v)}
                className="text-sm bg-primary text-primary-foreground px-4 py-1.5 rounded-full hover:bg-primary/90 transition-colors font-medium"
              >
                {showForm ? "Cancel" : "+ Post Trade Idea"}
              </button>
            </div>

            {/* Submit form */}
            {showForm && (
              <SubmitForm onSuccess={() => { setShowForm(false); invalidate() }} />
            )}

            {/* Search + sort */}
            <div className="flex items-center gap-3">
              {/* Search */}
              <div className="relative flex-1 min-w-[160px]">
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Search ticker or @username"
                  className="w-full bg-secondary border border-border rounded-full px-3.5 py-1.5 text-sm text-foreground pr-8 focus:outline-none focus:ring-1 focus:ring-primary"
                />
                {search && (
                  <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Sort toggle */}
              <div className="flex items-center rounded-full border border-border overflow-hidden shrink-0">
                {(["recent", "top"] as SortMode[]).map(s => (
                  <button key={s} onClick={() => setSort(s)}
                    className={cn(
                      "text-xs px-3.5 py-1.5 transition-colors capitalize font-medium",
                      sort === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                    )}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            {/* Post list */}
            {isLoading ? (
              <div className="space-y-3">
                <SkeletonCard /><SkeletonCard /><SkeletonCard />
              </div>
            ) : allPosts.length === 0 ? (
              <div className="text-sm text-muted-foreground text-center py-16">No trade ideas found.</div>
            ) : (
              <div className="space-y-3">
                {allPosts.map(post => (
                  <TradeCard
                    key={post.id}
                    post={post}
                    showUser={true}
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

            {/* Load more */}
            {!isLoading && hasNextPage && allPosts.length > 0 && (
              <div className="flex justify-center pt-2">
                <button onClick={() => fetchNextPage()} disabled={isFetchingNextPage}
                  className="text-sm text-muted-foreground hover:text-foreground border border-border rounded-full px-6 py-2 transition-colors disabled:opacity-50">
                  {isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </div>

          {/* Right panel — top performers (desktop only) */}
          <div className="hidden lg:block w-[280px] shrink-0">
            <TopPerformers posts={topPosts} />
          </div>

        </div>
      </main>
    </div>
  )
}
