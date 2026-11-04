import { DEFAULT_DRAIN_NR } from "./constants.mjs";

export function parseMaintainArgs(argv) {
  const args = new Set(process.argv.slice(2));
  const restartIfUnhealthy = args.has("--restart-if-unhealthy");
  const enrichIfDue = args.has("--enrich-if-due");
  const noDrainNr = args.has("--no-drain-nr");
  const staleArg = [...args].find((a) => a.startsWith("--restart-stale-days="));
  const staleDays = staleArg ? Number(staleArg.split("=")[1]) : 0;
  const drainArg = [...args].find((a) => a === "--drain-nr" || a.startsWith("--drain-nr="));
  let drainNr = drainArg
    ? (drainArg.includes("=") ? Number(drainArg.split("=")[1]) : DEFAULT_DRAIN_NR)
    : 0;
  // Daily enrich path includes a bounded FactSet drain unless explicitly disabled.
  if (enrichIfDue && !noDrainNr && drainNr === 0) {
    drainNr = DEFAULT_DRAIN_NR;
  }
  return { args, restartIfUnhealthy, enrichIfDue, noDrainNr, staleDays, drainNr };
}
