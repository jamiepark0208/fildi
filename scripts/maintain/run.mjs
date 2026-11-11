import { runEnrichPhase } from "./run-enrich-phase.mjs";
import { finalizeRun } from "./run-finalize.mjs";

export async function runMaintainMain(flags) {
  const ctx = { ...flags, actions: [], researchSoftWarns: [], timings: {} };
  await runEnrichPhase(ctx);
  // Skip paths (before 08:00 ET, chain done, 3 attempts, lock held) return before ctx is filled; pre-split
  // they returned from main. Finalizing then threw "reading 'processOk'" on every skipped tick (11-10).
  if (!ctx.finalFlags) return;
  await finalizeRun(ctx);
}
