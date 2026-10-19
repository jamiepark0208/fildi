/** A85 — Macro › Policy › Voices (figure registry + latest claims). Display only until Phase 2 scoring. */
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface FigureDef {
  id: string;
  name: string;
  org: string;
  tier: number;
  scored: boolean;
  channels: string;
}

interface FigureView {
  id: number;
  figureId: string;
  asOf: string;
  claim: string;
  asset: string | null;
  direction: string | null;
  horizon: string | null;
  confidence: number | null;
  sourceUrl: string | null;
  resolved: boolean;
}

interface VoiceRow {
  figure: FigureDef;
  latest: FigureView | null;
  openCount: number;
}

function dirClass(d: string | null): string {
  if (!d) return "text-amber-200/50";
  const x = d.toLowerCase();
  if (x.includes("bull") || x.includes("dov")) return "text-green-400";
  if (x.includes("bear") || x.includes("hawk")) return "text-red-400";
  return "text-amber-200/70";
}

export function VoicesPanel() {
  const { data, isLoading } = useQuery<{ voices: VoiceRow[]; note?: string }>({
    queryKey: ["macro-voices"],
    queryFn: () => fetch("/api/macro/voices").then((r) => {
      if (!r.ok) throw new Error(`voices ${r.status}`);
      return r.json();
    }),
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
  });

  const scored = (data?.voices ?? []).filter((v) => v.figure.scored);
  const rest = (data?.voices ?? []).filter((v) => !v.figure.scored);

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-[#d4af37]/20 bg-black">
        <h3 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Voices</h3>
        <span className="text-[9px] text-amber-200/40">A85 · no Brier badges yet</span>
      </div>
      {isLoading ? (
        <p className="text-[11px] text-amber-200/40 px-3 py-3">Loading registry…</p>
      ) : (
        <div className="divide-y divide-zinc-800/80">
          {[...scored, ...rest].map(({ figure, latest, openCount }) => (
            <div key={figure.id} className="px-3 py-1.5 flex items-start gap-2 hover:bg-amber-500/5">
              <div className="w-16 shrink-0">
                <p className="text-[11px] font-semibold text-white/90 leading-tight truncate" title={figure.name}>
                  {figure.name.split(" ").slice(-1)[0]}
                </p>
                <p className="text-[9px] text-amber-200/40 truncate">
                  {figure.org}
                  {figure.scored ? " · score" : ""}
                </p>
              </div>
              <div className="min-w-0 flex-1">
                {latest ? (
                  <>
                    <p className="text-[11px] text-amber-100/80 leading-snug line-clamp-2">{latest.claim}</p>
                    <p className="text-[9px] text-amber-200/35 mt-0.5">
                      <span className={cn(dirClass(latest.direction))}>{latest.direction ?? "—"}</span>
                      {latest.asset ? ` · ${latest.asset}` : ""}
                      {latest.horizon ? ` · ${latest.horizon}` : ""}
                      {" · "}
                      {latest.asOf}
                      {openCount > 1 ? ` · ${openCount} open` : ""}
                      {latest.sourceUrl ? (
                        <>
                          {" · "}
                          <a href={latest.sourceUrl} target="_blank" rel="noreferrer" className="text-[#d4af37]/70 hover:underline">
                            source
                          </a>
                        </>
                      ) : null}
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] text-amber-200/35 italic">No views logged yet · {figure.channels}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {data?.note ? <p className="text-[9px] text-white/30 px-3 py-1 border-t border-[#d4af37]/15">{data.note}</p> : null}
    </div>
  );
}
