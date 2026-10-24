#!/usr/bin/env npx tsx
/**
 * Model accountability snapshot (Friday live-bid freeze) + miss-day catch-up.
 *   npx tsx src/scripts/run-model-snapshot.ts
 *   npx tsx src/scripts/run-model-snapshot.ts --as-of=2026-10-23 --from-history
 */
import { eq } from "drizzle-orm";
import { db, pool, appConfig } from "@workspace/db";
import { runModelSnapshot } from "../lib/model-track-record.js";
import { writeFileSync, mkdirSync } from "node:fs";

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`${name}=`));
  return a ? a.slice(name.length + 1) : undefined;
}

async function stamp(key: string, date: Date) {
  const value = date.toISOString();
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  if (existing.length === 0) await db.insert(appConfig).values({ key, value });
  else await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, key));
}

async function main() {
  const asOf = arg("--as-of");
  const fromHistory = process.argv.includes("--from-history");
  const result = await runModelSnapshot(asOf, { fromHistory });
  const now = new Date();
  // Only stamp "ran today" for live/current-session runs — history backfill must not block next Friday.
  if (!fromHistory && (!asOf || asOf === now.toISOString().slice(0, 10))) {
    await stamp("last_model_snapshot_run", now);
    await stamp("last_option_score_snapshot_run", now);
  }
  mkdirSync("/tmp/fildi-logs", { recursive: true });
  writeFileSync(
    "/tmp/fildi-logs/model-snapshot-last.json",
    JSON.stringify({ ts: now.toISOString(), asOf: asOf ?? null, fromHistory, ...result }, null, 2),
  );
  console.log(JSON.stringify({ ts: now.toISOString(), asOf: asOf ?? null, fromHistory, ...result }, null, 2));
  if (result.degraded) process.exitCode = 2;
  if (result.recs === 0 && fromHistory) process.exitCode = 3;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
