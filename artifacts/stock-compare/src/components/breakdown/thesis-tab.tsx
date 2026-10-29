/**
 * A94 — Conviction ledger (Breakdown › Thesis). User-set confidence; kill rules checkable JSON.
 */
import { Fragment, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { cn } from "@/lib/utils";
import { formatMdYy } from "@/lib/format";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";

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

const INPUT =
  "w-full bg-zinc-950 border border-[#d4af37]/25 rounded px-2 py-1 text-[12px] text-white placeholder:text-amber-200/35 focus:outline-none focus:border-[#d4af37]/60";

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

  if (isLoading || !data) return <p className="text-[11px] text-amber-100">Loading…</p>;

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline gap-1.5">
        <DataTip tip="Your confidence (1–5), checkable kill rules, append-only history. No LLM conviction score (A94).">
          <span className="text-[11px] font-bold uppercase tracking-wider text-[#d4af37]">Thesis ledger</span>
        </DataTip>
        <span className="text-[10px] font-mono font-bold text-white">{ticker}</span>
      </div>

      {data.theses.length === 0 ? (
        <p className="text-[12px] text-white/80">No theses yet — add one below for held names.</p>
      ) : (
        <div className={GRID_WRAP}>
          <table className="w-full border-collapse">
            <thead>
              <tr className={GRID_HEADER}>
                <th className={cn(GRID_TH, "text-left w-12")}>Conf</th>
                <th className={cn(GRID_TH, "text-left")}>Claim</th>
                <th className={cn(GRID_TH, "text-left w-16")}>Status</th>
                <th className={cn(GRID_TH, "text-right w-16")}>Reviewed</th>
                {isAdmin && <th className={cn(GRID_TH, "text-right w-20")}> </th>}
              </tr>
            </thead>
            <tbody>
              {data.theses.map((t, i) => {
                const subs = data.subs.filter((s) => s.thesis_id === t.id);
                const hist = data.events.filter((e) => e.thesis_id === t.id);
                return (
                  <Fragment key={t.id}>
                    <tr className={cn(gridRow(i), t.status === "killed" && "opacity-55")}>
                      <td className={cn(GRID_TD, "text-[#d4af37] font-mono font-bold")}>{t.confidence}/5</td>
                      <td className={cn(GRID_TD, "text-white text-left whitespace-normal leading-snug")}>
                        {t.claim}
                        {subs.length > 0 && (
                          <ul className="mt-0.5 space-y-0.5 text-[11px] text-amber-50/90">
                            {subs.map((s) => (
                              <li key={s.id}>
                                · {s.claim}
                                {s.status !== "ok" && (
                                  <span className="ml-1 text-amber-300">[{s.status}]</span>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}
                        {hist.length > 0 && (
                          <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[10px] text-amber-100/80 font-mono">
                            {hist.slice(0, 4).map((e) => (
                              <span key={e.id} title={e.reason}>
                                {formatMdYy(e.created_at)} {e.event}
                                {e.confidence != null ? ` ${e.confidence}` : ""}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className={cn(GRID_TD, "text-amber-50 capitalize")}>{t.status}</td>
                      <td className={cn(GRID_TD, "text-right text-amber-50 font-mono")}>
                        {formatMdYy(t.reviewed_at)}
                      </td>
                      {isAdmin && (
                        <td className={cn(GRID_TD, "text-right")}>
                          {t.status === "active" && (
                            <span className="inline-flex gap-1.5">
                              <button
                                type="button"
                                className="text-[11px] font-semibold text-[#d4af37] hover:underline"
                                onClick={() => {
                                  setBumpId(t.id);
                                  setBumpConf(t.confidence);
                                }}
                              >
                                Update
                              </button>
                              <button
                                type="button"
                                className="text-[11px] font-semibold text-red-300 hover:underline"
                                onClick={() => kill.mutate(t.id)}
                              >
                                Kill
                              </button>
                            </span>
                          )}
                        </td>
                      )}
                    </tr>
                    {bumpId === t.id && (
                      <tr className="bg-black/40 border-b border-[#d4af37]/10">
                        <td colSpan={isAdmin ? 5 : 4} className="px-2.5 py-1.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <label className="text-[11px] text-[#d4af37] font-semibold">
                              conf
                              <input
                                type="number"
                                min={1}
                                max={5}
                                value={bumpConf}
                                onChange={(e) => setBumpConf(Number(e.target.value))}
                                className={cn(INPUT, "ml-1 w-12 inline-block")}
                              />
                            </label>
                            <input
                              value={bumpReason}
                              onChange={(e) => setBumpReason(e.target.value)}
                              placeholder="reason (≥5)"
                              className={cn(INPUT, "flex-1 min-w-[140px]")}
                            />
                            <button
                              type="button"
                              disabled={bump.isPending}
                              onClick={() => bump.mutate()}
                              className="text-[11px] font-bold text-[#d4af37]"
                            >
                              Save
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && (
        <div className={cn(GRID_WRAP, "p-2 space-y-1.5")}>
          <div className="text-[11px] font-bold uppercase tracking-wider text-[#d4af37]">New thesis</div>
          <textarea
            value={claim}
            onChange={(e) => setClaim(e.target.value)}
            placeholder="Claim (≥5)"
            rows={2}
            className={INPUT}
          />
          <input
            value={subClaim}
            onChange={(e) => setSubClaim(e.target.value)}
            placeholder="Optional sub-thesis + default date kill"
            className={INPUT}
          />
          <div className="flex flex-wrap gap-2 items-center">
            <label className="text-[11px] text-[#d4af37] font-semibold">
              conf
              <input
                type="number"
                min={1}
                max={5}
                value={conf}
                onChange={(e) => setConf(Number(e.target.value))}
                className={cn(INPUT, "ml-1 w-12 inline-block")}
              />
            </label>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="reason for opening (≥5)"
              className={cn(INPUT, "flex-1 min-w-[120px]")}
            />
            <button
              type="button"
              disabled={create.isPending || claim.length < 5 || reason.length < 5}
              onClick={() => create.mutate()}
              className="text-[12px] font-bold px-2 py-1 rounded border border-[#d4af37] text-[#d4af37] disabled:opacity-40 hover:bg-[#d4af37] hover:text-black"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
