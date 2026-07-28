import { useState } from "react"
import { Link, useLocation } from "wouter"
import { cn } from "@/lib/utils"
import { addToScannerShelf } from "@/lib/ticker-shelf-storage"
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

const STATUS_MAP: Record<string, { label: string; badgeCls: string; cardCls: string }> = {
  OPEN:         { label: "OPEN",     badgeCls: "bg-blue-500/15 text-blue-400 border-blue-500/30",   cardCls: "bg-blue-500/[0.06] border-blue-500/25" },
  CLOSED:       { label: "CLOSED",   badgeCls: "bg-secondary text-muted-foreground border-border",  cardCls: "bg-card border-border" },
  EXPIRED_WIN:  { label: "WIN",      badgeCls: "bg-green-500/15 text-green-400 border-green-500/30", cardCls: "bg-green-500/[0.06] border-green-500/25" },
  EXPIRED_LOSS: { label: "LOSS",     badgeCls: "bg-red-500/15 text-red-400 border-red-500/30",       cardCls: "bg-red-500/[0.06] border-red-500/25" },
  ASSIGNED:     { label: "ASSIGNED", badgeCls: "bg-orange-500/15 text-orange-400 border-orange-500/30", cardCls: "bg-orange-500/[0.06] border-orange-500/25" },
}

function statusStyle(status: string) {
  return STATUS_MAP[status] ?? { label: status, badgeCls: "bg-secondary text-muted-foreground border-border", cardCls: "bg-card border-border" }
}

function StatusBadge({ status }: { status: string }) {
  const { label, badgeCls } = statusStyle(status)
  return <span className={cn("text-[10px] font-bold px-1.5 py-0.5 rounded border tracking-wide shrink-0", badgeCls)}>{label}</span>
}

function AvatarInitial({ username, avatarUrl, size = "sm" }: { username: string; avatarUrl: string | null; size?: "sm" | "xs" | "md" }) {
  const dim = size === "xs" ? "w-5 h-5 text-[10px]" : size === "md" ? "w-9 h-9 text-sm" : "w-6 h-6 text-xs"
  if (avatarUrl) return <img src={avatarUrl} alt={username} className={cn(dim, "rounded-full object-cover")} />
  return (
    <div className={cn(dim, "rounded-full bg-primary/20 flex items-center justify-center font-bold text-primary")}>
      {username[0]?.toUpperCase()}
    </div>
  )
}

export function TradeCard({ post, showUser = true, isOwner = false, onLike, onUnlike, onComment, onClose, onDelete }: TradeCardProps) {
  const [, navigate] = useLocation()
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
  const isResolved = post.status !== "OPEN"
  const { cardCls } = statusStyle(post.status)

  return (
    <div className={cn("border rounded-lg p-2.5 space-y-1.5", cardCls)}>
      {/* Header — identity + ticker/status + trade details, all in one wrapping line */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        {showUser ? (
          <Link href={`/profile/${post.username}`} className="flex items-center gap-1.5 min-w-0 hover:opacity-80 transition-opacity shrink-0">
            <AvatarInitial username={post.username} avatarUrl={post.avatarUrl} size="xs" />
            <span className="text-xs font-bold text-foreground truncate max-w-[100px]">{post.username}</span>
          </Link>
        ) : null}
        <span className="text-sm font-bold text-white bg-white/10 px-1.5 py-0.5 rounded shrink-0">
          {post.ticker}
        </span>
        <StatusBadge status={post.status} />
        <SignalBadge signal={post.signalAtEntry} />

        {/* Trade details — inline with ticker/status, wraps as one unit on narrow widths */}
        {isEquity ? (
          <div className="flex flex-wrap items-baseline gap-x-2.5 text-xs">
            <span className={cn("font-bold", post.direction === "long" ? "text-green-400" : "text-red-400")}>{post.direction?.toUpperCase() ?? "—"}</span>
            {post.entryPrice != null && <span className="text-foreground/90">${post.entryPrice}</span>}
            {post.shares != null && <span className="text-foreground/90">{post.shares}sh</span>}
            {post.stopLoss != null && <span className="text-red-400/80">SL ${post.stopLoss}</span>}
            {post.targetPrice != null && <span className="text-green-400/80">TP ${post.targetPrice}</span>}
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2.5 text-xs text-foreground/90">
            <span>${post.strike}<span className="text-foreground/50">strike</span></span>
            <span>{fmtExpiry(post.expiry)}</span>
            <span>${post.premiumPerContract}×{post.contracts}</span>
            <span className="text-green-400 font-bold">${totalPremium.toFixed(0)}</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-2 shrink-0">
          <ConfidenceLabel value={post.confidence} />
          <span className="text-[10px] text-muted-foreground">{timeAgo(post.createdAt)}</span>
        </div>
      </div>

      {/* Thesis */}
      {post.notes && (
        <div className="text-xs text-foreground/80 leading-snug line-clamp-2">
          <span className="text-[10px] font-bold uppercase tracking-wide text-primary/80 mr-1">Thesis</span>
          {post.notes}
        </div>
      )}

      {/* P&L (resolved) */}
      {isResolved && post.resolvedPnl != null && (
        <div className={cn("text-xs font-bold", post.resolvedPnl >= 0 ? "text-green-400" : "text-red-400")}>
          {post.resolvedPnl >= 0 ? "+" : ""}${post.resolvedPnl.toFixed(0)} P&L
        </div>
      )}

      {/* Action bar */}
      <div className="flex items-center justify-between pt-1 border-t border-border/50">
        <div className="flex items-center gap-3">
          <button
            onClick={post.likedByMe ? onUnlike : onLike}
            className={cn(
              "flex items-center gap-1 text-xs transition-colors",
              post.likedByMe ? "text-red-400 hover:text-red-300" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Heart className={cn("w-3.5 h-3.5", post.likedByMe && "fill-current")} />
            {post.likeCount}
          </button>
          <button
            onClick={toggleComments}
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
          >
            <MessageCircle className="w-3.5 h-3.5" />
            {post.commentCount}
          </button>
          {!isResolved && (
            <button
              onClick={() => { addToScannerShelf(post.ticker); navigate("/options-scanner") }}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <TrendingUp className="w-3.5 h-3.5" />
              Validate in scanner
            </button>
          )}
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
