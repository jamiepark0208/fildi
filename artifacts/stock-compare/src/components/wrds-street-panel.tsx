/**
 * WRDS Street — dense compact card + tabbed report with What/Why/So-what skim styling.
 */
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { Loader2 } from "lucide-react";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResearchOpsBanner } from "@/components/research-ops-banner";
import { ResearchPeerPanel } from "@/components/research-peer-panel";
import { ReportSection, ResearchReportShell } from "@/components/research-report-shell";
import {
  Bad,
  Em,
  Good,
  U,
  Warn,
  WhyCallout,
  WhyMetric,
} from "@/components/research-why";
import {
  WRDS_GLOSSARY,
  buildWrdsEvidence,
  buildWrdsTradeLens,
  fmt,
  fmtPct,
  premiumBufferNote,
  revisionChartData,
  sueChartData,
  wrdsCompactChips,
  wrdsConclusion,
  wrdsHowTo,
  wrdsVerdictClass,
  type WrdsPayload,
} from "@/lib/wrds-report";

const TONE_BOX = {
  good: "border-green-500/30 bg-green-500/5 text-green-300",
  bad: "border-red-500/30 bg-red-500/5 text-red-300",
  warn: "border-amber-400/30 bg-amber-400/5 text-amber-200",
  neutral: "border-[#d4af37]/15 bg-zinc-900/50 text-zinc-200",
} as const;

const TAB =
  "text-[10px] font-semibold px-2 h-6 rounded text-amber-200/50 data-[state=active]:bg-[#d4af37] data-[state=active]:text-black";

function MiniSpark({ data }: { data: WrdsPayload }) {
  const rev = revisionChartData(data).slice(-8);
  if (rev.length < 2) return null;
  return (
    <div className="h-10 w-full rounded border border-[#d4af37]/10 bg-zinc-950/60">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rev} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
          <Bar dataKey="breadth" fill="#d4af3733" isAnimationActive={false} />
          <Line type="monotone" dataKey="mean" stroke="#d4af37" strokeWidth={1.4} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function WrdsReport({ data }: { data: WrdsPayload }) {
  const c = data.consensus;
  const evidence = buildWrdsEvidence(data);
  const lenses = buildWrdsTradeLens(data, data.tech);
  const revChart = revisionChartData(data);
  const sueChart = sueChartData(data);
  const buf = premiumBufferNote(data.tech?.iv ?? null, data.ticker);
  const fr = data.finratio;
  const brTone =
    c?.breadth != null ? (c.breadth >= 0.08 ? "good" : c.breadth <= -0.08 ? "bad" : "neutral") : "neutral";
  const sueTone =
    c?.sue != null ? (c.sue >= 0.5 ? "good" : c.sue <= -0.5 ? "bad" : "neutral") : "neutral";
  const driftTone =
    c?.meanDriftPct != null
      ? c.meanDriftPct >= 1
        ? "good"
        : c.meanDriftPct <= -1
          ? "bad"
          : "neutral"
      : "neutral";

  return (
    <Tabs defaultValue="verdict" className="w-full">
      <TabsList className="h-7 p-0.5 bg-zinc-950 border border-[#d4af37]/20 rounded overflow-x-auto w-full justify-start mb-2 sticky top-0 z-10">
        <TabsTrigger value="verdict" className={TAB}>
          Verdict
        </TabsTrigger>
        <TabsTrigger value="street" className={TAB}>
          Street
        </TabsTrigger>
        <TabsTrigger value="peers" className={TAB}>
          Peers
        </TabsTrigger>
        <TabsTrigger value="trade" className={TAB}>
          Trade
        </TabsTrigger>
        <TabsTrigger value="more" className={TAB}>
          More
        </TabsTrigger>
      </TabsList>

      <TabsContent value="verdict" className="space-y-3 mt-0">
        <WhyCallout
          tone={data.verdict === "supportive" ? "good" : data.verdict === "caution" ? "bad" : "neutral"}
          title={
            <>
              <U>Verdict</U>:{" "}
              {data.verdict === "supportive" ? (
                <Good>supportive</Good>
              ) : data.verdict === "caution" ? (
                <Bad>caution</Bad>
              ) : (
                <Em>neutral</Em>
              )}{" "}
              · rules: breadth ±0.08 · SUE ±0.5
            </>
          }
        >
          <p className="text-[12px] text-zinc-200 font-medium">{wrdsConclusion(data)}</p>
        </WhyCallout>

        <div className="space-y-1.5">
          {evidence.map((e, i) => (
            <div key={i} className={cn("rounded border px-2.5 py-1.5", TONE_BOX[e.tone])}>
              <div className="font-medium text-[11.5px] leading-snug">{e.claim}</div>
              <div className="text-[10px] text-zinc-400 leading-snug mt-0.5">{e.proof}</div>
            </div>
          ))}
        </div>

        {data.streetEventRisk && (
          <WhyMetric
            label="Street-event risk"
            value={<Warn>ON</Warn>}
            tone="warn"
          />
        )}
      </TabsContent>

      <TabsContent value="street" className="space-y-3 mt-0">
        <ReportSection title="IBES revisions">
          {!c ? (
            <p className="text-zinc-500 italic">No consensus row — run sync_ibes.</p>
          ) : (
            <div className="space-y-2">
              <WhyMetric
                label="FY1 drift %"
                value={fmtPct(c.meanDriftPct)}
                sub={c.meanest != null ? `level $${fmt(c.meanest)} · not peer-comparable $` : undefined}
                tone={driftTone}
              />

              <WhyMetric
                label="Revision breadth"
                value={fmt(c.breadth)}
                sub={`↑${c.numup ?? "—"} ↓${c.numdown ?? "—"} of ${c.numest ?? "—"} · rule ±0.08`}
                tone={brTone}
              />

              <WhyMetric
                label="Avg SUE"
                value={fmt(c.sue)}
                sub={`${sueChart.length} surprise prints · rule ±0.5`}
                tone={sueTone}
              />

              <WhyMetric
                label="# analysts"
                value={String(c.numest ?? "—")}
                sub={`${c.fiscalp ?? ""} / fpi ${c.fpi ?? "—"} · ${c.asOf ?? ""}`}
              />
            </div>
          )}

          {revChart.length >= 2 && (
            <div className="h-40 w-full rounded border border-[#d4af37]/10 bg-zinc-950/80 pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={revChart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#71717a" }} />
                  <YAxis yAxisId="mean" tick={{ fontSize: 9, fill: "#a1a1aa" }} width={36} tickFormatter={(v: number) => `$${v}`} />
                  <YAxis yAxisId="br" orientation="right" tick={{ fontSize: 9, fill: "#71717a" }} width={28} />
                  <Tooltip contentStyle={{ background: "#09090b", border: "1px solid #3f3f46", fontSize: 11 }} />
                  <ReferenceLine yAxisId="br" y={8} stroke="#22c55e55" strokeDasharray="3 3" />
                  <ReferenceLine yAxisId="br" y={-8} stroke="#ef444455" strokeDasharray="3 3" />
                  <Bar yAxisId="br" dataKey="breadth" fill="#d4af3733" name="breadth" />
                  <Line yAxisId="mean" type="monotone" dataKey="mean" stroke="#d4af37" strokeWidth={1.8} dot={false} name="mean" />
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-[9px] text-zinc-600 px-2 pb-1">
                Gold line = FY1 mean $ · bars = breadth×100 · dashed ±8 = our supportive/caution bands
              </p>
            </div>
          )}
        </ReportSection>

        <ReportSection title="SUE history">
          {sueChart.length >= 1 ? (
            <div className="h-36 w-full rounded border border-[#d4af37]/10 bg-zinc-950/80 pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={sueChart} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#71717a" }} />
                  <YAxis tick={{ fontSize: 9, fill: "#a1a1aa" }} width={32} />
                  <Tooltip contentStyle={{ background: "#09090b", border: "1px solid #3f3f46", fontSize: 11 }} />
                  <ReferenceLine y={0.5} stroke="#22c55e55" strokeDasharray="3 3" />
                  <ReferenceLine y={-0.5} stroke="#ef444455" strokeDasharray="3 3" />
                  <Bar dataKey="sue" fill="#38bdf8aa" name="SUE" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-zinc-500 italic">No surpsum rows in cache.</p>
          )}
        </ReportSection>
      </TabsContent>

      <TabsContent value="peers" className="mt-0 space-y-2">
        <ResearchPeerPanel
          peers={data.peers}
          selfTicker={data.ticker}
          emptyHint="No taxonomy peer_group_members — absolute IBES only."
          rows={[
            {
              key: "breadth",
              label: "Revision breadth",
              meaning: "p70+ = revision tape stronger than most sector peers.",
              higherBetter: true,
            },
            {
              key: "sue",
              label: "Avg SUE",
              meaning: "Peer % = whether your beat/miss streak is special in-group.",
              higherBetter: true,
            },
          ]}
        />
      </TabsContent>

      <TabsContent value="trade" className="space-y-3 mt-0">
        {lenses.map((lens) => (
          <div key={lens.side} className="rounded border border-[#d4af37]/15 bg-zinc-900/50 px-2.5 py-2 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-amber-200/60">
                {lens.side === "puts" ? "Selling puts" : "Selling calls"}
              </span>
              <span className="text-[10px] font-mono text-zinc-500">{lens.stance}</span>
            </div>
            <div className="text-[12px] font-medium text-zinc-100">{lens.headline}</div>
            <ul className="list-disc pl-4 space-y-1 text-[10.5px] text-zinc-400 leading-snug">
              {lens.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        ))}
        {buf && (
          <div className={cn("rounded border px-2.5 py-1.5", TONE_BOX[buf.tone])}>
            <div className="font-medium text-[11px]">{buf.title}</div>
            <p className="text-[10.5px] text-zinc-400 leading-snug mt-0.5">{buf.text}</p>
          </div>
        )}
      </TabsContent>

      <TabsContent value="more" className="space-y-3 mt-0">
        <details className="group rounded border border-[#d4af37]/12 bg-zinc-900/40">
          <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-semibold text-[#d4af37] list-none flex items-center gap-1">
            <span className="text-zinc-500 group-open:rotate-90 transition-transform">▸</span>
            Glossary (?)
          </summary>
          <div className="px-2.5 pb-2 space-y-1.5">
            {WRDS_GLOSSARY.map((g) => (
              <div key={g.term} className="rounded border border-[#d4af37]/10 bg-zinc-950/60 px-2 py-1.5">
                <div className="text-[11px] font-semibold text-[#d4af37]">{g.term}</div>
                <p className="text-[10.5px] text-zinc-400 leading-snug mt-0.5">{g.def}</p>
              </div>
            ))}
          </div>
        </details>

        <WhyMetric
          label="Fund growth / total"
          value={`${fmt(data.fundImpact?.fundGrowthScore, 1)} / ${fmt(data.fundImpact?.fundTotalScore, 1)}`}
          note={
            data.fundImpact?.scoredAt
              ? <>Scored {String(data.fundImpact.scoredAt).slice(0, 10)}</>
              : undefined
          }
        />

        <ReportSection title="FinRatios audit">
          {!fr ? (
            <p className="text-zinc-500 italic">No finratio_snapshot.</p>
          ) : (
            <div className="grid grid-cols-3 gap-1.5">
              {[
                ["P/E", fmt(fr.pe)],
                ["B/M", fmt(fr.bm)],
                ["ROE", fmt(fr.roe)],
                ["ROA", fmt(fr.roa)],
                ["D/E", fmt(fr.deRatio)],
                ["Current", fmt(fr.currRatio)],
              ].map(([label, value]) => (
                <div key={label} className="rounded border border-[#d4af37]/12 bg-zinc-900/60 px-2 py-1">
                  <div className="text-[9px] text-zinc-500">{label}</div>
                  <div className="font-mono text-zinc-100">{value}</div>
                </div>
              ))}
            </div>
          )}
        </ReportSection>

        <ResearchOpsBanner lane="wrds" />
      </TabsContent>
    </Tabs>
  );
}

export function WrdsStreetPanel({ ticker, embedded }: { ticker: string; embedded?: boolean }) {
  const { isAdmin } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ["research-wrds", ticker],
    queryFn: async (): Promise<WrdsPayload> => {
      const res = await fetch(`/api/research/wrds/${encodeURIComponent(ticker)}`);
      if (!res.ok) throw new Error(`WRDS research ${res.status}`);
      return res.json();
    },
    enabled: !!isAdmin && !!ticker,
    staleTime: 5 * 60 * 1000,
  });

  if (!isAdmin) {
    return <p className="text-[10px] text-amber-200/50 italic py-1">Street research (WRDS) — admin only</p>;
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-amber-100 py-2 justify-center">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading WRDS…
      </div>
    );
  }
  if (error) return <p className="text-[10px] text-red-300 italic">{(error as Error).message}</p>;
  if (!data) return null;

  return (
    <ResearchReportShell
      lane="wrds"
      title={ticker}
      subtitle={data.consensus?.asOf ?? undefined}
      verdictLabel={data.available ? data.verdict : "no data"}
      verdictClass={data.available ? wrdsVerdictClass(data.verdict) : "border-zinc-600 text-zinc-500"}
      summaryLine={wrdsConclusion(data)}
      howTo={embedded ? undefined : data.available ? wrdsHowTo(data) : undefined}
      chips={data.available ? wrdsCompactChips(data) : undefined}
      sparkline={embedded ? undefined : data.available ? <MiniSpark data={data} /> : undefined}
      report={<WrdsReport data={data} />}
      embedded={embedded}
    />
  );
}
