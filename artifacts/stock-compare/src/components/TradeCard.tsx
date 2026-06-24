import { useState } from "react"
import { Link } from "wouter"
import { cn } from "@/lib/utils"
import { Heart, MessageCircle, TrendingUp } from "lucide-react"

export interface TradePost {
  id: number
  ticker: string
  tradeType: string
  strike: number
  expiry: string
  contracts: number
  premiumPerContract: number
  confidence: number
  notes: string | null
  signalAtEntry: string | null
  regimeAtEntry: string | null
  ivRankAtEntry: number | null
  vixAtEntry?: number | null
  status: string
  closePremium: number | null
  resolvedPnl: number | null
  direction: string | null
  entryPrice: number | null
  shares: number | null
  stopLoss: number | null
  targetPrice: number | null
  createdAt: string
  username: string
  avatarUrl: string | null
  likeCount: number
  commentCount: number
  likedByMe: boolean
}

interface Comment {
  id: number
  postId: number
  userId: number
  username: string
  avatarUrl: string | null
  body: string
  createdAt: string
}

interface TradeCardProps {
  post: TradePost
  showUser?: boolean
  isOwner?: boolean
  onLike: () => void
  onUnlike: () => void
  onComment: (body: string) => void
  onClose: (closePremium: number) => void
  onDelete: () => void
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
}

function fmtExpiry(iso: string): string {
  const d = new Date(iso + "T00:00:00")
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" })
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  return fmtDate(iso)
}

function weeklyIncome(premiumPerContract: number, expiry: string): string {
  const days = (new Date(expiry).getTime() - Date.now()) / 86400000
  if (days <= 0) return "$0/wk"
  return `$${(premiumPerContract / (days / 7)).toFixed(2)}/wk`
}

const CONFIDENCE_LABEL: Record<number, { label: string; cls: string }> = {
  1: { label: "Speculative", cls: "text-muted-foreground" },
  2: { label: "Low",         cls: "text-orange-400" },
  3: { label: "Moderate",    cls: "text-yellow-400" },
  4: { label: "High",        cls: "text-green-400" },
  5: { label: "Strong",      cls: "text-emerald-400" },
}

function ConfidenceLabel({ value }: { value: number }) {
  const { label, cls } = CONFIDENCE_LABEL[value] ?? { label: "—", cls: "text-muted-foreground" }
  return <span className={cn("text-xs font-semibold", cls)}>{label}</span>
}

function SignalBadge({ signal }: { signal: string | null }) {
  if (!signal) return null
  const cls = signal === "GO"
    ? "bg-green-500/15 text-green-400 border-green-500/30"
    : signal === "WATCH"
    ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
    : "bg-secondary text-muted-foreground border-border"
  return (
    <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded border tracking-wide", cls)}>
      {signal}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    OPEN:          { label: "OPEN",     cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
    CLOSED:        { label: "CLOSED",   cls: "bg-secondary text-muted-foreground border-border" },
    EXPIRED_WIN:   { label: "WIN",      cls: "bg-green-500/15 text-green-400 border-green-500/30" },
    EXPIRED_LOSS:  { label: "LOSS",     cls: "bg-red-500/15 text-red-400 border-red-500/30" },
    ASSIGNED:      { label: "ASSIGNED", cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  }
  const { label, cls } = map[status] ?? { label: status, cls: "bg-secondary text-muted-foreground border-border" }
  return <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded border tracking-wide", cls)}>{label}</span>
}

function AvatarInitial({ username, avatarUrl, size = "sm" }: { username: string; avatarUrl: string | null; size?: "sm" | "xs" }) {
  const dim = size === "xs" ? "w-5 h-5 text-[10px]" : "w-6 h-6 text-xs"
  if (avatarUrl) return <img src={avatarUrl} alt={username} className={cn(dim, "rounded-full object-cover")} />
  return (
    <div className={cn(dim, "rounded-full bg-primary/20 flex items-center justify-center font-bold text-primary")}>
      {username[0]?.toUpperCase()}
    </div>
  )
}

export function TradeCard({ post, showUser = true, isOwner = false, onLike, onUnlike, onComment, onClose, onDelete }: TradeCardProps) {
  const [showClose, setShowClose]       = useState(false)
  const [closePremium, setClosePremium] = useState("")
  const [showComments, setShowComments] = useState(false)
  const [comments, setComments]         = useState<Comment[] | null>(null)
  const [loadingComments, setLoadingComments] = useState(false)
  const [commentBody, setCommentBody]   = useState("")

  const closePremiumNum = parseFloat(closePremium)
  const pnlPreview = !isNaN(closePremiumNum)
    ? (post.premiumPerContract - closePremiumNum) * post.contracts * 100
    : null

  async function toggleComments() {
    if (showComments) { setShowComments(false); return }
    setShowComments(true)
    if (comments !== null) return
    setLoadingComments(true)
    try {
      const r = await fetch(`/api/feed/posts/${post.id}`, { credentials: "include" })
      const d = await r.json()
      setComments(d.comments ?? [])
    } finally {
      setLoadingComments(false)
    }
  }

  async function submitComment() {
    const body = commentBody.trim()
    if (!body) return
    onComment(body)
    setCommentBody("")
    setComments(prev => prev ? [...prev, {
      id: Date.now(), postId: post.id, userId: 0,
      username: "you", avatarUrl: null, body, createdAt: new Date().toISOString()
    }] : null)
  }

  const isEquity = post.tradeType === "LONG" || post.tradeType === "SHORT"
  const totalPremium = post.premiumPerContract * post.contracts * 100

  return (
    <div className="bg-card border border-border rounded-lg p-3 shadow-sm space-y-2.5">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="text-sm font-bold text-white bg-white/10 px-2 py-0.5 rounded shrink-0">
            {post.ticker}
          </span>
          <StatusBadge status={post.status} />
          <SignalBadge signal={post.signalAtEntry} />
          {post.regimeAtEntry && (
            <span className="hidden sm:inline text-[10px] text-muted-foreground/60 font-medium">
              {post.regimeAtEntry}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ConfidenceLabel value={post.confidence} />
          {showUser && (
            <Link href={`/profile/${post.username}`} className="flex items-center gap-1 hover:opacity-80 transition-opacity">
              <AvatarInitial username={post.username} avatarUrl={post.avatarUrl} size="xs" />
              <span className="text-[10px] text-muted-foreground">{post.username}</span>
            </Link>
          )}
        </div>
      </div>

      {/* Trade details — layout branches on trade category */}
      {isEquity ? (
        <div className="grid grid-cols-4 gap-x-3 gap-y-0.5">
          {[
            { label: "Direction", val: post.direction?.toUpperCase() ?? "—", color: post.direction === "long" ? "text-green-400" : "text-red-400" },
            { label: "Entry",     val: post.entryPrice != null ? `$${post.entryPrice}` : "—" },
            { label: "Shares",    val: post.shares != null ? String(post.shares) : "—" },
            { label: "Stop",      val: post.stopLoss != null ? `$${post.stopLoss}` : "—", dim: true },
          ].map(({ label, val, color, dim }) => (
            <div key={label} className="space-y-0">
              <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">{label}</div>
              <div className={cn("text-sm font-semibold", color ?? (dim ? "text-muted-foreground" : "text-foreground"))}>{val}</div>
            </div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-4 gap-x-3 gap-y-0.5">
          <div className="space-y-0">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Strike</div>
            <div className="text-sm font-semibold text-foreground">${post.strike}</div>
          </div>
          <div className="space-y-0">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Expiry</div>
            <div className="text-sm font-semibold text-foreground">{fmtExpiry(post.expiry)}</div>
          </div>
          <div className="space-y-0">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Premium</div>
            <div className="text-sm font-semibold text-foreground">${post.premiumPerContract}<span className="text-[10px] text-muted-foreground/60">×{post.contracts}</span></div>
          </div>
          <div className="space-y-0">
            <div className="text-[10px] text-muted-foreground/60 uppercase tracking-wide">Total</div>
            <div className="text-sm font-semibold text-green-400">${totalPremium.toFixed(0)}</div>
          </div>
        </div>
      )}

      {/* Notes */}
      {post.notes && (
        <div className="pl-2.5 border-l-2 border-border text-xs text-muted-foreground/80 italic leading-relaxed">
          {post.notes}
        </div>
      )}

      {/* Context chips */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground/60">
        {!isEquity && post.ivRankAtEntry != null && <span>IV Rank {post.ivRankAtEntry}%</span>}
        {!isEquity && post.vixAtEntry != null && <span>VIX {post.vixAtEntry}</span>}
        {isEquity && post.targetPrice != null && <span>Target ${post.targetPrice}</span>}
        {!isEquity && <><span className="text-muted-foreground/40">·</span><span>{weeklyIncome(post.premiumPerContract, post.expiry)}</span></>}
        <span className="ml-auto text-muted-foreground/50">{timeAgo(post.createdAt)}</span>
      </div>

      {/* P&L (closed) */}
      {post.status !== "OPEN" && post.resolvedPnl != null && (
        <div className={cn("text-sm font-bold", post.resolvedPnl >= 0 ? "text-green-400" : "text-red-400")}>
          {post.resolvedPnl >= 0 ? "+" : ""}${post.resolvedPnl.toFixed(0)} P&L
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-0.5 border-t border-border/50">
        <div className="flex items-center gap-3">
          <button
            onClick={post.likedByMe ? onUnlike : onLike}
            className={cn(
              "flex items-center gap-1 text-xs transition-colors",
              post.likedByMe ? "text-red-400 hover:text-red-300" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Heart className={cn("w-3 h-3", post.likedByMe && "fill-current")} />
            {post.likeCount}
          </button>
          <button
            onClick={toggleComments}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <MessageCircle className="w-3 h-3" />
            {post.commentCount}
          </button>
        </div>

        {isOwner && post.status === "OPEN" && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowClose(v => !v)}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Close
            </button>
            <button
              onClick={onDelete}
              className="text-xs text-red-400/60 hover:text-red-400 transition-colors"
            >
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Inline close form */}
      {showClose && (
        <div className="border border-border rounded-lg p-3 space-y-2 bg-background/50">
          <div className="text-xs text-muted-foreground font-medium">Cost to close per contract</div>
          <input
            type="number" min="0" step="0.01"
            value={closePremium}
            onChange={e => setClosePremium(e.target.value)}
            placeholder="0.00"
            className="w-full bg-secondary border border-border rounded px-2 py-1.5 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {pnlPreview != null && (
            <div className={cn("text-xs font-medium", pnlPreview >= 0 ? "text-green-400" : "text-red-400")}>
              ({post.premiumPerContract} − {closePremiumNum}) × {post.contracts} × 100 = ${pnlPreview.toFixed(0)}
            </div>
          )}
          <div className="flex gap-2">
            <button
              disabled={isNaN(closePremiumNum)}
              onClick={() => { onClose(closePremiumNum); setShowClose(false); setClosePremium("") }}
              className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded hover:bg-primary/90 transition-colors disabled:opacity-40"
            >
              Confirm
            </button>
            <button
              onClick={() => { setShowClose(false); setClosePremium("") }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Comments */}
      {showComments && (
        <div className="border-t border-border pt-2.5 space-y-2">
          {loadingComments && <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>}
          {comments?.map(c => (
            <div key={c.id} className="flex gap-2">
              <AvatarInitial username={c.username} avatarUrl={c.avatarUrl} size="xs" />
              <div>
                <span className="text-xs font-medium text-foreground mr-1.5">{c.username}</span>
                <span className="text-xs text-muted-foreground">{c.body}</span>
                <div className="text-[10px] text-muted-foreground/40 mt-0.5">{timeAgo(c.createdAt)}</div>
              </div>
            </div>
          ))}
          <div className="flex gap-2 pt-1">
            <input
              type="text"
              value={commentBody}
              onChange={e => setCommentBody(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submitComment()}
              placeholder="Add a comment…"
              maxLength={500}
              className="flex-1 bg-secondary border border-border rounded px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
            <button
              onClick={submitComment}
              disabled={!commentBody.trim()}
              className="text-xs bg-primary text-primary-foreground px-3 py-1.5 rounded hover:bg-primary/90 transition-colors disabled:opacity-40"
            >
              Post
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
