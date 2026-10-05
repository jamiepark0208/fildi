#!/usr/bin/env npx tsx
import { getAllTechnicalsRows, seedAtmIvSnapshotsFromTechnicals } from "../lib/technicals-db.js";
import { computeTechnicalRankingsV2 } from "@workspace/option-scoring";

async function main() {
  if (process.argv.includes("--seed-iv")) {
    const { inserted } = await seedAtmIvSnapshotsFromTechnicals();
    console.log({ seededIvSnapshots: inserted });
  }

  const rows = await getAllTechnicalsRows();
  console.log({
    n: rows.length,
    withTp: rows.filter((r) => r.analystUpside != null).length,
    withPeer: rows.filter((r) => r.peerGroupId).length,
    withEdo: rows.filter((r) => r.earningsDaysOut != null).length,
    withVsSpy: rows.filter((r) => r.vsSpy20d != null).length,
    withHistIv: rows.filter((r) => r.ivRankEffective != null).length,
    absTpGt75: rows.filter((r) => r.analystUpside != null && Math.abs(r.analystUpside) > 0.75).length,
  });

  for (const side of ["put", "call"] as const) {
    const scored = computeTechnicalRankingsV2(rows as any, {}, undefined, side);
    const gates = { GO: 0, WATCH: 0, NO: 0 };
    for (const s of scored) gates[s.signal]++;
    console.log(`\n=== ${side} gates=${JSON.stringify(gates)} ===`);
    const top20 = scored.slice(0, 20);
    const secCount = new Map<string, number>();
    for (const s of top20) {
      const row = rows.find((r) => r.ticker === s.ticker);
      const g = row?.peerGroupId?.split(".")[0] ?? "?";
      secCount.set(g, (secCount.get(g) ?? 0) + 1);
    }
    console.log(
      "top20 sectors:",
      [...secCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(" "),
    );
    for (const s of top20) {
      const cs = s.componentScores!;
      const row = rows.find((r) => r.ticker === s.ticker);
      const fmt = (k: string) =>
        cs[k]?.score != null ? (cs[k]!.score! * 100).toFixed(0) : "na";
      console.log(
        String(s.rank).padStart(2),
        s.ticker.padEnd(6),
        s.totalScore.toFixed(1),
        s.signal.padEnd(5),
        `od=${fmt("oversoldDepth")}`,
        `rev=${fmt("reversalSignal")}`,
        `vol=${fmt("volatilityState")}`,
        `tr=${fmt("trendContext")}`,
        `rp=${fmt("relativePressure")}`,
        `an=${fmt("analystUpside")}`,
        `opt=${fmt("optionsFlow")}`,
        `up=${row?.analystUpside != null ? (row.analystUpside * 100).toFixed(0) + "%" : "na"}`,
        `vs=${row?.vsSpy20d != null ? row.vsSpy20d.toFixed(1) : "na"}`,
        `si=${row?.shortRatio != null ? row.shortRatio.toFixed(1) : "na"}`,
        `ivR=${row?.ivRankEffective != null ? (row.ivRankEffective * 100).toFixed(0) : "cross"}`,
        `grp=${row?.peerGroupId?.split(".").slice(-1)[0] ?? "?"}`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
