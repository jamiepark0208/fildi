import type { RegimeCheckpoint } from "../../lib/intraday-regime.js";
import { type ResearchOpsReport } from "../../lib/research-ops.js";
import type { ScheduledTaskRow } from "./types.js";
import { prepareInv } from "./inventory-prepare.js";
import { inventoryRows1 } from "./inventory-rows-1.js";
import { inventoryRows2 } from "./inventory-rows-2.js";
import { inventoryRows3 } from "./inventory-rows-3.js";

export function buildTasks(
  checkpoints: RegimeCheckpoint[] = [],
  researchReport: ResearchOpsReport | null = null,
): ScheduledTaskRow[] {
  const inv = prepareInv(checkpoints, researchReport);
  const rows = [
    ...inventoryRows1(inv),
    ...inventoryRows2(inv),
    ...inventoryRows3(inv),
  ];
  return rows.sort((a, b) => a.frequencyRank - b.frequencyRank || a.name.localeCompare(b.name));
}

export function findTask(
  id: string,
  checkpoints: RegimeCheckpoint[] = [],
  researchReport: ResearchOpsReport | null = null,
) {
  return buildTasks(checkpoints, researchReport).find((t) => t.id === id) ?? null;
}
