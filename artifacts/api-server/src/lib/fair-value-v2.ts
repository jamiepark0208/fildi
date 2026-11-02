/**
 * A283 fair value v2 (fv-2.0.0, Jamie approved 11-02): three chips, never blended across families.
 *   Street     — LSEG I/B/E/S median price target (low–high, analysts); Argus when LSEG has none.
 *   Cash flow  — range of StarMine IV, FMP DCF, residual income and the lab DCF P50 (lab P10–P90 alongside).
 *   Reverse    — where today's price sits in the lab DCF distribution ("price needs our P85 outcome").
 * Headline only when street and cash-flow mids are within 2× of each other (sources 10-29: on high-growth names every
 * cash-flow source sits at 5–50 % of price while the street sits above it — one number would hide that split).
 * Display only: never gates, sizes or ranks a rec.
 */
import { pool } from "@workspace/db";

export const FV_V2_VERSION = "fv-2.0.0";
const MAX_FAMILY_RATIO = 2;

export interface CashPoint { source: string; label: string; value: number; asOf: string | null }
export interface FairValueV2 {
  version: string;
  price: number | null;
  street: { median: number; low: number | null; high: number | null; analysts: number | null; source: string; asOf: string | null } | null;
  cashFlow: { low: number; high: number; mid: number; points: CashPoint[]; lab: { p10: number; p50: number; p90: number; asOf: string } | null; unitsCheck: CashPoint[] } | null;
  reverse: { pricePct: number | null; text: string; asOf: string | null } | null;
  headline: number | null;
  headlineWhy: string;
}

export interface V2Inputs {
  price: number | null;
  street: FairValueV2["street"];
  points: CashPoint[];
  lab: { valued: boolean; p10: number | null; p50: number | null; p90: number | null; pricePct: number | null; reason: string | null; asOf: string } | null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Pure: inputs → chips + headline rule (unit-tested). */
export function buildFairValueV2(i: V2Inputs): FairValueV2 {
  // Units check (SKHY: won-based values on a US price): points > 5× or < 1/20 of price are set aside and listed, not used.
  const ok = (v: number) => !i.price || (v <= i.price * 5 && v >= i.price / 20);
  const finite = i.points.filter((p) => Number.isFinite(p.value) && p.value > 0);
  const points = finite.filter((p) => ok(p.value));
  const unitsCheck = finite.filter((p) => !ok(p.value));
  const lab = i.lab?.valued && i.lab.p10 != null && i.lab.p50 != null && i.lab.p90 != null
    ? { p10: i.lab.p10, p50: i.lab.p50, p90: i.lab.p90, asOf: i.lab.asOf } : null;
  if (lab && lab.p50 > 0) points.push({ source: "fildi_dcf", label: "Fildi DCF (P50)", value: lab.p50, asOf: lab.asOf });
  const vals = points.map((p) => p.value);
  const cashFlow = vals.length ? { low: Math.min(...vals), high: Math.max(...vals), mid: median(vals), points, lab, unitsCheck } : null;

  let reverse: FairValueV2["reverse"] = null;
  if (i.lab?.valued && i.lab.pricePct != null) {
    const pct = Math.round(i.lab.pricePct * 100);
    reverse = { pricePct: i.lab.pricePct, asOf: i.lab.asOf,
      text: pct >= 99 ? "Price is above our P99 cash-flow outcome" : pct <= 1 ? "Price is below our P1 cash-flow outcome" : `Price needs our P${pct} cash-flow outcome` };
  } else if (i.lab && !i.lab.valued && i.lab.reason) {
    reverse = { pricePct: null, asOf: i.lab.asOf, text: `Not valued by our DCF: ${i.lab.reason}` };
  }

  let headline: number | null = null;
  let headlineWhy: string;
  const s = i.street?.median ?? null;
  const c = cashFlow?.mid ?? null;
  if (s != null && c != null) {
    const ratio = Math.max(s, c) / Math.min(s, c);
    if (ratio <= MAX_FAMILY_RATIO) { headline = (s + c) / 2; headlineWhy = `Street and cash-flow agree within ${ratio.toFixed(1)}× — midpoint shown`; }
    else headlineWhy = `No single value: street $${s.toFixed(0)} vs cash-flow $${c.toFixed(0)} (${ratio.toFixed(1)}× apart)`;
  } else headlineWhy = s == null && c == null ? "No street or cash-flow value" : `Only the ${s != null ? "street" : "cash-flow"} family has a value`;

  return { version: FV_V2_VERSION, price: i.price, street: i.street, cashFlow, reverse, headline, headlineWhy };
}

const CASH_SOURCES: Record<string, string> = { starmine: "LSEG StarMine IV", fmp_dcf: "FMP DCF", fildi_rim: "Residual income" };

/** DB reads only (no vendor calls) — saved values from the daily jobs. */
export async function loadFairValueV2(ticker: string, price: number | null): Promise<FairValueV2> {
  const t = ticker.toUpperCase();
  const q = <T>(text: string) => pool.query(text, [t]).then((r) => r.rows as T[]).catch(() => [] as T[]);
  const [ext, st, lab] = await Promise.all([
    q<{ source: string; value: string; as_of: string }>(`SELECT DISTINCT ON (source) source, value, as_of::text AS as_of FROM watchlist_sync.external_intrinsic
      WHERE ticker = $1 AND value IS NOT NULL AND as_of >= CURRENT_DATE - 45 ORDER BY source, as_of DESC`),
    q<{ as_of: string; price_close: string | null; pt_median: string; pt_low: string | null; pt_high: string | null; pt_num_est: string | null }>(
      `SELECT as_of::text AS as_of, price_close, pt_median, pt_low, pt_high, pt_num_est FROM lseg_research.signals_daily
       WHERE ticker = $1 AND pt_median IS NOT NULL AND as_of >= CURRENT_DATE - 30 ORDER BY as_of DESC LIMIT 1`),
    q<{ as_of: string; valued: boolean; detail: Record<string, unknown> }>(`SELECT as_of::text AS as_of, valued, detail FROM watchlist_sync.dcf_detail
      WHERE ticker = $1 AND as_of >= CURRENT_DATE - 14 ORDER BY as_of DESC LIMIT 1`),
  ]);
  const n = (v: unknown) => (v == null || v === "" ? null : Number(v));
  const argus = ext.find((e) => e.source === "argus_pt");
  const s0 = st[0];
  const street: FairValueV2["street"] = s0
    ? { median: Number(s0.pt_median), low: n(s0.pt_low), high: n(s0.pt_high), analysts: n(s0.pt_num_est), source: "LSEG I/B/E/S", asOf: s0.as_of }
    : argus ? { median: Number(argus.value), low: null, high: null, analysts: null, source: "Argus (via Yahoo)", asOf: argus.as_of } : null;
  const points = ext.filter((e) => CASH_SOURCES[e.source]).map((e) => ({ source: e.source, label: CASH_SOURCES[e.source]!, value: Number(e.value), asOf: e.as_of }));
  const l = lab[0];
  const d = (l?.detail ?? {}) as Record<string, unknown>;
  return buildFairValueV2({
    price: price ?? n(s0?.price_close) ?? n(d["price"]),
    street,
    points,
    lab: l ? { valued: l.valued, p10: n(d["p10"]), p50: n(d["p50"]), p90: n(d["p90"]), pricePct: n(d["price_pct"]),
               reason: (d["reason"] as string | undefined) ?? null, asOf: l.as_of } : null,
  });
}
