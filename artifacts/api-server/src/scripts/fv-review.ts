/**
 * Fair value review table (Jamie 10-27): watchlist names + for sectors the watchlist barely covers, the 2 closest and
 * 2 farthest model values vs price. Read-only (latest fair_value_snapshots + the same inputs the model used).
 * Peers used = group members with a usable forward P/E (0–150, the model's peer filter; sector fallback when < 5).
 * Writes JSON for the formatter: research/fair_value/out/fv_review.json
 *
 *   pnpm exec tsx src/scripts/fv-review.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { pool } from "@workspace/db";
import { loadInputs } from "../lib/fair-value-snapshots.js";

const OUT = new URL("../../../../research/fair_value/out/", import.meta.url);
const sectorOf = (g: string | null) => (g ?? "unknown").split(".")[0]!;

async function main() {
  const inputs = await loadInputs();
  const fpe = new Map(inputs.map((t) => [t.ticker, t.price && t.forwardEps && t.forwardEps > 0 ? t.price / t.forwardEps : null]));
  const usable = (t: string) => { const v = fpe.get(t); return v != null && v > 0 && v < 150; };
  const q = async <T,>(sql: string, args: unknown[] = []) => (await pool.query(sql, args)).rows as T[];
  const snap = await q<{ ticker: string; price: string; fair_value: string | null; adjusted_fair_value: string | null; confidence: string | null;
    null_reason: string | null; mode: string; votes: { name: string; value: number; kept: boolean }[]; cyclical: boolean; value_trap: boolean }>(
    `SELECT DISTINCT ON (ticker) ticker, price, fair_value, adjusted_fair_value, confidence, null_reason, mode, votes, cyclical, value_trap
     FROM fair_value_snapshots ORDER BY ticker, as_of DESC`);
  const reg = await q<{ ticker: string; g: string | null; gname: string | null; peers: string[] | null }>(
    `SELECT r.ticker, r.primary_peer_group_id g, pg.name gname, r.peer_tickers peers FROM ticker_registry r
     LEFT JOIN peer_groups pg ON pg.id = r.primary_peer_group_id WHERE r.is_active AND r.fetch_fundamentals`);
  const yahoo = new Map((await q<{ ticker: string; v: string }>(
    "SELECT ticker, yahoo_target_mean_price v FROM yahoo_fundamentals WHERE yahoo_target_mean_price IS NOT NULL")).map((r) => [r.ticker, Number(r.v)]));
  const street = new Map((await q<{ ticker: string; v: string; n: number; source: string }>(
    "SELECT DISTINCT ON (ticker) ticker, median_pt v, n, source FROM street_pt_daily ORDER BY ticker, as_of DESC")).map((r) => [r.ticker, r]));
  const firms = new Map<string, string[]>();
  for (const r of await q<{ ticker: string; firm: string; pt: string; d: string }>(
    `SELECT DISTINCT ON (ticker, firm) ticker, firm, price_target pt, event_date::text d FROM analyst_events
     WHERE price_target > 0 AND event_date >= current_date - 120 ORDER BY ticker, firm, event_date DESC`)) {
    (firms.get(r.ticker) ?? firms.set(r.ticker, []).get(r.ticker)!).push(`${r.firm} ${Math.round(Number(r.pt))} (${r.d.slice(5)})`);
  }
  const wl = new Set((await q<{ ticker: string }>("SELECT DISTINCT UPPER(ticker) ticker FROM watchlist")).map((r) => r.ticker));
  const s = new Map(snap.map((r) => [r.ticker, r]));
  const members = new Map<string, string[]>();
  for (const r of reg) if (r.g) (members.get(r.g) ?? members.set(r.g, []).get(r.g)!).push(r.ticker);

  const row = (r: (typeof reg)[number]) => {
    const f = s.get(r.ticker);
    const price = f ? Number(f.price) : null;
    const fv = f?.fair_value != null ? Number(f.fair_value) : null;
    const grp = (members.get(r.g ?? "") ?? []).filter((t) => t !== r.ticker);
    const used = grp.filter(usable);
    const sectorFallback = used.length < 5;
    return {
      ticker: r.ticker, watchlist: wl.has(r.ticker), sector: sectorOf(r.g), group: r.gname, mode: f?.mode ?? null,
      peersUsed: sectorFallback ? [`sector fallback (${sectorOf(r.g)})`] : used,
      peersNotUsed: [...grp.filter((t) => !usable(t)).map((t) => `${t}*`), ...(r.peers ?? []).filter((t) => !grp.includes(t) && t !== r.ticker).slice(0, 4)],
      price, yahooTarget: yahoo.get(r.ticker) ?? null,
      street: street.get(r.ticker) ? { pt: Number(street.get(r.ticker)!.v), n: street.get(r.ticker)!.n, source: street.get(r.ticker)!.source } : null,
      firms: (firms.get(r.ticker) ?? []).slice(0, 3),
      fairValue: fv, adjusted: f?.adjusted_fair_value != null ? Number(f.adjusted_fair_value) : null,
      gap: fv != null && price ? fv / price - 1 : null, confidence: f?.confidence ?? null, nullReason: f?.null_reason ?? null,
      votes: (f?.votes ?? []).map((v) => `${v.name}${v.kept ? "" : "✗"} ${Math.round(v.value)}`), cyclical: f?.cyclical ?? false, valueTrap: f?.value_trap ?? false,
      ownFwdPe: fpe.get(r.ticker) ?? null,
    };
  };
  const all = reg.map(row);
  // Universe gap distribution on log(FV/price): outliers by Tukey fences (1.5 × IQR)
  const lg = all.filter((r) => r.gap != null).map((r) => Math.log(1 + r.gap!)).sort((a, b) => a - b);
  const pct = (p: number) => lg[Math.floor(p * (lg.length - 1))]!;
  const [q1, q3] = [pct(0.25), pct(0.75)];
  const lo = q1 - 1.5 * (q3 - q1), hi = q3 + 1.5 * (q3 - q1);
  const core = lg.filter((x) => x >= lo && x <= hi);
  const mean = core.reduce((a, b) => a + b, 0) / core.length;
  const meanAbs = core.reduce((a, b) => a + Math.abs(b), 0) / core.length;
  const stats = { valued: lg.length, unvalued: all.length - lg.length, median: Math.exp(pct(0.5)) - 1, p25: Math.exp(q1) - 1, p75: Math.exp(q3) - 1,
    normalLow: Math.exp(lo) - 1, normalHigh: Math.exp(hi) - 1, outliers: lg.length - core.length,
    meanExOutliers: Math.exp(mean) - 1, meanAbsExOutliers: Math.exp(meanAbs) - 1 };
  // Selection: watchlist + 2 closest / 2 farthest in sectors with < 3 watchlist names
  const bySector = new Map<string, typeof all>();
  for (const r of all) (bySector.get(r.sector) ?? bySector.set(r.sector, []).get(r.sector)!).push(r);
  const picks = all.filter((r) => r.watchlist);
  const thin: string[] = [];
  for (const [sec, rs] of bySector) {
    if (rs.filter((r) => r.watchlist).length >= 3) continue;
    thin.push(sec);
    const v = rs.filter((r) => r.gap != null && !r.watchlist).sort((a, b) => Math.abs(Math.log(1 + a.gap!)) - Math.abs(Math.log(1 + b.gap!)));
    picks.push(...v.slice(0, 2).map((r) => ({ ...r, pick: "closest" })), ...v.slice(-2).map((r) => ({ ...r, pick: "farthest" })));
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(new URL("fv_review.json", OUT), JSON.stringify({ stats, thinSectors: thin, rows: picks, outliersAll: all.filter((r) => r.gap != null &&
    (Math.log(1 + r.gap) < lo || Math.log(1 + r.gap) > hi)) }, null, 1));
  console.log(JSON.stringify({ stats, thin, picks: picks.length }, null, 1));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
