#!/usr/bin/env npx tsx
/**
 * D1 bar: desk_facts extractor vs the hand-labelled email set (research/common/briefs-d1-eval/gold.json).
 * Pass = kind F1 ≥ 0.8 · ticker recall ≥ 0.9 · 0 invented numbers (every stored number is in the email).
 *
 *   cd artifacts/api-server && npx tsx src/scripts/desk-facts-eval.ts            # extract missing, then score
 *   npx tsx src/scripts/desk-facts-eval.ts --score-only
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { cleanForExtract, extractPendingDeskFacts, numberTokens } from "../lib/desk-facts.js";
import { HAIKU_MODEL } from "../lib/haiku.js";
import LLM from "../lib/llm-models.json" with { type: "json" };

const GOLD = join(dirname(fileURLToPath(import.meta.url)), "../../../../research/common/briefs-d1-eval/gold.json");

interface Gold { id: number; kinds: string[]; tickers: string[] }

async function main() {
  const gold: Gold[] = JSON.parse(readFileSync(GOLD, "utf8"));
  const ids = gold.map((g) => g.id);
  if (!process.argv.includes("--score-only")) {
    console.log("extract:", await extractPendingDeskFacts({ ids, limit: ids.length }));
  }
  const facts = (await db.execute(sql`SELECT commentary_id AS id, kind, tickers, claim, numbers FROM desk_facts
    WHERE commentary_id = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})`)).rows as
    { id: number; kind: string; tickers: string[]; claim: string; numbers: string[] }[];
  const bodies = new Map((await db.execute(sql`SELECT id, body_plain FROM desk_commentaries
    WHERE id = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})`)).rows.map((r) => [Number(r["id"]), String(r["body_plain"])]));
  const runs = (await db.execute(sql`SELECT sum(input_tokens)::int i, sum(output_tokens)::int o,
    sum((dropped->>'numbers')::int)::int dn, sum((dropped->>'tickers')::int)::int dt, count(*) FILTER (WHERE status <> 'ok')::int bad
    FROM desk_fact_runs WHERE commentary_id = ANY(${sql.raw(`ARRAY[${ids.join(",")}]::int[]`)})`)).rows[0] as Record<string, number>;

  let tp = 0, fp = 0, fn = 0, tHit = 0, tGold = 0, tPred = 0, invented = 0;
  const perKind: Record<string, { tp: number; fp: number; fn: number }> = {};
  const misses: string[] = [];
  for (const g of gold) {
    const mine = facts.filter((f) => f.id === g.id);
    const pk = new Set(mine.map((f) => f.kind));
    const gk = new Set(g.kinds);
    for (const k of new Set([...pk, ...gk])) {
      const s = (perKind[k] ??= { tp: 0, fp: 0, fn: 0 });
      if (pk.has(k) && gk.has(k)) { tp++; s.tp++; } else if (pk.has(k)) { fp++; s.fp++; } else { fn++; s.fn++; }
    }
    const pt = new Set(mine.flatMap((f) => f.tickers));
    const missT = g.tickers.filter((t) => !pt.has(t));
    tGold += g.tickers.length; tHit += g.tickers.length - missT.length; tPred += pt.size;
    const nums = new Set(numberTokens(cleanForExtract(bodies.get(g.id) ?? "")));
    for (const f of mine) for (const n of numberTokens(`${f.claim} ${f.numbers.join(" ")}`)) if (!nums.has(n)) invented++;
    const kMiss = [...gk].filter((k) => !pk.has(k)), kExtra = [...pk].filter((k) => !gk.has(k));
    if (kMiss.length || kExtra.length || missT.length)
      misses.push(`${g.id}: facts ${mine.length}${kMiss.length ? ` · kind miss ${kMiss.join(",")}` : ""}${kExtra.length ? ` · kind extra ${kExtra.join(",")}` : ""}${missT.length ? ` · ticker miss ${missT.join(",")}` : ""}`);
  }
  const f1 = (2 * tp) / (2 * tp + fp + fn);
  const recall = tGold ? tHit / tGold : 1;
  const tickerPrecision = tPred ? tHit / tPred : 1;
  console.log(misses.join("\n"));
  console.log("\nper kind (tp/fp/fn):", Object.entries(perKind).map(([k, s]) => `${k} ${s.tp}/${s.fp}/${s.fn}`).join(" · "));
  console.log(`facts ${facts.length} · kind F1 ${f1.toFixed(3)} · ticker recall ${recall.toFixed(3)} (${tHit}/${tGold}) · ticker precision vs gold ${tickerPrecision.toFixed(3)}`);
  console.log(`invented numbers stored ${invented} · model numbers dropped by guard ${runs["dn"]} · tickers dropped ${runs["dt"]} · non-ok runs ${runs["bad"]}`);
  const price = (LLM.models as Record<string, { input: number; output: number }>)[HAIKU_MODEL]!;
  console.log(`tokens in ${runs["i"]} out ${runs["o"]} · $${(((runs["i"] ?? 0) * price.input + (runs["o"] ?? 0) * price.output) / 1e6).toFixed(4)}`);
  const pass = f1 >= 0.8 && recall >= 0.9 && invented === 0;
  console.log(pass ? "D1 bar: PASS" : "D1 bar: FAIL");
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
