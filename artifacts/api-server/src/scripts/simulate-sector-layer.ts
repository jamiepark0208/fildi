#!/usr/bin/env npx tsx
/**
 * Simulate sector-layer blend weights on final rankings (read-only analysis).
 * Sector score: size (log mcap sum) 50% + prospects (median rev growth + ROE) 30%
 *             + cheapness (median 1/PE) 20%. Speculative_* groups haircut size.
 *
 *   cd artifacts/api-server && npx tsx src/scripts/simulate-sector-layer.ts
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type Row = {
  ticker: string;
  company: number;
  peerGroupId: string;
  sector: string;
  mcap: number | null;
  revG: number | null;
  roe: number | null;
  pe: number | null;
};

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function rank01(values: (number | null)[], higherIsBetter: boolean): (number | null)[] {
  const idxs = values.map((v, i) => (v != null && Number.isFinite(v) ? i : -1)).filter((i) => i >= 0);
  const out: (number | null)[] = values.map(() => null);
  if (idxs.length === 0) return out;
  const sorted = [...idxs].sort((a, b) =>
    higherIsBetter ? (values[b] as number) - (values[a] as number) : (values[a] as number) - (values[b] as number),
  );
  sorted.forEach((i, rankIdx) => {
    out[i] = idxs.length > 1 ? (idxs.length - 1 - rankIdx) / (idxs.length - 1) : 1;
  });
  return out;
}

async function main() {
  const raw = await db.execute(sql`
    SELECT
      tf.ticker,
      tf.fund_total_score::float8 AS company,
      r.primary_peer_group_id AS peer_group_id,
      split_part(r.primary_peer_group_id, '.', 1) AS sector,
      COALESCE(
        NULLIF(f.finnhub_market_cap::float8, 0) * 1e6,
        CASE
          WHEN tf.pe_ratio::float8 > 0 AND tf.earnings_per_share::float8 IS NOT NULL AND tf.shares_outstanding::float8 > 0
          THEN tf.pe_ratio::float8 * tf.earnings_per_share::float8 * tf.shares_outstanding::float8
          ELSE NULL
        END
      ) AS mcap,
      tf.revenue_growth_yoy::float8 AS rev_g,
      tf.return_on_equity::float8 AS roe,
      tf.pe_ratio::float8 AS pe
    FROM ticker_fundamentals tf
    JOIN ticker_registry r ON r.ticker = tf.ticker
    LEFT JOIN finnhub_fundamentals f ON f.ticker = tf.ticker
    WHERE tf.fund_rank > 0
      AND tf.fund_total_score IS NOT NULL
      AND r.primary_peer_group_id IS NOT NULL
  `);
  const rows: Row[] = ((raw as any).rows ?? raw).map((r: any) => ({
    ticker: String(r.ticker),
    company: Number(r.company),
    peerGroupId: String(r.peer_group_id),
    sector: String(r.sector),
    mcap: r.mcap != null ? Number(r.mcap) : null,
    revG: r.rev_g != null ? Number(r.rev_g) : null,
    roe: r.roe != null ? Number(r.roe) : null,
    pe: r.pe != null ? Number(r.pe) : null,
  }));

  // Aggregate by peer group (finer than sector — better "opportunity set")
  const byGroup = new Map<string, Row[]>();
  for (const r of rows) {
    if (!byGroup.has(r.peerGroupId)) byGroup.set(r.peerGroupId, []);
    byGroup.get(r.peerGroupId)!.push(r);
  }

  type GroupFeat = {
    id: string;
    n: number;
    sizeLog: number;
    medRevG: number | null;
    medRoe: number | null;
    medEy: number | null; // 1/PE
    speculative: boolean;
  };

  const groups: GroupFeat[] = [];
  for (const [id, members] of byGroup) {
    const speculative = /speculative/i.test(id);
    const mcaps = members.map((m) => m.mcap).filter((v): v is number => v != null && v > 0);
    const sizeSum = mcaps.reduce((s, v) => s + v, 0);
    // Cap insane growth for medians
    const revGs = members
      .map((m) => m.revG)
      .filter((v): v is number => v != null && Number.isFinite(v))
      .map((v) => Math.max(-0.5, Math.min(1.0, v)));
    const roes = members
      .map((m) => m.roe)
      .filter((v): v is number => v != null && Number.isFinite(v) && Math.abs(v) < 2);
    const eys = members
      .map((m) => (m.pe != null && m.pe >= 3 && m.pe <= 100 ? 1 / m.pe : null))
      .filter((v): v is number => v != null);
    groups.push({
      id,
      n: members.length,
      sizeLog: sizeSum > 0 ? Math.log10(sizeSum) : 0,
      medRevG: median(revGs),
      medRoe: median(roes),
      medEy: median(eys),
      speculative,
    });
  }

  const sizeR = rank01(groups.map((g) => (g.speculative ? g.sizeLog * 0.5 : g.sizeLog)), true);
  const growthR = rank01(groups.map((g) => g.medRevG), true);
  const qualityR = rank01(groups.map((g) => g.medRoe), true);
  const cheapR = rank01(groups.map((g) => g.medEy), true); // higher EY = cheaper

  const sectorScore = new Map<string, number>();
  groups.forEach((g, i) => {
    const size = sizeR[i] ?? 0.5;
    const prosp = ((growthR[i] ?? 0.5) + (qualityR[i] ?? 0.5)) / 2;
    const cheap = cheapR[i] ?? 0.5;
    // size 50% / prospects 30% / sector cheapness 20%
    const s01 = 0.5 * size + 0.3 * prosp + 0.2 * cheap;
    sectorScore.set(g.id, 50 + (s01 - 0.5) * 100); // roughly 0–100 centered
  });

  // Normalize sector scores to ~same mean/spread as company for fair blend
  const secVals = [...sectorScore.values()];
  const secMean = secVals.reduce((a, b) => a + b, 0) / secVals.length;
  const coMean = rows.reduce((a, b) => a + b.company, 0) / rows.length;
  const secStd = Math.sqrt(secVals.reduce((a, b) => a + (b - secMean) ** 2, 0) / secVals.length) || 1;
  const coStd = Math.sqrt(rows.reduce((a, b) => a + (b.company - coMean) ** 2, 0) / rows.length) || 1;
  for (const [id, s] of sectorScore) {
    // map to company score distribution
    sectorScore.set(id, coMean + ((s - secMean) / secStd) * coStd);
  }

  const lambdas = [0, 0.05, 0.1, 0.15, 0.2];

  function top20(lam: number) {
    return rows
      .map((r) => {
        const sec = sectorScore.get(r.peerGroupId) ?? coMean;
        const final = (1 - lam) * r.company + lam * sec;
        return { ticker: r.ticker, final, company: r.company, sec, group: r.peerGroupId, sector: r.sector };
      })
      .sort((a, b) => b.final - a.final)
      .slice(0, 20);
  }

  const baseline = top20(0);
  const baseRank = new Map(baseline.map((r, i) => [r.ticker, i + 1]));

  console.log("=== Sector opportunity score (peer-group level) — top/bottom by sectorScore ===");
  const groupBoard = groups
    .map((g) => ({
      id: g.id,
      n: g.n,
      sizeLog: +g.sizeLog.toFixed(2),
      score: +(sectorScore.get(g.id) ?? 0).toFixed(2),
      speculative: g.speculative,
    }))
    .sort((a, b) => b.score - a.score);
  console.log("TOP groups:", groupBoard.slice(0, 8).map((g) => `${g.id}(${g.n})=${g.score}`).join(" | "));
  console.log("BOTTOM groups:", groupBoard.slice(-6).map((g) => `${g.id}(${g.n})=${g.score}`).join(" | "));

  console.log("\n=== Top 20 by λ (sector weight) ===");
  for (const lam of lambdas) {
    const t20 = top20(lam);
    const turnover = t20.filter((r) => !baseRank.has(r.ticker)).length;
    const moved = t20
      .map((r) => {
        const br = baseRank.get(r.ticker);
        if (br == null) return `${r.ticker}:NEW`;
        const d = br - (t20.findIndex((x) => x.ticker === r.ticker) + 1);
        return d !== 0 ? `${r.ticker}:${br}→${t20.findIndex((x) => x.ticker === r.ticker) + 1}(${d > 0 ? "+" : ""}${d})` : null;
      })
      .filter(Boolean);
    console.log(`\nλ=${(lam * 100).toFixed(0)}%  newInTop20=${turnover}  rankMoves=${moved.length}`);
    console.log(
      t20
        .map((r, i) => {
          const br = baseRank.get(r.ticker);
          const tag = br == null ? " NEW" : br !== i + 1 ? ` was#${br}` : "";
          return `${String(i + 1).padStart(2)}. ${r.ticker.padEnd(5)} ${r.final.toFixed(2)} (co=${r.company.toFixed(1)} sec=${r.sec.toFixed(1)})${tag}`;
        })
        .join("\n"),
    );
  }

  // Spearman-ish: avg |Δrank| for baseline top 20 under each λ
  console.log("\n=== Stability of baseline top-20 (avg |Δrank| among those still ranked) ===");
  for (const lam of lambdas.filter((l) => l > 0)) {
    const all = rows
      .map((r) => {
        const sec = sectorScore.get(r.peerGroupId) ?? coMean;
        return { ticker: r.ticker, final: (1 - lam) * r.company + lam * sec };
      })
      .sort((a, b) => b.final - a.final);
    const newRank = new Map(all.map((r, i) => [r.ticker, i + 1]));
    const deltas = baseline.map((b) => Math.abs((newRank.get(b.ticker) ?? 999) - (baseRank.get(b.ticker) ?? 0)));
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const maxD = Math.max(...deltas);
    console.log(`λ=${(lam * 100).toFixed(0)}%: avg|Δrank|=${avg.toFixed(1)}  max|Δrank|=${maxD}`);
  }

  // Show a few names' sector scores for intuition
  console.log("\n=== Sample tickers: company vs sector opportunity ===");
  for (const t of ["PLTR", "MU", "FUTU", "ALNY", "NVDA", "AAPL", "MSFT", "IONQ", "NUE", "JPM"]) {
    const r = rows.find((x) => x.ticker === t);
    if (!r) continue;
    const sec = sectorScore.get(r.peerGroupId)!;
    console.log(
      `${t.padEnd(5)} co=${r.company.toFixed(2)} sec=${sec.toFixed(2)} group=${r.peerGroupId}  → λ15%=${((1 - 0.15) * r.company + 0.15 * sec).toFixed(2)}`,
    );
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
