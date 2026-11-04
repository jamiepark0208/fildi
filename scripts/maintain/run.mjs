import { runEnrichPhase } from "./run-enrich-phase.mjs";
import { finalizeRun } from "./run-finalize.mjs";

export async function runMaintainMain(flags) {
  const ctx = { ...flags, actions: [], researchSoftWarns: [], timings: {} };
  await runEnrichPhase(ctx);
  await finalizeRun(ctx);
}
