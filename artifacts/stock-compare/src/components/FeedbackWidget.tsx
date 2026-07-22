import { useState } from "react";
import { useLocation } from "wouter";
import { MessageSquarePlus, X } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { toast } from "@/hooks/use-toast";

export function FeedbackWidget() {
  const { user } = useAuth();
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);

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

  return (
    <div className="fixed bottom-5 left-5 z-50">
      {open ? (
        <div className="w-72 bg-card border border-border rounded-xl shadow-lg p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold">Send feedback</span>
            <button onClick={() => setOpen(false)} className="text-muted-foreground hover:text-foreground">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <textarea
            autoFocus
            value={message}
            onChange={e => setMessage(e.target.value)}
            placeholder="What would you like to see improved or added?"
            rows={4}
            maxLength={2000}
            className="w-full text-xs bg-secondary border border-border rounded-md p-2 resize-none focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={submit}
            disabled={submitting || !message.trim()}
            className="w-full text-xs bg-primary text-primary-foreground rounded-md py-1.5 hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {submitting ? "Sending…" : "Send"}
          </button>
        </div>
      ) : (
        <button
          onClick={() => setOpen(true)}
          title="Send feedback"
          className="flex items-center justify-center w-11 h-11 rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90 transition-opacity"
        >
          <MessageSquarePlus className="w-5 h-5" />
        </button>
      )}
    </div>
  );
}
