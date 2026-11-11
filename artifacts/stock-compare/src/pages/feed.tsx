import { useState, useMemo } from "react"
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "wouter"
import { X } from "lucide-react"
import { AppPage } from "@/components/app-page"
import { TradeCard, type TradePost } from "@/components/TradeCard"
import { useAuth } from "@/context/AuthContext"
import { useDebounce } from "@/hooks/use-debounce"
import { cn } from "@/lib/utils"
import { apiFeed } from "@/lib/feed-api"
import { CongressFeedPanel } from "@/components/congress-feed-panel"

// ── API ────────────────────────────────────────────────────────────────────────

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
    <form onSubmit={handleSubmit} className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-2 mb-2">
      <div className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">New Trade Idea</div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {[
          { label: "Ticker", node: <input required value={ticker} onChange={e => setTicker(e.target.value.toUpperCase())} maxLength={10} placeholder="NVDA" className="w-full bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50" /> },
          { label: "Strike", node: <input required type="number" min="0" step="0.5" value={strike} onChange={e => setStrike(e.target.value)} placeholder="100" className="w-full bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50" /> },
          { label: "Expiry", node: <input required type="date" min={today} value={expiry} onChange={e => setExpiry(e.target.value)} className="w-full bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50" /> },
          { label: "Contracts", node: <input required type="number" min="1" step="1" value={contracts} onChange={e => setContracts(e.target.value)} className="w-full bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50" /> },
          { label: "Option bid price", node: <input required type="number" min="0" step="0.01" value={premium} onChange={e => setPremium(e.target.value)} placeholder="1.50" className="w-full bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50" /> },
          { label: "Confidence", node: (
            <div className="flex items-center gap-1 h-[34px]">
              {[1,2,3,4,5].map(n => (
                <button key={n} type="button" onClick={() => setConfidence(n)}
                  className={cn("text-lg leading-none transition-colors", n <= confidence ? "text-[#d4af37]" : "text-amber-200/20 hover:text-[#d4af37]/60")}>●</button>
              ))}
            </div>
          )},
        ].map(({ label, node }) => (
          <div key={label} className="space-y-1">
            <label className="text-xs text-amber-100">{label}</label>
            {node}
          </div>
        ))}
      </div>
      <div className="space-y-1">
        <label className="text-xs text-amber-100">Rationale</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} placeholder="Your rationale…"
          className="w-full bg-zinc-900 border border-[#d4af37]/20 rounded px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-[#d4af37]/50 resize-none" />
      </div>
      {error   && <div className="text-xs text-red-400">{error}</div>}
      {success && <div className="text-xs text-green-400">Posted!</div>}
      <button type="submit" disabled={submitting}
        className="bg-[#d4af37] text-black text-sm font-semibold px-4 py-1.5 rounded hover:bg-[#d4af37]/90 transition-colors disabled:opacity-40">
        {submitting ? "Posting…" : "Post Idea"}
      </button>
    </form>
  )
}

// ── Skeleton ───────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-2 animate-pulse">
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
    <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 space-y-2">
      <div className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Top Performers</div>
      {performers.length === 0 ? (
        <div className="text-xs text-amber-100">Not enough data yet</div>
      ) : (
        <div className="space-y-3">
          {performers.map((u, i) => (
            <Link key={u.username} href={`/profile/${u.username}`}>
              <div className="flex items-center gap-3 hover:bg-amber-500/10 rounded-lg px-2 py-1.5 -mx-2 transition-colors cursor-pointer">
                <div className="w-7 h-7 rounded-full bg-[#d4af37]/20 flex items-center justify-center text-xs font-bold text-[#d4af37] shrink-0">
                  {u.avatarUrl
                    ? <img src={u.avatarUrl} alt={u.username} className="w-7 h-7 rounded-full object-cover" />
                    : u.username[0]?.toUpperCase()
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs text-amber-100/80">#{i + 1}</span>
                    <span className="text-sm font-medium text-white truncate">{u.username}</span>
                  </div>
                  <div className={cn("flex items-center gap-2 text-xs", u.resolved < 5 && "opacity-60")}>
                    <span className={cn(u.winRate >= 0.6 ? "text-green-400" : u.winRate >= 0.4 ? "text-yellow-400" : "text-red-400")}>
                      {Math.round(u.winRate * 100)}% WR
                    </span>
                    <span className={cn(u.totalPnl >= 0 ? "text-green-400" : "text-red-400")}>
                      {u.totalPnl >= 0 ? "+" : ""}${u.totalPnl.toFixed(0)}
                    </span>
                    <span className="text-amber-100/80">
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
    <AppPage contentClassName="p-6">
        <div className="max-w-5xl mx-auto flex gap-6">

          {/* Feed column */}
          <div className="flex-1 min-w-0 max-w-xl mx-auto lg:mx-0 space-y-4">

            {/* Top bar */}
            <div className="flex items-center justify-between">
              <h1 className="text-lg font-bold text-[#d4af37] tracking-tight">Feed</h1>
              <button
                onClick={() => setShowForm(v => !v)}
                className="text-[11px] font-semibold px-3 py-1.5 rounded border bg-[#d4af37] text-black border-[#d4af37] hover:bg-[#d4af37]/90 transition-colors"
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
                  className="w-full bg-white border border-[#d4af37]/30 rounded-full px-3.5 py-1.5 text-sm text-black placeholder:text-amber-100/80 pr-8 focus:outline-none focus:ring-2 focus:ring-[#d4af37]/50"
                />
                {search && (
                  <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-amber-100/80 hover:text-black">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {/* Sort toggle */}
              <div className="flex items-center rounded-full border border-[#d4af37]/20 overflow-hidden shrink-0">
                {(["recent", "top"] as SortMode[]).map(s => (
                  <button key={s} onClick={() => setSort(s)}
                    className={cn(
                      "text-xs px-3.5 py-1.5 transition-colors capitalize font-medium",
                      sort === s ? "bg-[#d4af37] text-black" : "text-amber-100 hover:text-[#d4af37]"
                    )}>
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <CongressFeedPanel className="lg:hidden" />

            {/* Post list */}
            {isLoading ? (
              <div className="space-y-3">
                <SkeletonCard /><SkeletonCard /><SkeletonCard />
              </div>
            ) : allPosts.length === 0 ? (
              <div className="text-sm text-amber-100 text-center py-16">No trade ideas found.</div>
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
                  className="text-sm text-amber-100 hover:text-[#d4af37] border border-[#d4af37]/20 rounded-full px-6 py-2 transition-colors disabled:opacity-50">
                  {isFetchingNextPage ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </div>

          {/* Right panel — top performers (desktop only) */}
          <div className="hidden lg:block w-[280px] shrink-0 space-y-3 sticky top-6 self-start">
            <TopPerformers posts={topPosts} />
            <CongressFeedPanel />
          </div>

        </div>
    </AppPage>
  )
}
