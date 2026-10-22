/**
 * LSEG Street — dense compact card + tabbed report with What/Why/So-what skim styling.
 */
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/context/AuthContext";
import { AlertTriangle, CheckCircle2, Info, Loader2, TrendingDown } from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  Cell,
} from "recharts";
import { cn } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  crossCheck,
  interpretLseg,
  tradeHints,
  type LsegEvent,
  type LsegOption,
  type Holder,
  type LsegSignals,
  type Tone,
  type Interpretation,
  type TradeHints,
} from "@/lib/lseg-interpret";
import { formatMdYy } from "@/lib/format";
import { dispersionNote, earningsHistoryNote, earningsPremium, type EarningsPremium } from "@/lib/lseg-earnings";
import {
  LSEG_GLOSSARY,
  buildLsegEvidence,
  buildLsegTradeEvidence,
  lsegRankChartData,
} from "@/lib/lseg-report";
import {
  fmtRelHint,
  peerHowToUse,
  peerGroupLabel,
  relTone,
  type PeerRelativeBlock,
  type RelChip,
} from "@/lib/research-peers";
import { ResearchOpsBanner } from "@/components/research-ops-banner";
import { ResearchPeerPanel } from "@/components/research-peer-panel";
import { ReportSection, ResearchReportShell } from "@/components/research-report-shell";
import {
  U,
  WhyCallout,
  WhyMetric,
} from "@/components/research-why";

type LsegPayload = {
  ticker: string;
  available: boolean;
  reason: string | null;
  signals: LsegSignals | null;
  events: LsegEvent[];
  nextEarnings: LsegEvent | null;
  myPosition: { shares: number | null; snapshotAt?: string | null; options: LsegOption[] } | null;
  history: { combinedAlpha: { date: string; value: number | null }[] };
  earningsHistory?: { date: string; movePct: number | null }[];
  topHolders?: Holder[];
  tech?: { iv: number | null; rv: number | null };
  peers?: PeerRelativeBlock | null;
};

const TONE_TEXT: Record<Tone, string> = {
  good: "text-green-400",
  bad: "text-red-400",
  warn: "text-amber-300",
  neutral: "text-zinc-300",
};

const TONE_BOX: Record<Tone, string> = {
  good: "border-green-500/30 bg-green-500/5",
  bad: "border-red-500/30 bg-red-500/5",
  warn: "border-amber-400/30 bg-amber-400/5",
  neutral: "border-[#d4af37]/15 bg-zinc-900/40",
};

const TONE_BADGE: Record<Tone, string> = {
  good: "border-green-500/40 bg-green-500/10 text-green-300",
  bad: "border-red-500/40 bg-red-500/10 text-red-300",
  warn: "border-amber-400/40 bg-amber-400/10 text-amber-300",
  neutral: "border-zinc-500/40 bg-zinc-800/80 text-zinc-300",
};

const TONE_ICON: Record<Tone, typeof Info> = {
  good: CheckCircle2,
  bad: TrendingDown,
  warn: AlertTriangle,
  neutral: Info,
};

const EVENT_LABEL: Record<string, string> = {
  EarningsReleases: "Earnings",
  CorporateAnalystMeetings: "Analyst / investor day",
  ShareholderAndAnnualMeetings: "Shareholder meeting",
  CorporateSalesRelease: "Monthly sales",
  GuidanceCalls: "Guidance call",
  MergersAndAcquisitions: "M&A",
};

const TAB =
  "text-[10px] font-semibold px-2 h-6 rounded text-amber-200/50 data-[state=active]:bg-[#d4af37] data-[state=active]:text-black";

function Gauge({ value, tone }: { value: number; tone: Tone }) {
  return (
    <div className="relative h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden" aria-hidden>
      <div className="absolute inset-y-0 left-[30%] w-px bg-zinc-600" />
      <div className="absolute inset-y-0 left-[70%] w-px bg-zinc-600" />
      <div
        className={cn(
          "absolute inset-y-0 left-0 rounded-full",
          tone === "good" ? "bg-green-500/80" : tone === "bad" ? "bg-red-500/80" : "bg-zinc-400/70",
        )}
        style={{ width: `${Math.max(2, Math.min(100, value))}%` }}
      />
    </div>
  );
}

function lsegCompactChips(data: LsegPayload, r: Interpretation): RelChip[] {
  const s = data.signals!;
  const chips: RelChip[] = [];
  const m = data.peers?.metrics;

  if (s.epsDrift30dPct != null) {
    chips.push({
      label: "FY1 30d",
      value: `${s.epsDrift30dPct > 0 ? "+" : ""}${s.epsDrift30dPct.toFixed(1)}%`,
      hint: fmtRelHint(m?.epsDrift30dPct) ?? (s.epsMeanFy1 != null ? `$${s.epsMeanFy1.toFixed(2)} level` : "drift"),
      tone:
        m?.epsDrift30dPct?.peerPct != null
          ? relTone(m.epsDrift30dPct.peerPct)
          : s.epsDrift30dPct >= 1
            ? "good"
            : s.epsDrift30dPct <= -1
              ? "bad"
              : "neutral",
    });
  }
  if (s.armRank != null) {
    chips.push({
      label: "ARM",
      value: String(s.armRank),
      hint: fmtRelHint(m?.armRank, { digits: 0 }) ?? "≥70 / ≤30 NA univ",
      tone: m?.armRank?.peerPct != null ? relTone(m.armRank.peerPct) : s.armRank >= 70 ? "good" : s.armRank <= 30 ? "bad" : "neutral",
    });
  }
  if (s.combinedAlphaRank != null) {
    chips.push({
      label: "Comb α",
      value: String(s.combinedAlphaRank),
      hint: fmtRelHint(m?.combinedAlphaRank, { digits: 0 }) ?? "blended StarMine",
      tone:
        m?.combinedAlphaRank?.peerPct != null
          ? relTone(m.combinedAlphaRank.peerPct)
          : s.combinedAlphaRank >= 70
            ? "good"
            : s.combinedAlphaRank <= 30
              ? "bad"
              : "neutral",
    });
  }
  if (s.predSurprisePct != null) {
    chips.push({
      label: "PredSurp",
      value: `${s.predSurprisePct > 0 ? "+" : ""}${s.predSurprisePct.toFixed(1)}%`,
      hint: fmtRelHint(m?.predSurprisePct) ?? "±2% beat/miss call",
      tone:
        m?.predSurprisePct?.peerPct != null
          ? relTone(m.predSurprisePct.peerPct)
          : s.predSurprisePct >= 2
            ? "good"
            : s.predSurprisePct <= -2
              ? "bad"
              : "neutral",
    });
  }
  if (data.tech?.iv != null) chips.push({ label: "IV", value: `${data.tech.iv.toFixed(0)}%`, hint: "ATM put", tone: "neutral" });
  if (data.nextEarnings) {
    chips.push({
      label: "ER",
      value: `${data.nextEarnings.daysUntil}d`,
      hint: formatMdYy(data.nextEarnings.date),
      tone: data.nextEarnings.daysUntil <= 7 ? "warn" : "neutral",
    });
  }
  void r;
  return chips.slice(0, 6);
}

function MiniCamSpark({ pts }: { pts: { date: string; value: number }[] }) {
  if (pts.length < 2) return null;
  return (
    <div className="h-10 w-full rounded border border-[#d4af37]/10 bg-zinc-950/60">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={pts.slice(-12)} margin={{ top: 2, right: 2, left: 2, bottom: 0 }}>
          <ReferenceLine y={50} stroke="#52525b55" strokeDasharray="2 2" />
          <Line type="monotone" dataKey="value" stroke="#d4af37" strokeWidth={1.4} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function LsegReport({
  data,
  r,
  hints,
  agree,
  premium,
}: {
  data: LsegPayload;
  r: Interpretation;
  hints: TradeHints;
  agree: ReturnType<typeof crossCheck>;
  premium: EarningsPremium | null;
}) {
  const s = data.signals!;
  const VerdictIcon = TONE_ICON[r.verdict.tone];
  const camPts = data.history.combinedAlpha
    .filter((p) => p.value != null)
    .map((p) => ({ date: p.date.slice(5), full: p.date, value: p.value as number }));
  const upcoming = data.events.filter((e) => EVENT_LABEL[e.type]).slice(0, 8);
  const evidence = buildLsegEvidence(s, r, premium);
  const trade = buildLsegTradeEvidence(s, hints, premium, data.nextEarnings?.daysUntil ?? null);
  const ranks = lsegRankChartData(s);

  return (
    <Tabs defaultValue="verdict" className="w-full">
      <TabsList className="h-7 p-0.5 bg-zinc-950 border border-[#d4af37]/20 rounded overflow-x-auto w-full justify-start mb-2 sticky top-0 z-10">
        <TabsTrigger value="verdict" className={TAB}>Verdict</TabsTrigger>
        <TabsTrigger value="signals" className={TAB}>Signals</TabsTrigger>
        <TabsTrigger value="peers" className={TAB}>Peers</TabsTrigger>
        <TabsTrigger value="trade" className={TAB}>Trade</TabsTrigger>
        <TabsTrigger value="more" className={TAB}>More</TabsTrigger>
      </TabsList>

      <TabsContent value="verdict" className="space-y-3 mt-0">
        <WhyCallout
          tone={r.verdict.tone === "good" ? "good" : r.verdict.tone === "bad" ? "bad" : r.verdict.tone === "warn" ? "warn" : "neutral"}
          title={
            <span className="flex items-start gap-2">
              <VerdictIcon className={cn("w-4 h-4 mt-0.5 shrink-0", TONE_TEXT[r.verdict.tone])} />
              <span>
                <U>Bottom line</U> · coverage {r.coverage}
                {peerGroupLabel(data.peers) ? ` · ${peerGroupLabel(data.peers)}` : ""}
              </span>
            </span>
          }
        >
          <p className={cn("text-[13px] font-medium", TONE_TEXT[r.verdict.tone])}>{r.verdict.text}</p>
          {agree && <p className={cn("text-[11px]", TONE_TEXT[agree.tone])}>{agree.text}</p>}
        </WhyCallout>

        <div className="space-y-1.5">
          {evidence.map((e, i) => (
            <div key={i} className={cn("rounded border px-2.5 py-1.5", TONE_BOX[e.tone])}>
              <div className={cn("font-medium text-[11.5px] leading-snug", TONE_TEXT[e.tone])}>{e.claim}</div>
              <div className="text-[10px] text-zinc-400 leading-snug mt-0.5">{e.proof}</div>
            </div>
          ))}
        </div>
      </TabsContent>

      <TabsContent value="signals" className="space-y-3 mt-0">
        <WhyMetric
          label="ARM (Analyst Revisions Model)"
          value={s.armRank != null ? String(s.armRank) : "—"}
          sub="≥70 constructive · ≤30 weak · NA universe"
          tone={s.armRank != null && s.armRank >= 70 ? "good" : s.armRank != null && s.armRank <= 30 ? "bad" : "neutral"}
        />

        <WhyMetric
          label="Combined Alpha"
          value={s.combinedAlphaRank != null ? String(s.combinedAlphaRank) : "—"}
        />

        <WhyMetric
          label="Predicted surprise %"
          value={
            s.predSurprisePct != null
              ? `${s.predSurprisePct > 0 ? "+" : ""}${s.predSurprisePct.toFixed(1)}%`
              : "—"
          }
          sub="SmartEstimate vs consensus · ±2% call"
          tone={
            s.predSurprisePct != null && s.predSurprisePct >= 2
              ? "good"
              : s.predSurprisePct != null && s.predSurprisePct <= -2
                ? "bad"
                : "neutral"
          }
        />

        <WhyMetric
          label="FY1 30d drift %"
          value={
            s.epsDrift30dPct != null
              ? `${s.epsDrift30dPct > 0 ? "+" : ""}${s.epsDrift30dPct.toFixed(1)}%`
              : "—"
          }
          sub={s.epsMeanFy1 != null ? `level $${s.epsMeanFy1.toFixed(2)} · use % not $` : undefined}
        />

        {ranks.length >= 2 && (
          <div className="h-40 w-full rounded border border-[#d4af37]/10 bg-zinc-950/80 pt-2">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={ranks} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#a1a1aa" }} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#71717a" }} width={28} />
                <Tooltip contentStyle={{ background: "#09090b", border: "1px solid #3f3f46", fontSize: 11 }} />
                <ReferenceLine y={70} stroke="#22c55e55" strokeDasharray="3 3" />
                <ReferenceLine y={30} stroke="#ef444455" strokeDasharray="3 3" />
                <Bar dataKey="value" name="rank" radius={[3, 3, 0, 0]}>
                  {ranks.map((row) => (
                    <Cell
                      key={row.name}
                      fill={row.value >= 70 ? "#22c55e99" : row.value <= 30 ? "#ef444499" : "#d4af3799"}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {r.rows.map((row) => (
          <div key={row.key} className="rounded border border-[#d4af37]/10 bg-zinc-900/50 px-2 py-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-zinc-300">{row.label}</span>
              <span className={cn("font-mono font-semibold", TONE_TEXT[row.tone])}>{row.value}</span>
            </div>
            {row.gauge != null && (
              <div className="my-1">
                <Gauge value={row.gauge} tone={row.tone} />
              </div>
            )}
            <div className="text-[10px] text-zinc-500 leading-snug">{row.meaning}</div>
          </div>
        ))}

        {camPts.length >= 2 && (
          <ReportSection title="Combined Alpha history">
            <div className="h-36 w-full rounded border border-[#d4af37]/10 bg-zinc-950/80 pt-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={camPts} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: "#71717a" }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#a1a1aa" }} width={28} />
                  <Tooltip contentStyle={{ background: "#09090b", border: "1px solid #3f3f46", fontSize: 11 }} />
                  <ReferenceLine y={50} stroke="#52525b" strokeDasharray="2 3" />
                  <Line type="monotone" dataKey="value" stroke="#d4af37" strokeWidth={1.8} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </ReportSection>
        )}
      </TabsContent>

      <TabsContent value="peers" className="mt-0 space-y-2">
        <ResearchPeerPanel
          peers={data.peers}
          selfTicker={data.ticker}
          emptyHint="No taxonomy peer group — absolute StarMine only."
          rows={[
            {
              key: "combinedAlphaRank",
              label: "Combined Alpha",
              meaning: "Peer % on top of NA 1–100.",
              higherBetter: true,
              digits: 0,
            },
            {
              key: "armRank",
              label: "ARM",
              meaning: "p70+ among peers = leading revision tape in-group.",
              higherBetter: true,
              digits: 0,
            },
            {
              key: "predSurprisePct",
              label: "Pred. surprise %",
              meaning: "Is your beat call crowded in-sector?",
              higherBetter: true,
            },
            {
              key: "epsDrift30dPct",
              label: "FY1 30d drift %",
              meaning: "Comparable % — replaces meaningless FY1 $ levels.",
              higherBetter: true,
            },
          ]}
        />
      </TabsContent>

      <TabsContent value="trade" className="space-y-3 mt-0">
        {trade.map((t) => (
          <div key={t.side} className="rounded border border-[#d4af37]/15 bg-zinc-900/50 px-2.5 py-2 space-y-1">
            <div className="text-[10px] uppercase tracking-wider text-amber-200/60">
              {t.side === "puts" ? "Selling puts" : "Selling calls"} · {t.stance}
            </div>
            <div className="text-[12px] font-medium text-zinc-100">{t.headline}</div>
            <ul className="list-disc pl-4 space-y-1 text-[10.5px] text-zinc-400 leading-snug">
              {t.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>
          </div>
        ))}

        <ReportSection title="Position flags">
          {r.takeaways.length === 0 ? (
            <p className="text-zinc-500 italic">No position-specific flags.</p>
          ) : (
            r.takeaways.map((t, i) => {
              const Icon = TONE_ICON[t.tone];
              return (
                <div key={i} className={cn("rounded border px-2 py-1.5 flex gap-2", TONE_BOX[t.tone])}>
                  <Icon className={cn("w-3.5 h-3.5 mt-0.5 shrink-0", TONE_TEXT[t.tone])} />
                  <div>
                    <div className={cn("font-medium", TONE_TEXT[t.tone])}>{t.title}</div>
                    <div className="text-zinc-400 text-[10.5px] leading-snug">{t.detail}</div>
                  </div>
                </div>
              );
            })
          )}
        </ReportSection>
      </TabsContent>

      <TabsContent value="more" className="space-y-3 mt-0">
        <details className="group rounded border border-[#d4af37]/12 bg-zinc-900/40">
          <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] font-semibold text-[#d4af37] list-none flex items-center gap-1">
            <span className="text-zinc-500 group-open:rotate-90 transition-transform">▸</span>
            Glossary (?)
          </summary>
          <div className="px-2.5 pb-2 space-y-1.5">
            {LSEG_GLOSSARY.map((g) => (
              <div key={g.term} className="rounded border border-[#d4af37]/10 bg-zinc-950/60 px-2 py-1.5">
                <div className="text-[11px] font-semibold text-[#d4af37]">{g.term}</div>
                <p className="text-[10.5px] text-zinc-400 leading-snug mt-0.5">{g.def}</p>
              </div>
            ))}
          </div>
        </details>

        <WhyMetric
          label="PT upside"
          value={
            s.ptUpsidePct != null ? `${s.ptUpsidePct > 0 ? "+" : ""}${s.ptUpsidePct.toFixed(0)}%` : "—"
          }
          sub={s.ptMean != null ? `mean $${s.ptMean.toFixed(0)}` : undefined}
        />

        <ReportSection title="Ownership & events">
          {(data.topHolders?.length ?? 0) === 0 ? (
            <p className="text-zinc-500 italic">No holders_top rows.</p>
          ) : (
            data.topHolders!.slice(0, 8).map((h) => (
              <div key={h.rank} className="flex justify-between gap-2 font-mono text-[10px]">
                <span className="text-zinc-400 truncate">
                  {h.rank}. {h.investor}
                </span>
                <span className="shrink-0 text-zinc-300">{h.pctOut != null ? `${h.pctOut.toFixed(1)}%` : "—"}</span>
              </div>
            ))
          )}
          {upcoming.map((e, i) => (
            <div key={i} className="flex justify-between font-mono text-[10px]">
              <span className="text-zinc-400">{formatMdYy(e.date)}</span>
              <span className={cn(e.type === "EarningsReleases" && e.daysUntil <= 14 ? "text-amber-300" : "text-zinc-500")}>
                {EVENT_LABEL[e.type]} · {e.daysUntil}d
              </span>
            </div>
          ))}
        </ReportSection>

        <ResearchOpsBanner lane="lseg" />
      </TabsContent>
    </Tabs>
  );
}

export function LsegStreetPanel({ ticker, embedded }: { ticker: string; embedded?: boolean }) {
  const { isAdmin } = useAuth();
  const { data, isLoading, error } = useQuery({
    queryKey: ["research-lseg", ticker],
    queryFn: async (): Promise<LsegPayload> => {
      const res = await fetch(`/api/research/lseg/${encodeURIComponent(ticker)}`);
      if (!res.ok) throw new Error(`LSEG research ${res.status}`);
      return res.json();
    },
    enabled: !!isAdmin && !!ticker,
    staleTime: 5 * 60 * 1000,
  });

  // WRDS cross-check only after LSEG resolves — avoids parallel heavy research hits.
  const { data: wrds } = useQuery({
    queryKey: ["research-wrds", ticker],
    queryFn: async (): Promise<{ available?: boolean; verdict?: "supportive" | "neutral" | "caution" }> => {
      const res = await fetch(`/api/research/wrds/${encodeURIComponent(ticker)}`);
      if (!res.ok) throw new Error(`WRDS research ${res.status}`);
      return res.json();
    },
    enabled: !!isAdmin && !!ticker && !!data?.available,
    staleTime: 5 * 60 * 1000,
  });

  if (!isAdmin) {
    return <p className="text-[10px] text-amber-200/50 italic py-1">Street research (LSEG) — admin only</p>;
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-amber-100 py-2 justify-center">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading LSEG…
      </div>
    );
  }
  if (error) return <p className="text-[10px] text-red-300 italic">{(error as Error).message}</p>;

  if (!data?.available || !data.signals) {
    return (
      <ResearchReportShell
        lane="lseg"
        title={ticker}
        verdictLabel="no data"
        verdictClass="border-zinc-600 text-zinc-500"
        summaryLine={data?.reason ?? "No LSEG cache for this ticker."}
        report={
          <div className="space-y-2">
            <p className="text-zinc-300">{data?.reason ?? "No LSEG cache."}</p>
            <ResearchOpsBanner lane="lseg" />
          </div>
        }
        embedded={embedded}
      />
    );
  }

  const pastMoves = (data.earningsHistory ?? []).map((m) => m.movePct).filter((m): m is number => m != null);
  const premium = earningsPremium({
    pastMovesPct: pastMoves,
    ivPct: data.tech?.iv ?? null,
    rvPct: data.tech?.rv ?? null,
    reportDate: data.nextEarnings?.date ?? null,
  });
  const input = {
    signals: data.signals,
    nextEarnings: data.nextEarnings,
    myPosition: data.myPosition,
    premium,
    dispersion: dispersionNote(data.signals.epsMeanFq1, data.signals.epsStdFq1, data.signals.numEstFq1),
    historyNote: earningsHistoryNote(pastMoves),
    topHolders: data.topHolders ?? [],
  };
  const r = interpretLseg(input);
  const hints = tradeHints(input, r);
  const agree = wrds?.available ? crossCheck(r.verdict.tone, wrds.verdict) : null;

  const camPts = data.history.combinedAlpha
    .filter((p) => p.value != null)
    .map((p) => ({ date: p.date.slice(5), value: p.value as number }));

  const summaryBits: string[] = [r.verdict.text];
  if (data.signals.epsDrift30dPct != null) {
    summaryBits.push(`30d ${data.signals.epsDrift30dPct > 0 ? "+" : ""}${data.signals.epsDrift30dPct.toFixed(1)}%`);
  }
  const cam = data.peers?.metrics?.combinedAlphaRank;
  if (data.signals.combinedAlphaRank != null) {
    summaryBits.push(
      `α ${data.signals.combinedAlphaRank}${cam?.peerPct != null ? ` (p${Math.round(cam.peerPct)})` : ""}`,
    );
  }

  return (
    <ResearchReportShell
      lane="lseg"
      title={ticker}
      subtitle={formatMdYy(data.signals.asOf)}
      verdictLabel={r.verdict.tone}
      verdictClass={TONE_BADGE[r.verdict.tone]}
      summaryLine={summaryBits.join(" · ")}
      howTo={embedded ? undefined : peerHowToUse(data.peers, "lseg")}
      chips={lsegCompactChips(data, r)}
      sparkline={embedded ? undefined : <MiniCamSpark pts={camPts} />}
      compactBody={
        agree ? <p className={cn("text-[10px] leading-snug", TONE_TEXT[agree.tone])}>{agree.text}</p> : null
      }
      report={<LsegReport data={data} r={r} hints={hints} agree={agree} premium={premium} />}
      embedded={embedded}
    />
  );
}
