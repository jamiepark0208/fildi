import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceDot,
} from "recharts";
import { cn } from "@/lib/utils";

export type ScoreHistoryPoint = {
  asOf: string;
  fundTotal: number | null;
  fundValue: number | null;
  fundGrowth: number | null;
  fundQuality: number | null;
  fundSafety: number | null;
  deltaTotal: number | null;
  largeMove: boolean;
  attribution: string[];
  notes: Array<{ id: number; body: string; author: string | null; tags: string[]; adjPoints: number | null }>;
};

function ScoreTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ScoreHistoryPoint }> }) {
  if (!active || !payload?.[0]) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded border border-[#d4af37]/30 bg-zinc-950/95 px-2.5 py-2 text-[10px] shadow-lg max-w-[240px]">
      <div className="font-mono font-semibold text-amber-100 mb-1">
        {p.asOf}
        {p.fundTotal != null && (
          <span className="ml-2 text-[#d4af37]">{p.fundTotal.toFixed(1)}</span>
        )}
        {p.deltaTotal != null && Math.abs(p.deltaTotal) >= 0.05 && (
          <span className={cn("ml-1", p.deltaTotal >= 0 ? "text-green-400" : "text-red-400")}>
            ({p.deltaTotal >= 0 ? "+" : ""}{p.deltaTotal.toFixed(1)})
          </span>
        )}
      </div>
      {p.attribution.length > 0 && (
        <ul className="space-y-0.5 text-zinc-300 mb-1">
          {p.attribution.map((a, i) => (
            <li key={i}>· {a}</li>
          ))}
        </ul>
      )}
      {p.notes.length > 0 && (
        <div className="border-t border-zinc-700/60 pt-1 mt-1 space-y-1">
          {p.notes.map((n) => (
            <p key={n.id} className="text-amber-100/90 leading-snug">
              {n.adjPoints != null && (
                <span className="text-[#d4af37] font-mono mr-1">
                  adj {n.adjPoints >= 0 ? "+" : ""}{n.adjPoints}
                </span>
              )}
              {n.body}
            </p>
          ))}
        </div>
      )}
      {p.attribution.length === 0 && p.notes.length === 0 && (
        <p className="text-amber-100/80 italic">No large move / notes</p>
      )}
    </div>
  );
}

export function FundScoreHistoryChart({
  history,
  className,
}: {
  history: ScoreHistoryPoint[];
  className?: string;
}) {
  const data = history.filter((h) => h.fundTotal != null);
  if (data.length < 2) {
    return (
      <div className={cn("flex items-center justify-center text-[10px] text-amber-200/45 italic h-[120px]", className)}>
        History starts after the next scoring run (need ≥2 points).
      </div>
    );
  }

  const markers = data.filter((d) => d.largeMove || d.notes.length > 0);

  return (
    <div className={cn("h-[140px] w-full", className)}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
          <XAxis
            dataKey="asOf"
            tick={{ fontSize: 9, fill: "#a8a29e" }}
            tickFormatter={(v: string) => String(v).slice(5)}
            interval="preserveStartEnd"
            minTickGap={28}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 9, fill: "#a8a29e" }}
            width={36}
          />
          <Tooltip content={<ScoreTooltip />} />
          <Line
            type="monotone"
            dataKey="fundTotal"
            stroke="#d4af37"
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 3, fill: "#d4af37" }}
            name="Fund"
          />
          {markers.map((m) => (
            <ReferenceDot
              key={m.asOf}
              x={m.asOf}
              y={m.fundTotal!}
              r={m.notes.length ? 4 : 3}
              fill={m.notes.length ? "#fbbf24" : "#f87171"}
              stroke="#18181b"
              strokeWidth={1}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
