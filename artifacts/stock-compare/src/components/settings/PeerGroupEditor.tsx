import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { X, Plus, RotateCcw } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface GroupRef { id: string; name: string }
/** scoredHere = ticker's primary_peer_group_id is this group (used in sector percentiles). */
interface Member { ticker: string; source: "taxonomy" | "manual" | "auto"; isRepresentative: boolean }
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
export function PeerGroupEditor({ ticker, compact = false }: { ticker: string; compact?: boolean }) {
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

  if (isLoading || !data) {
    return <div className="text-xs text-amber-200/40">Loading {ticker}…</div>;
  }

  if (compact) {
    return (
      <div className="flex flex-col gap-1.5 text-[10px]">
        {error && <div className="text-red-400">{error}</div>}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-bold text-white font-mono">{data.ticker}</span>
          <span className={cn("font-semibold px-1 py-0.5 rounded border text-[9px]", CONFIDENCE_BADGE[data.confidence])}>
            {CONFIDENCE_LABEL[data.confidence]}
          </span>
          <span className="text-amber-200/50">·</span>
          <span className="text-amber-200/70 truncate">
            {data.currentGroup?.name ?? "unmapped"}
          </span>
          {data.isOverridden && (
            <button
              onClick={() => resetMutation.mutate()}
              disabled={resetMutation.isPending}
              className="text-[9px] text-amber-200/50 hover:text-[#d4af37] underline"
            >
              Reset
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 min-w-0">
          <select
            value={reassignTo}
            onChange={e => setReassignTo(e.target.value)}
            className="text-[10px] bg-zinc-900 border border-[#d4af37]/25 rounded px-1.5 py-0.5 text-white max-w-[40%] focus:outline-none"
          >
            <option value="">Reassign…</option>
            {data.availableGroups.map(g => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <button
            onClick={() => reassignTo && reassignMutation.mutate({ groupId: reassignTo, note: reassignNote })}
            disabled={!reassignTo || reassignMutation.isPending}
            className="text-[10px] px-2 py-0.5 rounded bg-[#d4af37] text-black font-semibold disabled:opacity-40"
          >
            Go
          </button>
          {!addingPeer ? (
            <button
              type="button"
              onClick={() => setAddingPeer(true)}
              className="text-[9px] text-amber-200/50 hover:text-[#d4af37] ml-auto"
            >
              + peer
            </button>
          ) : (
            <input
              autoFocus
              value={newPeerTicker}
              onChange={e => setNewPeerTicker(e.target.value.toUpperCase())}
              onKeyDown={e => {
                if (e.key === "Enter" && newPeerTicker.trim()) {
                  addMemberMutation.mutate(newPeerTicker.trim());
                  setNewPeerTicker("");
                  setAddingPeer(false);
                }
                if (e.key === "Escape") setAddingPeer(false);
              }}
              placeholder="TICKER"
              className="text-[10px] bg-zinc-900 border border-[#d4af37]/25 rounded px-1.5 py-0.5 text-white w-16 ml-auto focus:outline-none"
            />
          )}
        </div>
        <div className="flex flex-wrap gap-1">
          {data.members.slice(0, 24).map(m => (
            <span
              key={m.ticker}
              title={m.isRepresentative ? "Scored in this group" : "Display peer only (scored in its own primary group)"}
              className={cn(
                "inline-flex items-center gap-0.5 pl-1.5 pr-1 py-0.5 rounded border font-mono text-[9px]",
                m.isRepresentative
                  ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
                  : "bg-zinc-900 border-zinc-700 text-amber-100/60",
              )}
            >
              {m.ticker}
              <button
                onClick={() => removeMemberMutation.mutate(m.ticker)}
                className="p-0.5 hover:text-red-400"
                title="Remove from roster"
              >
                <X className="h-2.5 w-2.5" />
              </button>
            </span>
          ))}
          {data.members.length > 24 && (
            <span className="text-[9px] text-amber-200/40 self-center">+{data.members.length - 24}</span>
          )}
        </div>
      </div>
    );
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
                <span className="inline-block w-2 h-2 rounded-full bg-emerald-400" /> Scored here
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-full bg-zinc-500" /> Display only
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
                title={`${m.source} · ${m.isRepresentative ? "scored in this group" : "display only — scored in its own primary group"}`}
                className={cn(
                  "inline-flex items-center gap-1 pl-2 pr-1 py-1 rounded-full border text-xs font-medium",
                  m.isRepresentative
                    ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
                    : "bg-zinc-900 border-zinc-700 text-amber-100/60",
                )}
              >
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
          <div className="text-[11px] text-amber-200/30 pt-1 space-y-1">
            <p>
              Green = scored in this group (sector percentiles). Grey = shown for comparison only.
              Group assignment is auto (sector/industry + peer overlap); use Reassign only to correct mistakes.
            </p>
            <p>
              Live fix for a wrong peer: Reassign above (writes a durable override + recomputes fund scores).
              Reset restores the previous/auto group. Roster add/remove only changes display peers unless
              you reassign the ticker&apos;s primary group.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
