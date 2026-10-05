#!/usr/bin/env npx tsx
/** Manual / catch-up model accountability snapshot (Friday live-bid freeze). */
import { eq } from "drizzle-orm";
import { db, pool, appConfig } from "@workspace/db";
import { runModelSnapshot } from "../lib/model-track-record.js";
import { writeFileSync, mkdirSync } from "node:fs";

async function stamp(key: string, date: Date) {
  const value = date.toISOString();
  const existing = await db.select().from(appConfig).where(eq(appConfig.key, key)).limit(1);
  if (existing.length === 0) await db.insert(appConfig).values({ key, value });
  else await db.update(appConfig).set({ value, updatedAt: new Date() }).where(eq(appConfig.key, key));
}

async function main() {
  const result = await runModelSnapshot();
  const now = new Date();
  await stamp("last_model_snapshot_run", now);
  await stamp("last_option_score_snapshot_run", now);
  mkdirSync("/tmp/fildi-logs", { recursive: true });
  writeFileSync(
    "/tmp/fildi-logs/model-snapshot-last.json",
    JSON.stringify({ ts: now.toISOString(), ...result }, null, 2),
  );
  console.log(JSON.stringify({ ts: now.toISOString(), ...result }, null, 2));
  if (result.degraded) process.exitCode = 2;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
  });
