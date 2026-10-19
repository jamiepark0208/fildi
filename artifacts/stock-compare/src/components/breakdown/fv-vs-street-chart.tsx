/** A86 — Fildi FV vs street consensus PT (Breakdown › Assumptions). Display only. */
import { useQuery } from "@tanstack/react-query";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, ReferenceArea,
} from "recharts";

type Pt = {
  date: string;
  price: number | null;
  fairValue: number | null;
  streetPt: number | null;
  gapPct: number | null;
};

export function FvVsStreetChart({ ticker }: { ticker: string }) {
  const { data, isLoading } = useQuery<{ points: Pt[]; note?: string }>({
    queryKey: ["fv-vs-street", ticker],
    queryFn: () => fetch(`/api/fair-value/${encodeURIComponent(ticker)}/vs-street?days=400`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`vs-street ${r.status}`);
        return r.json();
      }),
    staleTime: 15 * 60_000,
  });

  const rows = (data?.points ?? []).filter((p) => p.fairValue != null || p.streetPt != null || p.price != null);
  if (isLoading) {
    return <p className="text-[10px] text-amber-200/40 italic py-2">Loading FV vs street…</p>;
  }
  if (rows.length < 2) {
    return (
      <p className="text-[10px] text-amber-200/40 italic py-2">
        Need fair_value_snapshots + street_pt_daily (run backfill-street-pt).
      </p>
    );
  }

  // Shade regions where |gap| > 15%
  const shadeSpans: { x1: string; x2: string }[] = [];
  let run: { x1: string; x2: string } | null = null;
  for (const p of rows) {
    const hot = p.gapPct != null && Math.abs(p.gapPct) >= 15;
    if (hot) {
      if (!run) run = { x1: p.date, x2: p.date };
      else run.x2 = p.date;
    } else if (run) {
      shadeSpans.push(run);
      run = null;
    }
  }
  if (run) shadeSpans.push(run);

  return (
    <div className="rounded border border-[#d4af37]/20 bg-black/30 px-2 py-1.5 space-y-1">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-semibold text-[#d4af37]/80 uppercase tracking-wide">FV vs street</h4>
        <span className="text-[9px] text-amber-200/35">A86 · shaded |gap|≥15%</span>
      </div>
      <div className="h-[140px]">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
            {shadeSpans.map((s, i) => (
              <ReferenceArea key={i} x1={s.x1} x2={s.x2} fill="#d4af37" fillOpacity={0.08} />
            ))}
            <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#a8a29e" }} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={{ fontSize: 9, fill: "#a8a29e" }} domain={["auto", "auto"]} />
            <Tooltip
              contentStyle={{ background: "#09090b", border: "1px solid #d4af3740", fontSize: 11 }}
              formatter={(v: number, name: string) => [`$${Number(v).toFixed(2)}`, name]}
            />
            <Line type="monotone" dataKey="price" name="Price" stroke="#94a3b8" dot={false} strokeWidth={1} connectNulls />
            <Line type="monotone" dataKey="fairValue" name="Fildi FV" stroke="#d4af37" dot={false} strokeWidth={1.5} connectNulls />
            <Line type="monotone" dataKey="streetPt" name="Street PT" stroke="#38bdf8" dot={false} strokeWidth={1.5} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {data?.note ? <p className="text-[9px] text-white/30">{data.note}</p> : null}
    </div>
  );
}
