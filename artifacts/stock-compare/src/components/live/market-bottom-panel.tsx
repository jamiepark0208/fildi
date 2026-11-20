// Market context moved from Today to Live (Jamie 11-20: "a lot of the data in Today should be in the Live Market tab"):
// market-bottom checklist + fear-curve / junk-bond charts + put cost by tenor. Data: GET /api/today/overview (same query
// key as Today, so one fetch serves both) + /api/today/tenor-cost (inside TenorCostTable).
import { type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { DataTip } from "@/components/data-tip";
import { formatMdYy } from "@/lib/format";
import { GRID_WRAP, GRID_HEADER } from "@/lib/score-explain-format";
import { FearCurveCharts, TenorCostTable } from "@/components/live/fear-curve-panel";

type Check = { key: string; label: string; value: string; read: "up" | "down" | "wait"; why: string };
type Pt = { date: string; value: number };
type Bottom = { asOf: string | null; checks: Check[]; series?: { ratio: Pt[]; hy: Pt[] } };

const TD = "px-1.5 py-0.5 text-[13px] text-white";
const READ = { up: ["Up", "text-emerald-400"], down: ["Down", "text-red-400"], wait: ["Wait", "text-white"] } as const;
const day = (s: string | null | undefined) => (s ? formatMdYy(s.slice(0, 10)) : "—");

function Head({ tip, children }: { tip: string; children: ReactNode }) {
  return (
    <div className={cn(GRID_HEADER, "px-2 py-1")}>
      <DataTip tip={tip}><span className="text-[13px] font-semibold uppercase tracking-wide text-white">{children}</span></DataTip>
    </div>
  );
}

function BottomChecklist({ b }: { b: Bottom }) {
  if (!b.checks.length) return null;
  const up = b.checks.filter((c) => c.read === "up").length, down = b.checks.filter((c) => c.read === "down").length;
  return (
    <section className={GRID_WRAP} data-testid="live-bottom">
      <Head tip={`As of ${day(b.asOf)}. Each row is a tested rule or plain context. The study id is in the row hover. Scale in: part now, more when the fear curve fires or SPY drops further.`}>
        Market bottom · {up} up · {down} down · {b.checks.length - up - down} wait
      </Head>
      <table className="w-full">
        <tbody>
          {b.checks.map((c) => (
            <tr key={c.key} className="border-t border-white/10">
              <td className={cn(TD, "w-[180px]")}>
                <DataTip tip={c.why}><span>{c.label}</span></DataTip>
              </td>
              <td className={TD}>{c.value}</td>
              <td className={cn(TD, "w-[72px] font-semibold", READ[c.read][1])}>{READ[c.read][0]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function MarketBottomPanel() {
  const { data } = useQuery<{ bottom?: Bottom }>({
    queryKey: ["today-overview"],
    queryFn: async () => {
      const r = await fetch("/api/today/overview", { credentials: "include" });
      if (!r.ok) throw new Error(`today ${r.status}`);
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  const b = data?.bottom;
  return (
    <div className="space-y-1.5">
      {b && <BottomChecklist b={b} />}
      {b?.series && <FearCurveCharts ratio={b.series.ratio} hy={b.series.hy} />}
      <TenorCostTable />
    </div>
  );
}
