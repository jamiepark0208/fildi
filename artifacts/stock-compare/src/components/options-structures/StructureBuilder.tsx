/**
 * A192 Part L — free-form legs + payoff (stored chain).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Line, LineChart, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis, ReferenceLine,
} from "recharts";
import { cn } from "@/lib/utils";
import { GRID_WRAP, GRID_HEADER, GRID_TH, GRID_TD, gridRow } from "@/lib/score-explain-format";
import { DataTip } from "@/components/data-tip";

type Leg = {
  kind: "stock" | "call" | "put";
  side: "long" | "short";
  qty: number;
  strike?: number;
  expiry?: string;
};

type PriceResp = {
  netFill: number;
  netMid: number;
  maxLoss: number;
  maxGain: number;
  pop: number;
  breakevens: number[];
  buyingPower: number;
  payoff: { spot: number; pnl: number }[];
  fills: { leg: Leg; fill: number; mid: number; quoted?: boolean }[];
  unquoted?: number;
};

const DEFAULT_LEGS: Leg[] = [
  { kind: "put", side: "short", qty: 1, strike: 0, expiry: "" },
];

export function StructureBuilder({
  seedTicker,
  seedLegs,
}: {
  seedTicker?: string;
  seedLegs?: Leg[] | null;
} = {}) {
  const [ticker, setTicker] = useState(seedTicker ?? "AAPL");
  const [legs, setLegs] = useState<Leg[]>(seedLegs?.length ? seedLegs : DEFAULT_LEGS);

  useEffect(() => {
    if (seedTicker) setTicker(seedTicker);
  }, [seedTicker]);

  useEffect(() => {
    if (seedLegs?.length) setLegs(seedLegs);
  }, [seedLegs]);

  const chainQ = useQuery({
    queryKey: ["options-chain-builder", ticker],
    queryFn: async () => {
      const r = await fetch(`/api/options/${encodeURIComponent(ticker)}`, { credentials: "include" });
      if (!r.ok) throw new Error("chain fetch failed");
      return r.json() as Promise<{ expiry: string; spot: number; daysToExpiry: number }[]>;
    },
    staleTime: 60_000,
  });

  const expiries = useMemo(
    () => (chainQ.data ?? []).map((c) => c.expiry).filter(Boolean),
    [chainQ.data],
  );
  const spot = chainQ.data?.[0]?.spot;

  const priceMut = useMutation({
    mutationFn: async (): Promise<PriceResp> => {
      const r = await fetch("/api/options/structures/price", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, legs, horizonDays: 30 }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "price failed");
      return r.json();
    },
  });

  const updateLeg = (i: number, patch: Partial<Leg>) => {
    setLegs((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  };

  const addLeg = () => setLegs((p) => [...p, { kind: "call", side: "long", qty: 1, strike: spot ?? 0, expiry: expiries[0] ?? "" }]);

  const priced = priceMut.data;

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-amber-100">Ticker</label>
        <input
          className="w-20 bg-zinc-900 border border-zinc-700 rounded px-1 py-0.5 text-white font-mono"
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
        />
        {spot != null ? <span className="text-white tabular-nums">${spot.toFixed(2)}</span> : null}
        <button
          type="button"
          className="px-2 py-0.5 rounded bg-[#d4af37]/20 border border-[#d4af37]/50 text-[#fef3c7]"
          onClick={() => priceMut.mutate()}
          disabled={priceMut.isPending}
        >
          Price at fill
        </button>
        {priceMut.isError ? <span className="text-red-300">{(priceMut.error as Error).message}</span> : null}
      </div>

      <div className={cn(GRID_WRAP, "overflow-x-auto")}>
        <table className="w-full border-collapse min-w-[520px]">
          <thead>
            <tr className={GRID_HEADER}>
              <th className={GRID_TH}>Kind</th>
              <th className={GRID_TH}>Side</th>
              <th className={GRID_TH}>Qty</th>
              <th className={GRID_TH}>Strike</th>
              <th className={GRID_TH}>Expiry</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, i) => (
              <tr key={i} className={gridRow(i)}>
                <td className={GRID_TD}>
                  <select
                    className="bg-zinc-900 text-white"
                    value={leg.kind}
                    onChange={(e) => updateLeg(i, { kind: e.target.value as Leg["kind"] })}
                  >
                    <option value="stock">stock</option>
                    <option value="call">call</option>
                    <option value="put">put</option>
                  </select>
                </td>
                <td className={GRID_TD}>
                  <select
                    className="bg-zinc-900 text-white"
                    value={leg.side}
                    onChange={(e) => updateLeg(i, { side: e.target.value as Leg["side"] })}
                  >
                    <option value="long">long</option>
                    <option value="short">short</option>
                  </select>
                </td>
                <td className={GRID_TD}>
                  <input
                    type="number"
                    className="w-14 bg-zinc-900 text-white font-mono"
                    value={leg.qty}
                    onChange={(e) => updateLeg(i, { qty: Number(e.target.value) || 0 })}
                  />
                </td>
                <td className={GRID_TD}>
                  {leg.kind === "stock" ? "—" : (
                    <input
                      type="number"
                      className="w-20 bg-zinc-900 text-white font-mono"
                      value={leg.strike ?? 0}
                      onChange={(e) => updateLeg(i, { strike: Number(e.target.value) })}
                    />
                  )}
                </td>
                <td className={GRID_TD}>
                  {leg.kind === "stock" ? "—" : (
                    <select
                      className="bg-zinc-900 text-white max-w-[110px]"
                      value={leg.expiry ?? ""}
                      onChange={(e) => updateLeg(i, { expiry: e.target.value })}
                    >
                      {expiries.map((ex) => (
                        <option key={ex} value={ex}>{ex}</option>
                      ))}
                    </select>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="text-[#d4af37]" onClick={addLeg}>+ leg</button>

      {priced && (priced.unquoted ?? 0) > 0 ? (
        <div className="text-amber-300">
          Unpriced: no quote for{" "}
          {priced.fills
            .filter((f) => f.quoted === false)
            .map((f) => `${f.leg.side} ${f.leg.kind} ${f.leg.strike ?? "?"} ${f.leg.expiry ?? ""}`.trim())
            .join(", ")}
          . Fill, max loss and POP would count that leg as free.
        </div>
      ) : priced ? (
        <div className="grid gap-2 md:grid-cols-2">
          <div className="space-y-1 text-amber-100">
            <DataTip tip="Contract fills (23 % spread); mid shown for context only.">
              <span className="text-white font-semibold">Fill ${priced.netFill.toFixed(2)}</span>
            </DataTip>
            <span className="ml-2 text-amber-100">mid ctx ${priced.netMid.toFixed(2)}</span>
            <div>Max loss ${priced.maxLoss.toFixed(0)} · POP {(priced.pop * 100).toFixed(0)}%</div>
            <div>BE: {priced.breakevens.map((x) => x.toFixed(2)).join(", ") || "—"}</div>
          </div>
          <div className="h-40">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={priced.payoff}>
                <XAxis dataKey="spot" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 9 }} width={36} />
                <ReferenceLine y={0} stroke="#52525b" />
                <RTooltip contentStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="pnl" stroke="#d4af37" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}
    </div>
  );
}
