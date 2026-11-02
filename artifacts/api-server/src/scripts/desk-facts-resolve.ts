#!/usr/bin/env npx tsx
/**
 * D2 bar: resolve pending desk_facts, then print agreement per kind + the disagreements (claim vs our value).
 *
 *   cd artifacts/api-server && npx tsx src/scripts/desk-facts-resolve.ts [--days 7] [--report-only]
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { ensureResolveColumns, resolvePendingDeskFacts } from "../lib/desk-fact-resolve.js";

async function main() {
  const i = process.argv.indexOf("--days");
  const days = i > 0 ? Number(process.argv[i + 1]) : 7;
  await ensureResolveColumns();
  if (!process.argv.includes("--report-only")) {
    for (let n = 0; n < 20; n++) {
      const r = await resolvePendingDeskFacts({ days, limit: 200 });
      console.log("resolve:", r);
      if (Object.values(r).every((v) => v === 0)) break;
    }
  }
  const per = (await db.execute(sql`SELECT kind, count(*) FILTER (WHERE verdict = 'agree')::int a, count(*) FILTER (WHERE verdict = 'disagree')::int d,
      count(*) FILTER (WHERE verdict = 'none')::int n, count(*) FILTER (WHERE verdict = 'n/a')::int x, count(*) FILTER (WHERE verdict IS NULL)::int u
    FROM desk_facts WHERE received_at > now() - make_interval(days => ${days}) GROUP BY 1 ORDER BY 1`)).rows as Record<string, number | string>[];
  for (const k of per) {
    const a = Number(k["a"]), d = Number(k["d"]);
    console.log(`${k["kind"]}: agree ${a} · disagree ${d} · none ${k["n"]} · n/a ${k["x"]} · unresolved ${k["u"]}${a + d ? ` · agreement ${(a / (a + d)).toFixed(2)}` : ""}`);
  }
  const cells = (await db.execute(sql`SELECT coalesce(sum((our_value->>'agree')::int), 0)::int a, coalesce(sum((our_value->>'nDisagree')::int), 0)::int d,
      coalesce(sum((our_value->>'none')::int), 0)::int n, coalesce(sum((our_value->>'pastOnly')::int), 0)::int p FROM desk_facts
    WHERE kind = 'guidance_calendar' AND origin = 'list' AND received_at > now() - make_interval(days => ${days})`)).rows[0] as Record<string, number>;
  console.log(`calendar ticker cells: agree ${cells["a"]} · disagree ${cells["d"]} · past-only ${cells["p"]} · none ${cells["n"]}`);
  const dis = (await db.execute(sql`SELECT f.kind, f.tickers, left(f.claim, 110) AS claim, f.our_value, c.source, c.received_at::date::text AS day
    FROM desk_facts f JOIN desk_commentaries c ON c.id = f.commentary_id
    WHERE f.verdict = 'disagree' AND f.received_at > now() - make_interval(days => ${days}) ORDER BY f.received_at DESC LIMIT 40`)).rows as Record<string, unknown>[];
  console.log("\ndisagreements:");
  for (const r of dis) console.log(`${r["day"]} ${r["source"]} ${r["kind"]} ${JSON.stringify(r["tickers"]).slice(0, 40)} | ${r["claim"]} | ours ${JSON.stringify(r["our_value"]).slice(0, 220)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
