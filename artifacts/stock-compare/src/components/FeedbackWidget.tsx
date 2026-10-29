import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { MessageSquarePlus, Minus, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { toast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const POS_KEY = "fildi.feedback.pos";
const MIN_KEY = "fildi.feedback.minimized";
const FAB = 44;
const MARGIN = 12;

type Pos = { x: number; y: number };

function clampPos(p: Pos): Pos {
  const maxX = Math.max(MARGIN, window.innerWidth - FAB - MARGIN);
  const maxY = Math.max(MARGIN, window.innerHeight - FAB - MARGIN);
  return {
    x: Math.min(maxX, Math.max(MARGIN, p.x)),
    y: Math.min(maxY, Math.max(MARGIN, p.y)),
  };
}

/** Default: bottom-right — left edge is where ticker tables live. */
function defaultPos(): Pos {
  return clampPos({
    x: window.innerWidth - FAB - 20,
    y: window.innerHeight - FAB - 20,
  });
}

function readPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Pos;
      if (typeof p?.x === "number" && typeof p?.y === "number") return clampPos(p);
    }
  } catch { /* ignore */ }
  return defaultPos();
}

function readMinimized(): boolean {
  try {
    return localStorage.getItem(MIN_KEY) === "1";
  } catch {
    return false;
  }
}

export function FeedbackWidget() {
  const { user } = useAuth();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [pos, setPos] = useState<Pos>(() =>
    typeof window === "undefined" ? { x: 20, y: 20 } : readPos(),
  );
  const [minimized, setMinimized] = useState(() =>
    typeof window === "undefined" ? false : readMinimized(),
  );
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const posRef = useRef(pos);
  posRef.current = pos;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const persistPos = useCallback((p: Pos) => {
    const next = clampPos(p);
    setPos(next);
    posRef.current = next;
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(next));
    } catch { /* ignore */ }
  }, []);

  const setMinimizedPersist = useCallback((v: boolean) => {
    setMinimized(v);
    try {
      localStorage.setItem(MIN_KEY, v ? "1" : "0");
    } catch { /* ignore */ }
  }, []);

  if (!user) return null;

  async function submit() {
    if (!message.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: message.trim(), page: location }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        toast({ title: "Couldn't send feedback", description: body.error ?? "Unknown error", variant: "destructive" });
        return;
      }
      setMessage("");
      setOpen(false);
      toast({ title: "Feedback sent", description: "Thanks — this goes straight to the team." });
    } finally {
      setSubmitting(false);
    }
  }

  function onPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    // Don't start drag from textarea / send — only chrome / FAB.
    const t = e.target as HTMLElement;
    if (t.closest("textarea, input, [data-no-drag]")) return;
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      originY: pos.y,
      moved: false,
    };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && dx * dx + dy * dy < 25) return;
    d.moved = true;
    const next = clampPos({ x: d.originX + dx, y: d.originY + dy });
    posRef.current = next;
    setPos(next);
  }

  function onPointerUp(e: React.PointerEvent) {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    drag.current = null;
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
    if (d.moved) {
      persistPos(posRef.current);
      return;
    }
    // Click without drag → open (FAB) or restore (minimized chip)
    if (minimized) {
      setMinimizedPersist(false);
      return;
    }
    if (!open) setOpen(true);
  }

  if (minimized) {
    return (
      <div
        ref={rootRef}
        className="fixed z-50 touch-none"
        style={{ left: pos.x, top: pos.y }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <button
          type="button"
          title="Show feedback (drag to move)"
          className="flex items-center gap-1 h-7 pl-2 pr-2.5 rounded-full bg-zinc-900/90 border border-[#d4af37]/40 text-[#d4af37] shadow-md hover:bg-zinc-800 cursor-grab active:cursor-grabbing"
        >
          <MessageSquarePlus className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[10px] font-semibold uppercase tracking-wide">Fb</span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="fixed z-50 touch-none"
      style={{ left: pos.x, top: pos.y }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {open ? (
        <div
          className={cn(
            "w-72 bg-card border border-border rounded-xl shadow-lg p-3 space-y-2",
            // Keep panel on-screen when FAB is near the right/bottom edge
            pos.x > window.innerWidth / 2 ? "origin-top-right -translate-x-[calc(100%-2.75rem)]" : "",
            pos.y > window.innerHeight / 2 ? "-translate-y-[calc(100%+0.5rem)]" : "translate-y-12",
          )}
        >
          <div className="flex items-center justify-between cursor-grab active:cursor-grabbing">
            <span className="text-xs font-semibold">Send feedback</span>
            <div className="flex items-center gap-1" data-no-drag>
              <button
                type="button"
                title="Minimize"
                onClick={() => {
                  setOpen(false);
                  setMinimizedPersist(true);
                }}
                className="text-amber-100 hover:text-foreground p-0.5"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title="Close"
                onClick={() => setOpen(false)}
                className="text-amber-100 hover:text-foreground p-0.5"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
          <textarea
            autoFocus
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="What would you like to see improved or added?"
            rows={4}
            maxLength={2000}
            className="w-full text-xs bg-secondary border border-border rounded-md p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            type="button"
            data-no-drag
            onClick={() => void submit()}
            disabled={submitting || !message.trim()}
            className="w-full text-xs bg-primary text-primary-foreground rounded-md py-1.5 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Send"}
          </button>
        </div>
      ) : (
        <div className="relative">
          <button
            type="button"
            title="Send feedback — drag to move, or minimize"
            className="flex items-center justify-center w-11 h-11 rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90 transition-opacity cursor-grab active:cursor-grabbing"
          >
            <MessageSquarePlus className="w-5 h-5 pointer-events-none" />
          </button>
          <button
            type="button"
            data-no-drag
            title="Minimize"
            onClick={(e) => {
              e.stopPropagation();
              setMinimizedPersist(true);
            }}
            className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-zinc-950 border border-white/25 text-white hover:border-[#d4af37]/50 hover:text-[#d4af37]"
          >
            <Minus className="w-2.5 h-2.5" />
          </button>
        </div>
      )}
    </div>
  );
}
