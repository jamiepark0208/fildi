/**
 * A192 Part C — single strategy card (payoff from /api/options/structures/template).
 */
import { useMutation } from "@tanstack/react-query";
import {
  Line, LineChart, ResponsiveContainer, ReferenceLine, XAxis, YAxis, Tooltip as RTooltip,
} from "recharts";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { GRID_WRAP, GRID_TD } from "@/lib/score-explain-format";
import type { StrategyGuideEntry } from "./strategy-guide";

type Verdict = "works" | "promising" | "fails" | "untested";

const VERDICT_CHIP: Record<Verdict, string> = {
  works: "bg-emerald-700 text-white border-emerald-500",
  promising: "bg-yellow-400 text-black border-yellow-300",
  fails: "bg-red-800 text-white border-red-500",
  untested: "bg-zinc-700 text-white border-zinc-500",
};

type PriceResp = {
  legs: unknown[];
  netFill: number;
  maxLoss: number;
  maxGain: number;
  breakevens: number[];
  pop: number;
  payoff: { spot: number; pnl: number }[];
  templateId: string;
  noCredit?: boolean;
};

type BacktestSlice = { id: string; verdict: Verdict; why?: string } | undefined;

export function StrategyCard({
  entry,
  ticker,
  backtest,
  onBuild,
}: {
  entry: StrategyGuideEntry;
  ticker: string;
  backtest: BacktestSlice;
  onBuild: (templateId: string, legs: unknown[]) => void;
}) {
  const priceMut = useMutation({
    mutationFn: async (): Promise<PriceResp> => {
      const r = await fetch("/api/options/structures/template", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, templateId: entry.templateId, horizonDays: 45 }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? "price failed");
      return r.json();
    },
  });

  const priced = priceMut.data;
  const verdict: Verdict = backtest?.verdict ?? "untested";

  return (
    <article className={cn(GRID_WRAP, "p-2 space-y-1.5 text-[11px]")}>
      <header className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-zinc-800 pb-1">
        <h3 className="text-[#fef3c7] font-semibold text-xs">{entry.name}</h3>
        <span className="text-amber-100/90">{entry.viewGroup}</span>
        <span className="text-amber-100">
          IV {entry.guide.iv} · DTE {entry.guide.dte} · guide POP {entry.guide.pop}
        </span>
        <DataTip tip={[backtest?.why, "S076 backtest verdict when catalog id exists."].filter(Boolean).join("\n")}>
          <span className={cn("px-1 rounded border text-[9px] font-bold uppercase", VERDICT_CHIP[verdict])}>
            {verdict}
          </span>
        </DataTip>
      </header>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="px-2 py-0.5 rounded bg-[#d4af37]/20 border border-[#d4af37]/50 text-[#fef3c7]"
          onClick={() => priceMut.mutate()}
          disabled={priceMut.isPending}
        >
          {priceMut.isPending ? "Pricing…" : "Price at fill"}
        </button>
        {priced ? (
          <button
            type="button"
            className="px-2 py-0.5 rounded border border-zinc-600 text-amber-100"
            onClick={() => onBuild(entry.templateId, priced.legs)}
          >
            Build this
          </button>
        ) : null}
        {priceMut.isError ? (
          <span className="text-red-300">{(priceMut.error as Error).message}</span>
        ) : null}
      </div>

      {priced ? (
        <div className="grid gap-2 lg:grid-cols-2">
          <div className="text-amber-100 space-y-0.5">
            <div className="text-white font-mono tabular-nums">
              Fill ${priced.netFill.toFixed(2)} · max loss ${priced.maxLoss.toFixed(0)} · max gain{" "}
              {priced.maxGain >= 1e12 ? "unlimited" : `$${priced.maxGain.toFixed(0)}`}
            </div>
            <div>
              POP {(priced.pop * 100).toFixed(0)}% · BE {priced.breakevens.map((x) => x.toFixed(2)).join(", ") || "—"}
              {priced.noCredit ? (
                <span className="text-amber-300"> · chain has no net credit at fill — shape is closest match</span>
              ) : null}
            </div>
            <div>Profit target (guide default): {entry.guide.target}</div>
          </div>
          <div className="h-36">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={priced.payoff}>
                <XAxis dataKey="spot" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 9 }} width={40} />
                <ReferenceLine y={0} stroke="#52525b" />
                <RTooltip contentStyle={{ fontSize: 10 }} />
                <Line type="monotone" dataKey="pnl" stroke="#12a37a" dot={false} strokeWidth={1.5} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : null}

      <section className="grid sm:grid-cols-2 gap-1 text-amber-100">
        <Box title="Works well" text={entry.ideal} />
        <Box title="Poor fit" text={entry.notIdeal} />
        <Box title="IV rises" text={entry.ivUp} />
        <Box title="IV falls" text={entry.ivDown} />
        <Box title="At expiry" text={entry.atExpiry} />
        <Box title="Defence" text={entry.defence} />
      </section>
      <ul className="list-disc pl-4 text-amber-100 space-y-0.5">
        {entry.takeaways.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </article>
  );
}

function Box({ title, text }: { title: string; text: string }) {
  return (
    <div className={GRID_TD}>
      <DataTip tip={text}>
        <span className="text-[#d4af37] font-semibold">{title}: </span>
        <span>{text}</span>
      </DataTip>
    </div>
  );
}
