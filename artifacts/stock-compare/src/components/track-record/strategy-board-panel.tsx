/** A368 — Works / Dead / Testing from BOARD.md. Reads /api/strategy-board. */
import { useQuery } from "@tanstack/react-query";

interface WorkRow { rule: string; number: string; study: string; live: string }
interface DeadRow { idea: string; why: string; study: string }
interface Lane { studyRef: string | null; name: string; stats: { totalReturn: number | null } }
interface Payload {
  works: WorkRow[];
  underpowered?: WorkRow[];
  dead: DeadRow[];
  testing: string[];
  chip: { tone: "fire" | "near" | "underpowered"; text: string } | null;
}

function liveBeside(study: string, lanes: Lane[]): string | null {
  const ids = study.split("·").map((s) => s.trim()).filter((s) => /^S\d+/.test(s));
  const hit = lanes.find((l) => ids.some((id) => (l.studyRef ?? "").includes(id) || l.name.includes(id)));
  if (!hit || hit.stats.totalReturn == null) return null;
  return `${(hit.stats.totalReturn * 100).toFixed(1)}% since adoption`;
}

export function S159TriggerChip() {
  const { data } = useQuery({
    queryKey: ["strategy-board"],
    queryFn: async (): Promise<Payload> => {
      const res = await fetch("/api/strategy-board");
      if (!res.ok) throw new Error("strategy board failed");
      return res.json();
    },
    staleTime: 60 * 60_000,
  });
  if (!data?.chip) return null;
  const fire = data.chip.tone === "fire";
  return (
    <p className={`text-[11px] px-2 py-1 rounded border ${fire ? "border-[#d4af37] text-white" : "border-[#d4af37]/40 text-amber-100"}`}>
      {data.chip.text}
    </p>
  );
}

export function StrategyBoardPanel({ lanes = [] }: { lanes?: Lane[] }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["strategy-board"],
    queryFn: async (): Promise<Payload> => {
      const res = await fetch("/api/strategy-board");
      if (!res.ok) throw new Error("strategy board failed");
      return res.json();
    },
    staleTime: 60 * 60_000,
  });
  if (isLoading) return <p className="text-[11px] text-amber-100">Loading the tested-ideas board…</p>;
  if (error || !data) return <p className="text-[11px] text-red-300">Could not load the tested-ideas board</p>;

  return (
    <div className="space-y-1">
      <details open className="rounded border border-[#d4af37]/40 bg-zinc-950">
        <summary className="cursor-pointer px-2 py-1 text-[11px] text-white">Works ({data.works.length})</summary>
        <table className="w-full text-[11px]">
          <tbody>
            {data.works.map((r) => (
              <tr key={r.rule} className="border-t border-[#d4af37]/20">
                <td className="px-2 py-1 text-white">{r.rule}</td>
                <td className="px-2 py-1 text-amber-100">
                  {r.number}
                  {liveBeside(r.study, lanes) ? <span className="text-emerald-300"> · {liveBeside(r.study, lanes)}</span> : null}
                </td>
                <td className="px-2 py-1 text-sky-100" title={r.study}>{r.study}</td>
                <td className="px-2 py-1 text-amber-100">{r.live}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      {data.underpowered && data.underpowered.length > 0 ? (
        <details className="rounded border border-amber-500/40 bg-zinc-950">
          <summary className="cursor-pointer px-2 py-1 text-[11px] text-amber-100">Underpowered ({data.underpowered.length})</summary>
          <table className="w-full text-[11px]">
            <tbody>
              {data.underpowered.map((r) => (
                <tr key={r.rule} className="border-t border-amber-500/20">
                  <td className="px-2 py-1 text-white">{r.rule}</td>
                  <td className="px-2 py-1 text-amber-100">{r.number}</td>
                  <td className="px-2 py-1 text-sky-100" title={r.study}>{r.study}</td>
                  <td className="px-2 py-1 text-amber-100">{r.live}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      <details className="rounded border border-[#d4af37]/40 bg-zinc-950">
        <summary className="cursor-pointer px-2 py-1 text-[11px] text-white">Dead ({data.dead.length})</summary>
        <table className="w-full text-[11px]">
          <tbody>
            {data.dead.map((r) => (
              <tr key={r.idea} className="border-t border-[#d4af37]/20">
                <td className="px-2 py-1 text-white">{r.idea}</td>
                <td className="px-2 py-1 text-amber-100">{r.why}</td>
                <td className="px-2 py-1 text-sky-100" title={r.study}>{r.study}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <details className="rounded border border-[#d4af37]/40 bg-zinc-950">
        <summary className="cursor-pointer px-2 py-1 text-[11px] text-white">Testing ({data.testing.length})</summary>
        <ul className="px-2 pb-1">
          {data.testing.map((t) => (
            <li key={t} className="text-[11px] text-amber-100">{t}</li>
          ))}
        </ul>
      </details>
    </div>
  );
}
