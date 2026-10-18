/**
 * A94 — Conviction ledger (Breakdown › Thesis). User-set confidence; kill rules checkable JSON.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";

type Thesis = {
  id: number;
  claim: string;
  horizon: string;
  confidence: number;
  status: string;
  reason: string;
  reviewed_at: string | null;
  kill_note: string | null;
};
type Sub = { id: number; thesis_id: number; claim: string; kill_rules: unknown; status: string };
type Ev = { id: number; thesis_id: number; kind: string; note: string | null; created_at: string };
type Event = { id: number; thesis_id: number; event: string; confidence: number | null; reason: string; created_at: string };

type Sheet = { ticker: string; theses: Thesis[]; subs: Sub[]; evidence: Ev[]; events: Event[] };

export function ThesisTab({ ticker }: { ticker: string }) {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const [claim, setClaim] = useState("");
  const [reason, setReason] = useState("");
  const [conf, setConf] = useState(3);
  const [subClaim, setSubClaim] = useState("");
  const [bumpId, setBumpId] = useState<number | null>(null);
  const [bumpReason, setBumpReason] = useState("");
  const [bumpConf, setBumpConf] = useState(3);

  const { data, isLoading } = useQuery({
    queryKey: ["conviction", ticker],
    queryFn: async (): Promise<Sheet> => {
      const r = await fetch(`/api/conviction/${encodeURIComponent(ticker)}`, { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/conviction/${encodeURIComponent(ticker)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claim,
          reason,
          confidence: conf,
          subTheses: subClaim.length >= 5
            ? [{ claim: subClaim, killRules: [{ kind: "date", by: "2027-01-01", label: "review by date" }] }]
            : [],
        }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      setClaim("");
      setReason("");
      setSubClaim("");
      qc.invalidateQueries({ queryKey: ["conviction", ticker] });
    },
  });

  const bump = useMutation({
    mutationFn: async () => {
      if (bumpId == null) return;
      const r = await fetch(`/api/conviction/thesis/${bumpId}/confidence`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confidence: bumpConf, reason: bumpReason }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      setBumpId(null);
      setBumpReason("");
      qc.invalidateQueries({ queryKey: ["conviction", ticker] });
    },
  });

  const kill = useMutation({
    mutationFn: async (id: number) => {
      const why = window.prompt("Kill reason (≥5 chars)");
      if (!why || why.length < 5) throw new Error("reason required");
      const r = await fetch(`/api/conviction/thesis/${id}/kill`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: why }),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["conviction", ticker] }),
  });

  if (isLoading || !data) return <p className="text-[10px] text-amber-200/40">Loading…</p>;

  return (
    <div className="space-y-3 text-[11px] text-amber-100/80">
      <p className="text-[10px] text-amber-200/50 leading-snug">
        Structured theses for held names — your confidence (1–5), checkable kill rules, append-only history. No LLM conviction score (A94).
      </p>

      {data.theses.length === 0 && (
        <p className="text-[10px] text-amber-200/40">No theses yet for {ticker}.</p>
      )}

      {data.theses.map((t) => {
        const subs = data.subs.filter((s) => s.thesis_id === t.id);
        const hist = data.events.filter((e) => e.thesis_id === t.id);
        return (
          <div key={t.id} className={cn("rounded border border-[#d4af37]/15 bg-black/20 px-2 py-1.5 space-y-1", t.status === "killed" && "opacity-60")}>
            <div className="flex items-start gap-2">
              <span className="shrink-0 rounded border border-[#d4af37]/30 px-1 text-[10px] tabular-nums text-[#d4af37]">
                {t.confidence}/5
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-amber-100/90 leading-snug">{t.claim}</div>
                <div className="text-[10px] text-amber-200/40 mt-0.5">
                  {t.status} · {t.horizon} · reviewed {t.reviewed_at?.slice(0, 10) ?? "—"}
                </div>
              </div>
              {isAdmin && t.status === "active" && (
                <div className="flex gap-1 shrink-0">
                  <button type="button" className="text-[10px] text-amber-200/50 hover:text-[#d4af37]" onClick={() => { setBumpId(t.id); setBumpConf(t.confidence); }}>
                    Update
                  </button>
                  <button type="button" className="text-[10px] text-red-300/70 hover:text-red-300" onClick={() => kill.mutate(t.id)}>
                    Kill
                  </button>
                </div>
              )}
            </div>
            {subs.length > 0 && (
              <ul className="pl-2 space-y-0.5 text-[10px] text-amber-200/70">
                {subs.map((s) => (
                  <li key={s.id}>
                    · {s.claim}
                    <span className="text-amber-200/40"> · kill {JSON.stringify(s.kill_rules)}</span>
                    {s.status !== "ok" && <span className="ml-1 text-amber-300">[{s.status}]</span>}
                  </li>
                ))}
              </ul>
            )}
            {hist.length > 0 && (
              <div className="flex flex-wrap gap-1 pt-0.5">
                {hist.map((e) => (
                  <span key={e.id} className="text-[9px] tabular-nums text-amber-200/35" title={e.reason}>
                    {e.created_at.slice(0, 10)} {e.event}{e.confidence != null ? ` ${e.confidence}` : ""}
                  </span>
                ))}
              </div>
            )}
            {bumpId === t.id && (
              <div className="flex flex-wrap items-end gap-1.5 pt-1 border-t border-[#d4af37]/10">
                <label className="text-[10px]">conf
                  <input type="number" min={1} max={5} value={bumpConf} onChange={(e) => setBumpConf(Number(e.target.value))} className="ml-1 w-10 bg-zinc-900 border border-zinc-700 rounded px-1" />
                </label>
                <input
                  value={bumpReason}
                  onChange={(e) => setBumpReason(e.target.value)}
                  placeholder="reason (≥5)"
                  className="flex-1 min-w-[140px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px]"
                />
                <button type="button" disabled={bump.isPending} onClick={() => bump.mutate()} className="text-[10px] text-[#d4af37]">
                  Save
                </button>
              </div>
            )}
          </div>
        );
      })}

      {isAdmin && (
        <div className="rounded border border-dashed border-[#d4af37]/25 px-2 py-1.5 space-y-1">
          <div className="text-[10px] font-semibold text-[#d4af37]/80">New thesis</div>
          <textarea value={claim} onChange={(e) => setClaim(e.target.value)} placeholder="Claim (≥5)" rows={2} className="w-full bg-zinc-900 border border-zinc-700 rounded px-1.5 py-1 text-[10px]" />
          <input value={subClaim} onChange={(e) => setSubClaim(e.target.value)} placeholder="Optional sub-thesis + default date kill" className="w-full bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px]" />
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-[10px]">conf
              <input type="number" min={1} max={5} value={conf} onChange={(e) => setConf(Number(e.target.value))} className="ml-1 w-10 bg-zinc-900 border border-zinc-700 rounded px-1" />
            </label>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason for opening (≥5)" className="flex-1 min-w-[120px] bg-zinc-900 border border-zinc-700 rounded px-1.5 py-0.5 text-[10px]" />
            <button
              type="button"
              disabled={create.isPending || claim.length < 5 || reason.length < 5}
              onClick={() => create.mutate()}
              className="text-[10px] font-semibold text-[#d4af37] disabled:opacity-40"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
