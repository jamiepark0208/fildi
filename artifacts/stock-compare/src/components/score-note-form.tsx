import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

export function ScoreNoteForm({ ticker }: { ticker: string }) {
  const qc = useQueryClient();
  const [body, setBody] = useState("");
  const [adj, setAdj] = useState("");
  const [open, setOpen] = useState(false);

  const mut = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/stocks/${encodeURIComponent(ticker)}/score-notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body: body.trim(),
          adjPoints: adj.trim() === "" ? null : Number(adj),
          tags: ["thesis"],
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      setBody("");
      setAdj("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["breakdown", ticker] });
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] text-amber-200/60 hover:text-[#d4af37] underline-offset-2 hover:underline"
      >
        + Add score note
      </button>
    );
  }

  return (
    <div className="space-y-1.5 border border-[#d4af37]/20 rounded-md p-2 bg-zinc-950/80">
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Why the score moved / desk thesis…"
        rows={2}
        className="w-full text-[11px] bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-zinc-200 resize-none"
      />
      <div className="flex items-center gap-2">
        <label className="text-[10px] text-amber-100/80 whitespace-nowrap">
          adj pts
          <input
            type="number"
            step="0.5"
            min={-25}
            max={25}
            value={adj}
            onChange={(e) => setAdj(e.target.value)}
            className="ml-1 w-14 text-[11px] bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 font-mono"
            placeholder="—"
          />
        </label>
        <button
          type="button"
          disabled={!body.trim() || mut.isPending}
          onClick={() => mut.mutate()}
          className="text-[10px] font-semibold px-2 py-1 rounded border border-[#d4af37]/50 bg-zinc-900 text-white hover:bg-zinc-800 disabled:opacity-40"
        >
          {mut.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : "Save"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[10px] text-amber-100/80 hover:text-zinc-300"
        >
          Cancel
        </button>
        {mut.isError && (
          <span className="text-[10px] text-red-400">{(mut.error as Error).message}</span>
        )}
      </div>
    </div>
  );
}
