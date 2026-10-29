// Breakdown › Notes (Jamie 10-28): short dated stock/options context per ticker — good/bad trades, earnings
// behaviour, levels, backtests, character. Agents read these before analysing a ticker (scripts/stock_notes.py)
// and the AI explain prompts include them. Store: /api/stocks/:t/score-notes (fund_score_notes, kind in tags).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

const KINDS = ["trade", "earnings", "levels", "backtest", "character", "lesson", "thesis"] as const;
const MAX = 280;

const KIND_CLASS: Record<string, string> = {
  trade: "text-emerald-300 border-emerald-500/30",
  earnings: "text-rose-300 border-rose-500/30",
  levels: "text-sky-300 border-sky-500/30",
  backtest: "text-violet-300 border-violet-500/30",
  character: "text-amber-300 border-amber-500/30",
  lesson: "text-orange-300 border-orange-500/30",
  thesis: "text-[#d4af37] border-[#d4af37]/30",
};

interface Note {
  id: number;
  asOf: string;
  body: string;
  author: string | null;
  tags: string[];
  adjPoints: number | null;
}

function kindOf(tags: string[]): string {
  return tags.find((t) => (KINDS as readonly string[]).includes(t)) ?? "note";
}

function sourceOf(tags: string[]): string | null {
  return tags.find((t) => t.startsWith("src:"))?.slice(4) ?? null;
}

function daysAgo(asOf: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(`${asOf}T12:00:00`).getTime()) / 86_400_000));
}

export function StockNotesPanel({ ticker, isAdmin }: { ticker: string; isAdmin: boolean }) {
  const qc = useQueryClient();
  const key = ["stock-notes", ticker];
  const { data, isLoading } = useQuery({
    queryKey: key,
    queryFn: async () => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/score-notes`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return (await r.json()) as { notes: Note[] };
    },
    staleTime: 60_000,
  });
  const [kind, setKind] = useState<(typeof KINDS)[number]>("trade");
  const [body, setBody] = useState("");

  const add = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/score-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: body.trim(), tags: [kind], adjPoints: null }),
      });
      if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { error?: string }).error || `HTTP ${r.status}`);
    },
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: key });
    },
  });
  const del = useMutation({
    mutationFn: async (id: number) => {
      await fetch(`/api/stocks/${encodeURIComponent(ticker)}/score-notes/${id}`, { method: "DELETE" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const notes = data?.notes ?? [];
  return (
    <div className="space-y-1.5">
      {isAdmin && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim()) add.mutate();
          }}
        >
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as (typeof KINDS)[number])}
            className="bg-zinc-900 border border-[#d4af37]/25 rounded text-[10px] text-amber-100 px-1 py-0.5"
          >
            {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <input
            value={body}
            maxLength={MAX}
            onChange={(e) => setBody(e.target.value)}
            placeholder="One concise fact, e.g. 'sold 20p @0.23 into 10% rally — fine, IV rich'"
            className="flex-1 min-w-0 bg-zinc-900 border border-[#d4af37]/25 rounded text-[10px] text-white px-1.5 py-0.5"
          />
          <span className="text-[9px] text-amber-100 tabular-nums">{MAX - body.length}</span>
          <button type="submit" disabled={!body.trim() || add.isPending} className="text-[10px] text-[#d4af37] px-1.5 border border-[#d4af37]/30 rounded">
            {add.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : "Add"}
          </button>
        </form>
      )}
      {add.isError && <p className="text-[10px] text-red-400">{String((add.error as Error).message)}</p>}
      {isLoading ? (
        <p className="text-[10px] text-amber-100 italic">Loading notes…</p>
      ) : notes.length === 0 ? (
        <p className="text-[10px] text-amber-100 italic">No notes yet for {ticker}.</p>
      ) : (
        <ul className="space-y-1">
          {notes.map((n) => {
            const k = kindOf(n.tags);
            const src = sourceOf(n.tags);
            const age = daysAgo(n.asOf);
            return (
              <li key={n.id} className="flex items-start gap-1.5 text-[11px] leading-snug">
                <span className={cn("font-mono text-[10px] shrink-0 tabular-nums", age > 90 ? "text-amber-100/70" : "text-white")} title={`${age} days ago — past context, not a forecast`}>
                  {n.asOf}
                </span>
                <span className={cn("shrink-0 rounded border px-1 text-[9px] uppercase", KIND_CLASS[k] ?? "text-amber-100 border-amber-500/30")}>{k}</span>
                <span className="text-white min-w-0">
                  {n.body}
                  {src && <span className="text-amber-100"> · {src}</span>}
                  {n.author && <span className="text-amber-100"> · {n.author.replace(/^user:\d+$/, "Jamie")}</span>}
                </span>
                {isAdmin && (
                  <button type="button" onClick={() => del.mutate(n.id)} className="ml-auto shrink-0 text-amber-100 hover:text-red-400" title="Delete note">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
