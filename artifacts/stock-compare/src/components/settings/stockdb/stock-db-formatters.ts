import type { ColDef, FmtType } from "./stock-db-columns";
import { COLS, NM_GROWTH_COLS } from "./stock-db-columns";
import type { StockDBEntry, FundamentalsRow, SourceEntry, EnrichmentRun } from "./stock-db-types";

// ── Coverage helpers ──────────────────────────────────────────────────────────

export function calcCoverage(entries: StockDBEntry[]): number {
  if (!entries.length) return 0;
  let filled = 0;
  for (const e of entries) {
    for (const col of COLS) {
      if (e.fundamentals?.[col.key] != null) filled++;
    }
  }
  return Math.round((filled / (entries.length * COLS.length)) * 100);
}

// ── Pipeline health (enrichment run history) ─────────────────────────────────

export function runStatusBadge(status: EnrichmentRun["status"]): string {
  return status === "success" ? "bg-green-500/15 text-green-400 border border-green-500/30"
    : status === "partial" ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
    : "bg-red-500/15 text-red-400 border border-red-500/30";
}

export function runTriggerLabel(trigger: EnrichmentRun["trigger"]): string {
  switch (trigger) {
    case "maintain": return "daily maintain";
    case "maintain_full": return "maintain full";
    case "scheduled": return "scheduler (legacy)";
    case "manual": return "manual";
    default: return trigger;
  }
}

/** Prefer error; else maintain __detail baked into perSource. */
export function runDetail(run: EnrichmentRun): string {
  if (run.error) return run.error;
  const detail = (run.perSource as { __detail?: unknown } | null)?.__detail;
  return typeof detail === "string" && detail.length > 0 ? detail : "—";
}

export function runDuration(run: EnrichmentRun): string {
  if (!run.finishedAt) return "—";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  const mins = Math.round(ms / 60_000);
  return mins < 1 ? "<1m" : `${mins}m`;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function fmt(raw: string | null, type: FmtType): string {
  if (raw == null) return "—";
  if (type === "text") return String(raw);
  const v = parseFloat(raw);
  if (!isFinite(v)) return "—";
  switch (type) {
    case "pct":    return `${(v * 100).toFixed(1)}%`;
    case "ratio":  return v.toFixed(2);
    case "price":  return `$${v.toFixed(2)}`;
    case "shares": return v >= 1e9 ? `${(v/1e9).toFixed(2)}B` : v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v.toFixed(0);
    case "dollars":
      const abs = Math.abs(v);
      const sign = v < 0 ? "−" : "";
      if (abs >= 1e12) return `${sign}$${(abs/1e12).toFixed(2)}T`;
      if (abs >= 1e9)  return `${sign}$${(abs/1e9).toFixed(2)}B`;
      if (abs >= 1e6)  return `${sign}$${(abs/1e6).toFixed(1)}M`;
      return `${sign}$${abs.toFixed(0)}`;
  }
}

export function isSuspect(col: ColDef, raw: string | null): boolean {
  if (!col.suspect || raw == null) return false;
  const v = parseFloat(raw);
  return isFinite(v) && col.suspect(v);
}

// Modified z-score (MAD-based) — robust to the outliers being detected.
// Returns Map<ticker, zScore> for one column within one peer group.
// logTransform: apply to right-skewed ratio fields (P/E, EV/EBITDA, etc.).
export function computeGroupZScores(entries: StockDBEntry[], colKey: keyof FundamentalsRow, logTransform: boolean): Map<string, number> {
  const MIN_GROUP = 5;
  const pairs: [string, number][] = [];
  for (const e of entries) {
    const raw = e.fundamentals?.[colKey];
    if (raw == null) continue;
    const v = parseFloat(raw as string);
    if (!isFinite(v)) continue;
    const t = logTransform ? Math.log(Math.max(Math.abs(v), 1e-6)) : v;
    pairs.push([e.ticker, t]);
  }
  if (pairs.length < MIN_GROUP) return new Map();
  const vals = pairs.map(([, v]) => v).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const absDevs = vals.map(v => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absDevs[Math.floor(absDevs.length / 2)];
  if (mad === 0) return new Map();
  return new Map(pairs.map(([ticker, v]) => [ticker, 0.6745 * (v - median) / mad]));
}

export function isNearZeroBase(col: ColDef, raw: string | null): boolean {
  if (!NM_GROWTH_COLS.has(col.key as string) || raw == null) return false;
  const v = parseFloat(raw);
  return isFinite(v) && Math.abs(v) > 10;
}

export function fmtDate(ts: string | null): string {
  if (!ts) return "never";
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  const days = Math.floor(diff / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30)  return `${days}d ago`;
  return d.toLocaleDateString();
}

/** Absolute stamp for enrich/summary chips: m/d/yy h:mma (Jamie date rule). */
export function fmtDateTime(ts: string | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const m = d.getMonth() + 1;
  const day = d.getDate();
  const y = String(d.getFullYear()).slice(-2);
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "pm" : "am";
  h = h % 12 || 12;
  return `${m}/${day}/${y} ${h}:${min}${ampm}`;
}

/** One-line enrich chip: status · field fetch totals by source · timestamp (no ticker list in DB). */
export function enrichRunChip(run: EnrichmentRun): { text: string; title: string } {
  const ps = run.perSource ?? {};
  const srcParts: string[] = [];
  let fetched = 0;
  let targeted = 0;
  for (const [src, s] of Object.entries(ps)) {
    if (src.startsWith("__") || !s || typeof s !== "object") continue;
    const f = Number(s.fetched) || 0;
    const t = Number(s.targeted) || 0;
    fetched += f;
    targeted += t;
    if (t > 0 || f > 0) srcParts.push(`${src} ${f}/${t}`);
  }
  const when = fmtDateTime(run.finishedAt ?? run.startedAt);
  const scope = targeted > 0 ? `${fetched}/${targeted} fields` : null;
  const text = ["Enrich", run.status, scope, when].filter(Boolean).join(" · ");
  const title = [
    `trigger: ${run.trigger}`,
    srcParts.length ? srcParts.join(", ") : null,
    run.error ? `error: ${run.error}` : null,
  ].filter(Boolean).join(" · ");
  return { text, title };
}

// For "used"/"available" the field itself has a value, so show its age.
// For "no_data" there's no value to age — show when the source was last
// queried instead, so "never" is reserved for sources truly never fetched
// for this ticker (rather than sources that ran and legitimately found nothing).
export function sourceAgeLabel(s: SourceEntry): string {
  if (s.status === "excluded") return "—";
  if (s.status === "no_data") {
    return s.lastQueriedAt ? `checked ${fmtDate(s.lastQueriedAt)}` : "never queried";
  }
  return fmtDate(s.fetchedAt);
}

export function sourceAgeTitle(s: SourceEntry): string | undefined {
  if (s.status !== "no_data") return undefined;
  return s.lastQueriedAt
    ? "source was queried but returned no value for this field"
    : "this source has never been fetched for this ticker";
}
