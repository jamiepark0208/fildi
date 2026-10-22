/**
 * A99 Phase 1 — display helpers over GET /api/fundamentals/provenance/:ticker.
 * Facts only (source, as-of, divergent/override). No 0–100 quality score.
 * A215: optional cadence clause vs data_freshness CHECKS.
 */
import { cadenceClause } from "./data-freshness-cadence.ts";

/** Minimal shape — matches FieldProv from stock-db-types (avoid importing Stock DB tree in tests). */
export interface ProvTipField {
  field: string;
  winningSource: string | null;
  isOverride: boolean;
  divergent: boolean;
  fetchedAt: string | null;
  override: { source: string } | null;
}

/** Vendor estimate / forward fields — show an "E" badge. */
export const ESTIMATE_FIELDS = new Set([
  "forwardPe",
  "forwardPeg",
  "analystTargetPrice",
]);

/** Scoring metric keys (fundamentals-db / FUNDAMENTAL_METRIC_META) → provenance tfCol. */
export const SCORE_KEY_TO_PROV: Record<string, string> = {
  grossMargin: "grossMargin",
  operatingMargin: "operatingMargin",
  netMargin: "netMargin",
  roe: "returnOnEquity",
  roicWacc: "roic",
  revGrowth: "revenueGrowthYoY",
  epsGrowth: "epsGrowth",
  currentRatio: "currentRatio",
  debtToEquity: "debtToEquity",
};

export type FreshnessBand = "fresh" | "ok" | "stale" | "unknown";

function mdYy(iso: string): string {
  const s = String(iso).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const [y, m, d] = s.slice(0, 10).split("-");
    return `${Number(m)}/${Number(d)}/${y!.slice(2)}`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(2)}`;
}

export function ageLabel(ts: string | null | undefined): string {
  if (!ts) return "never";
  const d = new Date(ts);
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return "unknown";
  if (days < 0) return "today";
  if (days === 0) {
    // Intraday: show clock when we have a timestamp with time
    if (String(ts).includes("T")) {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(d);
      return `today ${parts} ET`;
    }
    return "today";
  }
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return mdYy(ts);
}

/** Derived / computed / live values (not a single vendor field row). */
export type DerivedTip = {
  /** Short field name shown first */
  label: string;
  /** sourced = vendor quote/field · derived = formula on inputs · computed = model score */
  kind: "sourced" | "derived" | "computed";
  source: string;
  asOf?: string | null;
  /** Extra clauses (inputs used, formula, caveats) */
  extra?: string | string[] | null;
  /** A215: TIP_CADENCE key or CHECKS table name */
  cadenceKey?: string | null;
};

export function formatDerivedTip(d: DerivedTip): string {
  const parts: string[] = [d.label, d.kind, d.source];
  if (d.asOf) parts.push(`as of ${ageLabel(d.asOf)}`);
  const cad = cadenceClause(d.asOf, d.cadenceKey);
  if (cad) parts.push(cad);
  const extras = Array.isArray(d.extra) ? d.extra : d.extra ? [d.extra] : [];
  for (const e of extras) if (e) parts.push(e);
  return parts.join(" · ");
}

/** Join meaning tip + provenance without doubling blanks. */
export function joinTips(...parts: Array<string | null | undefined>): string | undefined {
  const s = parts.filter(Boolean).join("\n");
  return s || undefined;
}

export function freshnessBand(fetchedAt: string | null | undefined): FreshnessBand {
  if (!fetchedAt) return "unknown";
  const days = (Date.now() - new Date(fetchedAt).getTime()) / 86_400_000;
  if (!Number.isFinite(days) || days < 0) return "unknown";
  if (days <= 7) return "fresh";
  if (days <= 30) return "ok";
  return "stale";
}

export function freshnessDotClass(band: FreshnessBand): string {
  switch (band) {
    case "fresh": return "bg-emerald-400";
    case "ok": return "bg-amber-400";
    case "stale": return "bg-orange-500";
    default: return "bg-zinc-500";
  }
}

export function provFieldForScoreKey(scoreKey: string): string | undefined {
  return SCORE_KEY_TO_PROV[scoreKey];
}

/** Strip " p72" percentile suffix from breakdown top-metric labels before lookup. */
export function scoreKeyFromTopMetricLabel(label: string): string {
  return label.replace(/\s+p\d+\s*$/, "").trim();
}

export function formatProvenanceTip(fp: ProvTipField | undefined | null): string | undefined {
  if (!fp) return undefined;
  const parts: string[] = [];
  const src = fp.isOverride && fp.override
    ? `override←${fp.override.source}`
    : (fp.winningSource ?? "unknown source");
  parts.push(src);
  parts.push(`as of ${ageLabel(fp.fetchedAt)}`);
  const cad = cadenceClause(fp.fetchedAt, "fundamentals");
  if (cad) parts.push(cad);
  if (fp.divergent) parts.push("sources disagree");
  if (fp.isOverride) parts.push("manual override");
  if (ESTIMATE_FIELDS.has(fp.field)) parts.push("estimate");
  return parts.join(" · ");
}

export function indexProvenance(fields: ProvTipField[] | undefined): Map<string, ProvTipField> {
  const m = new Map<string, ProvTipField>();
  if (!fields) return m;
  for (const f of fields) m.set(f.field, f);
  return m;
}

/** Metrics needed to explain scary % figures in tips. */
export type MetricTipCtx = {
  revenueGrowthYoY?: number | null;
  netMargin?: number | null;
  totalRevenue?: number | null;
  netIncome?: number | null;
  freeCashFlow?: number | null;
};

function fmtRev(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** Caveats that answer "is this number trustworthy?" — not just source/as-of. */
export function fieldSanityTip(fieldKey: string, m: MetricTipCtx): string | undefined {
  const lines: string[] = [];
  if (fieldKey === "revenueGrowthYoY" && m.revenueGrowthYoY != null) {
    const g = m.revenueGrowthYoY;
    lines.push(`raw ${g.toFixed(4)} (1.0 = 100% YoY)`);
    if (Math.abs(g) >= 2) {
      lines.push(`display ≈${Math.abs(g).toFixed(Math.abs(g) >= 10 ? 0 : 1)}× — not a normal %`);
    }
    const rev = fmtRev(m.totalRevenue);
    if (rev && m.totalRevenue != null && m.totalRevenue < 10_000_000) {
      lines.push(`rev ${rev} — tiny base; YoY %/× is misleading`);
    } else if (rev) {
      lines.push(`rev ${rev}`);
    }
  }
  if (fieldKey === "netMargin" && m.netMargin != null) {
    lines.push(`raw ${m.netMargin.toFixed(4)} (1.0 = 100% margin)`);
    if (m.netIncome != null && m.netIncome < 0 && m.netMargin >= 0) {
      lines.push(`NI ${fmtRev(m.netIncome)} — vendor margin ~0 while losing money; ignore "thin buffer"`);
    } else if (m.netIncome != null) {
      lines.push(`NI ${fmtRev(m.netIncome)}`);
    }
  }
  return lines.length ? lines.join("\n") : undefined;
}

/** Tip for a bull/bear/catalyst line — explains the figure in that sentence. */
export function caseLineTip(text: string, m: MetricTipCtx): string {
  const t = text.toLowerCase();
  if (/revenue|rev\b|yoy/.test(t) && (m.revenueGrowthYoY != null || /×|%/.test(text))) {
    return joinTips(
      "Rev YoY · from fundamentals merge (rule-based case)",
      fieldSanityTip("revenueGrowthYoY", m),
      /tiny base|not mature/i.test(text)
        ? "Case text already flags tiny-base — treat as noise for sizing"
        : null,
    ) ?? "Rev YoY case line";
  }
  if (/net margin|margin leaves|unprofit/.test(t)) {
    return joinTips(
      "Net margin · from fundamentals merge (rule-based case)",
      fieldSanityTip("netMargin", m),
      /unprofit/i.test(text) ? "Loss-maker wording — not a thin positive margin" : null,
    ) ?? "Net margin case line";
  }
  if (/free cash|fcf|financing/.test(t)) {
    return formatDerivedTip({
      label: "Free cash flow",
      kind: "sourced",
      source: "fundamentals merge",
      extra: m.freeCashFlow != null ? `raw ${fmtRev(m.freeCashFlow)}` : "see Cash metrics",
    });
  }
  if (/upgraded|cut|rated|downgrad|maintains|reiterated/.test(t)) {
    return formatDerivedTip({
      label: "Analyst action",
      kind: "sourced",
      source: "yahoo / fmp / headline",
      extra: "event line — not a computed metric",
    });
  }
  return formatDerivedTip({
    label: "Case line",
    kind: "derived",
    source: "rule-based metrics / catalyst text",
    extra: "Numbers come from ticker_fundamentals; hover Rev YoY / Net Mgn in score panels for field provenance",
  });
}
