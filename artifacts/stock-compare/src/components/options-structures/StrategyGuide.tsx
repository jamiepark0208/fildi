/**
 * A192 Part C — 31 strategies in six view groups.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { STRATEGY_GUIDE, STRATEGY_VIEW_ORDER } from "./strategy-guide";
import { StrategyCard } from "./StrategyCard";

type BuilderLeg = {
  kind: "stock" | "call" | "put";
  side: "long" | "short";
  qty: number;
  strike?: number;
  expiry?: string;
};

type BackResp = {
  structures: { id: string; verdict: "works" | "promising" | "fails" | "untested"; why?: string }[];
};

export function StrategyGuide({ onBuild }: { onBuild: (ticker: string, legs: BuilderLeg[]) => void }) {
  const [ticker, setTicker] = useState("AAPL");
  const [openGroup, setOpenGroup] = useState<string | null>(STRATEGY_VIEW_ORDER[0]);

  const backQ = useQuery({
    queryKey: ["structures-backtest"],
    queryFn: async (): Promise<BackResp> => {
      const r = await fetch("/api/options/structures/backtest", { credentials: "include" });
      if (!r.ok) throw new Error("backtest fetch failed");
      return r.json();
    },
    staleTime: 30 * 60_000,
  });

  const byCatalog = useMemo(() => {
    const m = new Map<string, BackResp["structures"][0]>();
    for (const s of backQ.data?.structures ?? []) m.set(s.id, s);
    return m;
  }, [backQ.data]);

  const groups = useMemo(() => {
    const m = new Map<string, typeof STRATEGY_GUIDE>();
    for (const g of STRATEGY_VIEW_ORDER) m.set(g, []);
    for (const e of STRATEGY_GUIDE) {
      m.get(e.viewGroup)!.push(e);
    }
    return STRATEGY_VIEW_ORDER.map((g) => ({ group: g, entries: m.get(g) ?? [] }));
  }, []);

  return (
    <div className="space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <label className="text-amber-100">Ticker</label>
        <input
          className="w-20 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-white font-mono"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
        />
        <span className="text-amber-100/80">{STRATEGY_GUIDE.length} strategies · guide-default numbers cited only</span>
      </div>
      {groups.map(({ group, entries }) => (
        <section key={group}>
          <button
            type="button"
            className="w-full text-left text-[#d4af37] font-semibold py-1 border-b border-zinc-800"
            onClick={() => setOpenGroup((o) => (o === group ? null : group))}
          >
            {group} ({entries.length})
          </button>
          {openGroup === group ? (
            <div className="grid gap-2 mt-2">
              {entries.map((entry) => (
                <StrategyCard
                  key={entry.id}
                  entry={entry}
                  ticker={ticker}
                  backtest={entry.catalogId ? byCatalog.get(entry.catalogId) : undefined}
                  onBuild={(_tid, legs) => onBuild(ticker, legs as BuilderLeg[])}
                />
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
