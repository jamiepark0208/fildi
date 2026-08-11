import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { X, Plus, RotateCcw, Search } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GroupRef { id: string; name: string }
interface Member { ticker: string; source: "taxonomy" | "manual" }
type Confidence = "override" | "mapped" | "auto" | "unmapped";

interface PeerData {
  ticker: string;
  confidence: Confidence;
  currentGroup: GroupRef | null;
  defaultGroup: GroupRef | null;
  isOverridden: boolean;
  override: { note: string | null; createdAt: string } | null;
  members: Member[];
  availableGroups: GroupRef[];
}

const CONFIDENCE_BADGE: Record<Confidence, string> = {
  override:  "bg-[#d4af37]/15 text-[#d4af37] border-[#d4af37]/40",
  mapped:    "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  auto:      "bg-sky-500/10 text-sky-300 border-sky-500/30",
  unmapped:  "bg-zinc-500/10 text-amber-200/50 border-zinc-500/30",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  override: "Manual override",
  mapped:   "Default (mapped)",
  auto:     "Default (auto)",
  unmapped: "Unmapped",
};

// ── Component ────────────────────────────────────────────────────────────────

export function PeerGroupsTab() {
  const qc = useQueryClient();
  const [tickerInput, setTickerInput] = useState("");
  const [activeTicker, setActiveTicker] = useState("");
  const [reassignTo, setReassignTo] = useState("");
  const [reassignNote, setReassignNote] = useState("");
  const [newPeerTicker, setNewPeerTicker] = useState("");
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, isFetching } = useQuery<PeerData>({
    queryKey: ["peer-groups", activeTicker],
    queryFn: async () => {
      const r = await fetch(`/api/peers/${activeTicker}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!activeTicker,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["peer-groups", activeTicker] });

  const reassignMutation = useMutation({
    mutationFn: async ({ groupId, note }: { groupId: string; note?: string }) => {
      const r = await fetch(`/api/peers/${activeTicker}/group`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId, note: note || undefined }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => { invalidate(); setReassignTo(""); setReassignNote(""); setError(null); },
    onError: (e: Error) => setError(e.message),
  });

  const resetMutation = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/peers/${activeTicker}/group`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => { invalidate(); setError(null); },
    onError: (e: Error) => setError(e.message),
  });

  const addMemberMutation = useMutation({
    mutationFn: async (peerTicker: string) => {
      if (!data?.currentGroup) throw new Error("ticker has no peer group to add to");
      const r = await fetch(`/api/peers/group/${data.currentGroup.id}/member`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: peerTicker }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => { invalidate(); setNewPeerTicker(""); setError(null); },
    onError: (e: Error) => setError(e.message),
  });

  const removeMemberMutation = useMutation({
    mutationFn: async (peerTicker: string) => {
      if (!data?.currentGroup) throw new Error("no active group");
      const r = await fetch(`/api/peers/group/${data.currentGroup.id}/member/${peerTicker}`, {
        method: "DELETE", credentials: "include",
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => { invalidate(); setError(null); },
    onError: (e: Error) => setError(e.message),
  });

  const loadTicker = () => {
    const t = tickerInput.trim().toUpperCase();
    if (t) setActiveTicker(t);
  };

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div className="text-xs text-amber-200/50">
        Every ticker is auto-classified into a peer group used for sector-relative fundamental scoring.
        Look up a ticker to see its current group and roster, reassign it to a different group, or
        add/remove specific peers. Changes are immediate and feed straight into scoring.
      </div>

      {/* Ticker search */}
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-amber-200/30" />
          <input
            value={tickerInput}
            onChange={e => setTickerInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && loadTicker()}
            placeholder="Ticker (e.g. NVDA)"
            className="pl-7 pr-2 py-1.5 text-xs bg-zinc-950 border border-[#d4af37]/25 rounded-md text-white w-48 focus:outline-none focus:border-[#d4af37]/60"
          />
        </div>
        <button
          onClick={loadTicker}
          className="text-xs px-3 py-1.5 border border-[#d4af37]/25 rounded-md text-amber-200/70 hover:text-[#d4af37] hover:border-[#d4af37]/50 transition-colors"
        >
          Look up
        </button>
        {isFetching && <span className="text-[11px] text-amber-200/30">loading…</span>}
      </div>

      {error && (
        <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/5 rounded-md px-3 py-2">{error}</div>
      )}

      {activeTicker && isLoading && (
        <div className="text-xs text-amber-200/40">Loading {activeTicker}…</div>
      )}

      {activeTicker && data && (
        <div className="flex flex-col gap-4">
          {/* Current classification */}
          <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-white">{data.ticker}</span>
                <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", CONFIDENCE_BADGE[data.confidence])}>
                  {CONFIDENCE_LABEL[data.confidence]}
                </span>
              </div>
              {data.isOverridden && (
                <button
                  onClick={() => resetMutation.mutate()}
                  disabled={resetMutation.isPending}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 border border-[#d4af37]/25 rounded-md text-amber-200/60 hover:text-[#d4af37] disabled:opacity-40"
                >
                  <RotateCcw className="h-3 w-3" /> Reset to default
                </button>
              )}
            </div>

            <div className="text-xs text-amber-200/70">
              Current group: <span className="text-white font-medium">{data.currentGroup?.name ?? "— unmapped —"}</span>
              {data.currentGroup && <span className="text-amber-200/30"> ({data.currentGroup.id})</span>}
            </div>

            {data.isOverridden && data.defaultGroup && data.defaultGroup.id !== data.currentGroup?.id && (
              <div className="text-xs text-amber-200/40">
                System default would be: <span className="text-amber-200/70">{data.defaultGroup.name}</span>{" "}
                <span className="text-amber-200/30">({data.defaultGroup.id})</span>
              </div>
            )}
            {data.override?.note && (
              <div className="text-[11px] text-amber-200/40 italic">Note: {data.override.note}</div>
            )}

            {/* Reassign */}
            <div className="flex items-center gap-2 pt-2 border-t border-[#d4af37]/10">
              <select
                value={reassignTo}
                onChange={e => setReassignTo(e.target.value)}
                className="text-xs bg-zinc-900 border border-[#d4af37]/25 rounded-md px-2 py-1.5 text-white focus:outline-none focus:border-[#d4af37]/60"
              >
                <option value="">Reassign to group…</option>
                {data.availableGroups.map(g => (
                  <option key={g.id} value={g.id}>{g.name}</option>
                ))}
              </select>
              <input
                value={reassignNote}
                onChange={e => setReassignNote(e.target.value)}
                placeholder="note (optional)"
                className="text-xs bg-zinc-900 border border-[#d4af37]/25 rounded-md px-2 py-1.5 text-white flex-1 focus:outline-none focus:border-[#d4af37]/60"
              />
              <button
                onClick={() => reassignTo && reassignMutation.mutate({ groupId: reassignTo, note: reassignNote })}
                disabled={!reassignTo || reassignMutation.isPending}
                className="text-xs px-3 py-1.5 rounded-md bg-[#d4af37] text-black font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Reassign
              </button>
            </div>
          </div>

          {/* Roster table */}
          <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
            <div className="px-3 py-2 border-b border-[#d4af37]/20 text-[11px] font-semibold text-[#d4af37]/80 uppercase tracking-wide">
              Sector Peers {data.currentGroup ? `— ${data.currentGroup.name}` : ""}
            </div>
            {!data.currentGroup ? (
              <div className="px-3 py-3 text-xs text-amber-200/40">
                {data.ticker} is unmapped — assign it to a peer group above before adding peers.
              </div>
            ) : (
              <>
                <table className="text-xs w-full border-collapse">
                  <thead className="bg-black text-[#d4af37]">
                    <tr className="border-b border-[#d4af37]/25">
                      <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1.5">Ticker</th>
                      <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1.5">Source</th>
                      <th className="text-right font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1.5">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-zinc-800">
                    {data.members.length === 0 && (
                      <tr><td colSpan={3} className="px-2.5 py-3 text-center text-amber-200/30">No other peers in this group.</td></tr>
                    )}
                    {data.members.map(m => (
                      <tr key={m.ticker} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                        <td className="px-2.5 py-1.5 text-white font-medium">{m.ticker}</td>
                        <td className="px-2.5 py-1.5">
                          <span className={cn(
                            "text-[10px] font-semibold px-1.5 py-0.5 rounded border",
                            m.source === "manual" ? "bg-[#d4af37]/15 text-[#d4af37] border-[#d4af37]/40" : "bg-zinc-500/10 text-amber-200/50 border-zinc-500/30",
                          )}>
                            {m.source}
                          </span>
                        </td>
                        <td className="px-2.5 py-1.5 text-right">
                          <button
                            onClick={() => removeMemberMutation.mutate(m.ticker)}
                            disabled={removeMemberMutation.isPending}
                            className="text-amber-200/40 hover:text-red-400 disabled:opacity-30"
                            title="Remove peer"
                          >
                            <X className="h-3.5 w-3.5 inline" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex items-center gap-2 px-3 py-2 border-t border-[#d4af37]/20">
                  <input
                    value={newPeerTicker}
                    onChange={e => setNewPeerTicker(e.target.value.toUpperCase())}
                    onKeyDown={e => e.key === "Enter" && newPeerTicker.trim() && addMemberMutation.mutate(newPeerTicker.trim())}
                    placeholder="Add peer ticker…"
                    className="text-xs bg-zinc-900 border border-[#d4af37]/25 rounded-md px-2 py-1.5 text-white w-40 focus:outline-none focus:border-[#d4af37]/60"
                  />
                  <button
                    onClick={() => newPeerTicker.trim() && addMemberMutation.mutate(newPeerTicker.trim())}
                    disabled={!newPeerTicker.trim() || addMemberMutation.isPending}
                    className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-md border border-[#d4af37]/25 text-amber-200/70 hover:text-[#d4af37] hover:border-[#d4af37]/50 disabled:opacity-40"
                  >
                    <Plus className="h-3 w-3" /> Add peer
                  </button>
                  <span className="text-[11px] text-amber-200/30">
                    The added ticker will see this group's members as its own peers too.
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
