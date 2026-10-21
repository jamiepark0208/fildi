/**
 * A213 — open short puts from watchlist_sync.position_odds (same shape as Model List pick odds).
 */
import { useQuery } from "@tanstack/react-query";
import { PickOddsPanel, type PickOdds } from "@/components/pick-odds-panel";

type Pos = { account: string; ticker: string; strike: number; expiry: string; odds: PickOdds };

export function PositionPickOdds() {
  const { data } = useQuery({
    queryKey: ["position-pick-odds"],
    queryFn: async (): Promise<{ snapshotId: number | null; positions: Pos[] }> => {
      const r = await fetch("/api/watchlist/position-odds", { credentials: "include" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  const rows = data?.positions ?? [];
  if (!rows.length) return null;
  return (
    <div className="space-y-2">
      <div className="text-[11px] uppercase tracking-widest text-[#d4af37]">
        Open puts · pick odds
        <span className="ml-2 font-normal normal-case tracking-normal text-white/40">
          snapshot {data?.snapshotId ?? "—"}
        </span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {rows.map((p) => (
          <div key={`${p.account}-${p.ticker}-${p.strike}-${p.expiry}`} className="space-y-0.5">
            <div className="text-[11px] font-mono text-zinc-300">
              {p.ticker} ${p.strike}P {p.expiry.slice(5)}
              <span className="text-zinc-600 ml-1">{p.account}</span>
            </div>
            <PickOddsPanel odds={p.odds} />
          </div>
        ))}
      </div>
    </div>
  );
}
