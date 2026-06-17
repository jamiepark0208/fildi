import { useState } from "react"
import { cn } from "@/lib/utils"
import { Heart, MessageCircle } from "lucide-react"

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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function weeklyIncome(premiumPerContract: number, expiry: string): string {
  const days = (new Date(expiry).getTime() - Date.now()) / 86400000
  if (days <= 0) return "$0/wk"
  const weekly = premiumPerContract / (days / 7)
  return `$${weekly.toFixed(2)}/wk`
}

function SignalBadge({ signal }: { signal: string | null }) {
  if (!signal) return null
  const cls = signal === "GO"
    ? "bg-green-500/15 text-green-400 border-green-500/30"
    : signal === "WATCH"
    ? "bg-yellow-500/15 text-yellow-400 border-yellow-500/30"
    : "bg-secondary text-muted-foreground border-border"
  return (
    <span className={cn("text-xs font-semibold px-2 py-0.5 rounded border", cls)}>
      {signal}
    </span>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    OPEN:          { label: "OPEN",    cls: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
    CLOSED:        { label: "CLOSED",  cls: "bg-secondary text-muted-foreground border-border" },
    EXPIRED_WIN:   { label: "WIN",     cls: "bg-green-500/15 text-green-400 border-green-500/30" },
    EXPIRED_LOSS:  { label: "LOSS",    cls: "bg-red-500/15 text-red-400 border-red-500/30" },
    ASSIGNED:      { label: "ASSIGNED",cls: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  }
  const { label, cls } = map[status] ?? { label: status, cls: "bg-secondary text-muted-foreground border-border" }
  return (
    <span className={cn("text-xs font-semibold px-2 py-0.5 rounded border", cls)}>{label}</span>
  )
}

function ConfidenceDots({ value }: { value: number }) {
  return (
    <span className="text-sm tracking-wide text-yellow-400">
      {[1,2,3,4,5].map(i => i <= value ? "●" : "○").join("")}
    </span>
  )
}

function AvatarInitial({ username, avatarUrl }: { username: string; avatarUrl: string | null }) {
  if (avatarUrl) {
    return <img src={avatarUrl} alt={username} className="w-6 h-6 rounded-full object-cover" />
  }
  return (
    <div className="w-6 h-6 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary">
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
    // optimistically append
    setComments(prev => prev ? [...prev, {
      id: Date.now(), postId: post.id, userId: 0,
      username: "you", avatarUrl: null, body, createdAt: new Date().toISOString()
    }] : null)
  }

  return (
    <div className="bg-card border border-border rounded-xl p-4 shadow-sm space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-bold text-white bg-white/10 px-2 py-0.5 rounded">
            {post.ticker}
          </span>
          <SignalBadge signal={post.signalAtEntry} />
          <StatusBadge status={post.status} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ConfidenceDots value={post.confidence} />
          {showUser && (
            <div className="flex items-center gap-1.5">
              <AvatarInitial username={post.username} avatarUrl={post.avatarUrl} />
              <span className="text-xs text-muted-foreground">{post.username}</span>
            </div>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="space-y-1.5">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-foreground">
          <span>Strike <strong>${post.strike}</strong></span>
          <span>Exp <strong>{post.expiry}</strong></span>
          <span><strong>{post.contracts}</strong> contract{post.contracts !== 1 ? "s" : ""}</span>
          <span><strong>${post.premiumPerContract}</strong>/contract</span>
          <span className="text-muted-foreground">{weeklyIncome(post.premiumPerContract, post.expiry)}</span>
        </div>

        {post.notes && (
          <div className="pl-3 border-l-2 border-border text-xs text-muted-foreground/80 italic leading-relaxed">
            {post.notes}
          </div>
        )}
      </div>

      {/* Snapshot row */}
      {(post.ivRankAtEntry != null || post.regimeAtEntry || post.vixAtEntry != null) && (
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground/70">
          {post.ivRankAtEntry != null && <span>IV Rank: {post.ivRankAtEntry}%</span>}
          {post.regimeAtEntry  && <span>Regime: {post.regimeAtEntry}</span>}
          {post.vixAtEntry != null && <span>VIX: {post.vixAtEntry}</span>}
          <span>{timeAgo(post.createdAt)}</span>
        </div>
      )}

      {/* P&L (closed) */}
      {post.status !== "OPEN" && post.resolvedPnl != null && (
        <div className={cn("text-sm font-semibold", post.resolvedPnl >= 0 ? "text-green-400" : "text-red-400")}>
          {post.resolvedPnl >= 0 ? "+" : ""}${post.resolvedPnl.toFixed(0)} P&L
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between pt-1">
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
              className="text-xs text-red-400/70 hover:text-red-400 transition-colors"
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
            type="number"
            min="0"
            step="0.01"
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

      {/* Comments section */}
      {showComments && (
        <div className="border-t border-border pt-3 space-y-2">
          {loadingComments && (
            <span className="text-xs text-muted-foreground animate-pulse">Loading…</span>
          )}
          {comments?.map(c => (
            <div key={c.id} className="flex gap-2">
              <AvatarInitial username={c.username} avatarUrl={c.avatarUrl} />
              <div>
                <span className="text-xs font-medium text-foreground mr-1.5">{c.username}</span>
                <span className="text-xs text-muted-foreground">{c.body}</span>
                <div className="text-[10px] text-muted-foreground/50 mt-0.5">{timeAgo(c.createdAt)}</div>
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
