#!/usr/bin/env node
/**
 * One-shot mechanical extract for A332 target 2 redo. Run from repo root.
 * Does not add imports — follow with tsc fix pass.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const routesMon = join(root, "src/routes/scheduled-tasks.ts");
const schedMon = join(root, "src/lib/scheduler.ts");

function slice(file, start, end) {
  const lines = readFileSync(file, "utf8").split("\n");
  return lines.slice(start - 1, end).join("\n") + "\n";
}

const stDir = join(root, "src/routes/scheduled-tasks");
const schDir = join(root, "src/lib/scheduler");
mkdirSync(stDir, { recursive: true });
mkdirSync(schDir, { recursive: true });

// scheduled-tasks modules (1-based line numbers inclusive)
writeFileSync(join(stDir, "types.ts"), slice(routesMon, 164, 218));
writeFileSync(join(stDir, "paths.ts"), slice(routesMon, 90, 101));
writeFileSync(
  join(stDir, "helpers.ts"),
  slice(routesMon, 67, 86) + "\n" + slice(routesMon, 102, 163) + slice(routesMon, 220, 411),
);
writeFileSync(join(stDir, "build-tasks.ts"), slice(routesMon, 413, 1575));
writeFileSync(join(stDir, "router-handlers.ts"), slice(routesMon, 1577, 1979));

// scheduler modules
writeFileSync(join(schDir, "keys.ts"), slice(schedMon, 66, 79));
writeFileSync(join(schDir, "state.ts"), slice(schedMon, 81, 115));
writeFileSync(join(schDir, "config.ts"), slice(schedMon, 117, 186));
writeFileSync(join(schDir, "timing.ts"), slice(schedMon, 188, 302));
writeFileSync(join(schDir, "jobs-enrichment-trade.ts"), slice(schedMon, 304, 413));
writeFileSync(join(schDir, "jobs-morning.ts"), slice(schedMon, 415, 505));
writeFileSync(join(schDir, "jobs-ingest.ts"), slice(schedMon, 507, 633));
writeFileSync(join(schDir, "regime.ts"), slice(schedMon, 635, 693));
writeFileSync(join(schDir, "persist.ts"), slice(schedMon, 695, 761));
writeFileSync(join(schDir, "loop.ts"), slice(schedMon, 763, 812));

console.log("extracted slices to", stDir, schDir);
