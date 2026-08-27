import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { X, Plus, RotateCcw, Star } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GroupRef { id: string; name: string }
// isRepresentative: this peer's own scoring cohort (primary_peer_group_id) is this
// group — i.e. it's actually grouped in for fundamental percentile scoring, not just
// shown here for comparison.
interface Member { ticker: string; source: "taxonomy" | "manual"; isRepresentative: boolean }
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

/** Editable peer-group membership for a single ticker — reassign group, add/remove peer tags. */
export function PeerGroupEditor({ ticker }: { ticker: string }) {
  const qc = useQueryClient();
  const [reassignTo, setReassignTo] = useState("");
  const [reassignNote, setReassignNote] = useState("");
  const [newPeerTicker, setNewPeerTicker] = useState("");
  const [addingPeer, setAddingPeer] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading } = useQuery<PeerData>({
    queryKey: ["peer-groups", ticker],
    queryFn: async () => {
      const r = await fetch(`/api/peers/${ticker}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    enabled: !!ticker,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["peer-groups", ticker] });

  const reassignMutation = useMutation({
    mutationFn: async ({ groupId, note }: { groupId: string; note?: string }) => {
      const r = await fetch(`/api/peers/${ticker}/group`, {
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
      const r = await fetch(`/api/peers/${ticker}/group`, { method: "DELETE", credentials: "include" });
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
    onSuccess: () => { invalidate(); setNewPeerTicker(""); setAddingPeer(false); setError(null); },
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

  // Marking a peer representative reassigns *that peer's own* scoring group to this
  // group (same mechanism as the "Reassign" control above); un-marking clears its
  // override and lets it fall back to its default classification.
  const setRepresentativeMutation = useMutation({
    mutationFn: async (peerTicker: string) => {
      if (!data?.currentGroup) throw new Error("no active group");
      const r = await fetch(`/api/peers/${peerTicker}/group`, {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: data.currentGroup.id, note: "marked representative via peer tag" }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => { invalidate(); setError(null); },
    onError: (e: Error) => setError(e.message),
  });

  const unsetRepresentativeMutation = useMutation({
    mutationFn: async (peerTicker: string) => {
      const r = await fetch(`/api/peers/${peerTicker}/group`, { method: "DELETE", credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error ?? `HTTP ${r.status}`);
      return r.json();
    },
    onSuccess: () => { invalidate(); setError(null); },
    onError: (e: Error) => setError(e.message),
  });

  if (isLoading || !data) {
    return <div className="text-xs text-amber-200/40">Loading {ticker}…</div>;
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      {error && (
        <div className="text-xs text-red-400 border border-red-500/30 bg-red-500/5 rounded-md px-3 py-2">{error}</div>
      )}

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

      {/* Roster — tags */}
      <div className="rounded-md border border-[#d4af37]/25 bg-zinc-950 shadow-lg shadow-black/60 p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold text-[#d4af37]/80 uppercase tracking-wide">
            Sector Peers {data.currentGroup ? `— ${data.currentGroup.name}` : ""}
          </div>
          {data.currentGroup && (
            <div className="flex items-center gap-3 text-[10px] text-amber-200/40">
              <span className="flex items-center gap-1">
                <Star className="h-2.5 w-2.5 fill-emerald-400 text-emerald-400" /> Representative (used in scoring)
              </span>
              <span className="flex items-center gap-1">
                <Star className="h-2.5 w-2.5 text-amber-200/30" /> Display only
              </span>
            </div>
          )}
        </div>
        {!data.currentGroup ? (
          <div className="text-xs text-amber-200/40">
            {data.ticker} is unmapped — assign it to a peer group above before adding peers.
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {data.members.length === 0 && (
              <span className="text-xs text-amber-200/30">No other peers in this group.</span>
            )}
            {data.members.map(m => (
              <span
                key={m.ticker}
                title={`${m.source === "manual" ? "manually added" : "from taxonomy"} · ${m.isRepresentative ? "used in this group's fundamental scoring" : "display peer only — scored against its own group"}`}
                className={cn(
                  "inline-flex items-center gap-1 pl-1 pr-1 py-1 rounded-full border text-xs font-medium",
                  m.isRepresentative
                    ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
                    : "bg-zinc-900 border-zinc-700 text-amber-100/60",
                )}
              >
                <button
                  onClick={() => (m.isRepresentative
                    ? unsetRepresentativeMutation.mutate(m.ticker)
                    : setRepresentativeMutation.mutate(m.ticker))}
                  disabled={setRepresentativeMutation.isPending || unsetRepresentativeMutation.isPending}
                  className="rounded-full hover:bg-emerald-500/20 p-0.5 disabled:opacity-30"
                  title={m.isRepresentative ? "Remove representative status" : "Mark as representative (used in scoring)"}
                >
                  <Star className={cn("h-3 w-3", m.isRepresentative ? "fill-emerald-400 text-emerald-400" : "text-amber-200/30")} />
                </button>
                {m.ticker}
                <button
                  onClick={() => removeMemberMutation.mutate(m.ticker)}
                  disabled={removeMemberMutation.isPending}
                  className="rounded-full hover:bg-red-500/20 hover:text-red-400 p-0.5 disabled:opacity-30"
                  title="Remove peer from roster"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}

            {addingPeer ? (
              <span className="inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full border border-dashed border-[#d4af37]/40 bg-zinc-900">
                <input
                  autoFocus
                  value={newPeerTicker}
                  onChange={e => setNewPeerTicker(e.target.value.toUpperCase())}
                  onKeyDown={e => {
                    if (e.key === "Enter" && newPeerTicker.trim()) addMemberMutation.mutate(newPeerTicker.trim());
                    if (e.key === "Escape") { setAddingPeer(false); setNewPeerTicker(""); }
                  }}
                  onBlur={() => { if (!newPeerTicker.trim()) setAddingPeer(false); }}
                  placeholder="TICKER"
                  className="w-16 bg-transparent text-xs text-white focus:outline-none"
                />
                <button
                  onClick={() => newPeerTicker.trim() && addMemberMutation.mutate(newPeerTicker.trim())}
                  disabled={!newPeerTicker.trim() || addMemberMutation.isPending}
                  className="text-[#d4af37] disabled:opacity-30"
                  title="Confirm"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </span>
            ) : (
              <button
                onClick={() => setAddingPeer(true)}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-full border border-dashed border-[#d4af37]/30 text-[11px] text-amber-200/50 hover:text-[#d4af37] hover:border-[#d4af37]/60 transition-colors"
              >
                <Plus className="h-3 w-3" /> Add peer
              </button>
            )}
          </div>
        )}
        {data.currentGroup && (
          <div className="text-[11px] text-amber-200/30 pt-1">
            Added tickers will see this group's members as their own peers too. Only representative peers
            are grouped together for fundamental scoring — the rest are shown for comparison only.
          </div>
        )}
      </div>
    </div>
  );
}
