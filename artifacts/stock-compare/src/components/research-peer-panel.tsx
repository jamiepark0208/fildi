/**
 * Peer-relative tab body shared by WRDS / LSEG research reports.
 */
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
} from "recharts";
import { cn } from "@/lib/utils";
import {
  fmtRelHint,
  peerGroupLabel,
  relTone,
  type PeerRelativeBlock,
  type RelMetric,
} from "@/lib/research-peers";
import { ReportSection } from "@/components/research-report-shell";

const TONE_TEXT = {
  good: "text-green-400",
  bad: "text-red-400",
  neutral: "text-zinc-300",
} as const;

function fmtNum(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(d);
}

type MetricRow = {
  key: string;
  label: string;
  meaning: string;
  higherBetter: boolean;
  digits?: number;
};

export function ResearchPeerPanel({
  peers,
  selfTicker,
  rows,
  emptyHint,
}: {
  peers: PeerRelativeBlock | null | undefined;
  selfTicker: string;
  rows: MetricRow[];
  emptyHint: string;
}) {
  if (!peers?.peerCount) {
    return (
      <ReportSection title="Peers — relative context">
        <p className="text-zinc-500 italic">{emptyHint}</p>
      </ReportSection>
    );
  }

  const chart = peers.leaders.map((l) => ({
    name: l.ticker === selfTicker.toUpperCase() ? `★ ${l.ticker}` : l.ticker,
    value: l.value,
    self: l.ticker === selfTicker.toUpperCase(),
  }));

  return (
    <div className="space-y-3">
      <div className="text-[10px] text-zinc-500 font-mono px-0.5">
        {peerGroupLabel(peers)}
        {peers.sector ? ` · ${peers.sector}` : ""}
      </div>

      <ReportSection title="You vs peer median">
        <div className="space-y-1">
          {rows.map((row) => {
            const m: RelMetric | undefined = peers.metrics[row.key];
            if (!m || m.value == null) {
              return (
                <div
                  key={row.key}
                  className="rounded border border-[#d4af37]/10 bg-zinc-900/40 px-2 py-1.5 flex justify-between gap-2"
                >
                  <span className="text-zinc-500">{row.label}</span>
                  <span className="text-zinc-600 font-mono">—</span>
                </div>
              );
            }
            const tone = relTone(m.peerPct, !row.higherBetter);
            return (
              <div key={row.key} className="rounded border border-[#d4af37]/12 bg-zinc-900/60 px-2 py-1.5 space-y-0.5">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-zinc-300">{row.label}</span>
                  <span className={cn("font-mono font-semibold", TONE_TEXT[tone])}>
                    {fmtNum(m.value, row.digits ?? 2)}
                    {m.peerPct != null ? ` · p${Math.round(m.peerPct)}` : ""}
                  </span>
                </div>
                <div className="flex justify-between gap-2 text-[9.5px] text-zinc-500 font-mono">
                  <span>peer med {fmtNum(m.peerMedian, row.digits ?? 2)}</span>
                  <span>{fmtRelHint(m, { digits: row.digits ?? 2 }) ?? ""}</span>
                </div>
                <p className="text-[9.5px] text-zinc-500 leading-snug">{row.meaning}</p>
              </div>
            );
          })}
        </div>
      </ReportSection>

      {chart.length >= 2 && (
        <ReportSection title="Peer leaders (primary metric)">
          <div className="h-36 w-full rounded border border-[#d4af37]/10 bg-zinc-950/80 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chart} layout="vertical" margin={{ top: 4, right: 12, left: 8, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9, fill: "#71717a" }} />
                <YAxis type="category" dataKey="name" width={56} tick={{ fontSize: 9, fill: "#a1a1aa" }} />
                <Tooltip contentStyle={{ background: "#09090b", border: "1px solid #3f3f46", fontSize: 11 }} />
                <ReferenceLine
                  x={peers.metrics[rows[0]?.key]?.peerMedian ?? undefined}
                  stroke="#52525b"
                  strokeDasharray="2 3"
                />
                <Bar dataKey="value" radius={[0, 3, 3, 0]}>
                  {chart.map((row) => (
                    <Cell key={row.name} fill={row.self ? "#d4af37" : "#d4af3744"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <p className="text-[9px] text-zinc-600 px-2 pb-1">
              Top peers on primary metric · dashed = peer median · gold = you (if in top set)
            </p>
          </div>
        </ReportSection>
      )}
    </div>
  );
}
