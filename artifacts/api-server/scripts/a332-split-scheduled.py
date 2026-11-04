#!/usr/bin/env python3
"""Generate scheduled-tasks/*.ts from monolith (A332). Static TS only."""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "src/routes/scheduled-tasks.monolith.bak"
OUT = ROOT / "src/routes/scheduled-tasks"
OUT.mkdir(parents=True, exist_ok=True)

lines = SRC.read_text().splitlines()


def sl(a: int, b: int) -> str:
    return "\n".join(lines[a - 1 : b])


# --- types ---
(OUT / "types.ts").write_text(sl(164, 218) + "\n")

helpers_head = '''import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { etDateKey } from "../../lib/market-hours.js";
import {
  CHECKPOINTS_MIN,
  getCheckpointsForDate,
  getTodaysCheckpoints,
  type RegimeCheckpoint,
} from "../../lib/intraday-regime.js";
import type { TaskStatus, TodayState, VerifyCheck, ScheduledTaskRow } from "./types.js";

export const LOG_DIR = "/tmp/fildi-logs";
export const LAUNCH_AGENTS = join(homedir(), "Library/LaunchAgents");
export const RBH_LOG = join(homedir(), "rbh_scripts/logs/daily_export.log");
export const RBH_LAST = join(homedir(), "rbh_scripts/logs/last_run.json");
export const RBH_SCRIPT = join(homedir(), "rbh_scripts/daily_export.sh");
export const RBH_EXPORT_PROMPT_LAST = join(homedir(), "rbh_scripts/logs/export_prompt_last.json");
export const PM_ALERTS_LAST = "/tmp/fildi-logs/pm-alerts-last.json";
export const TRANSCRIPTS_LAST = "/tmp/fildi-logs/transcripts-last.json";
export const OPENJEV_LAST = "/tmp/fildi-logs/openjev-last.json";
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
export const PM_PY = join(ROOT, "scripts/watchlist_sync/.venv/bin/python");

export const CHECKPOINT_TIME_PT: Record<number, string> = {
  15: "6:45 AM PT",
  30: "7:00 AM PT",
  45: "7:15 AM PT",
  60: "7:30 AM PT",
  90: "8:00 AM PT",
  120: "8:30 AM PT",
  150: "9:00 AM PT",
  180: "9:30 AM PT",
  210: "10:00 AM PT",
  270: "11:00 AM PT",
  330: "12:00 PM PT",
};

'''

helpers_body = (
    sl(67, 86).replace("async function checkpointsForAgenda", "export async function checkpointsForAgenda")
    + "\n\n"
    + sl(102, 111).replace("function readLast", "export function readLast").replace(
        "function pmJobStatus", "export function pmJobStatus"
    )
    + "\n\n"
    + sl(127, 163).replace("\nfunction ", "\nexport function ")
    + "\n\n"
    + sl(220, 411).replace("\nfunction ", "\nexport function ")
)
(OUT / "helpers.ts").write_text(helpers_head + helpers_body + "\n")

locals_src = sl(417, 602)
rows1 = sl(605, 978)  # inside array after `const rows = [`
rows2 = sl(979, 1160)
rows3 = sl(1161, 1563).removesuffix("\n  ];").removesuffix("  ];")

# Collect const/let names from locals for Inv type (rough)
names: list[str] = []
for m in re.finditer(r"^\s*(?:const|let)\s+([A-Za-z_][A-Za-z0-9_]*)", locals_src, re.M):
    names.append(m.group(1))
for m in re.finditer(r"^\s*const\s+([A-Za-z_][A-Za-z0-9_]*)\s*=", locals_src, re.M):
    pass
# include nested function names as optional - skip

inv_fields = sorted(set(names + ["checkpoints", "researchReport"]), key=lambda x: (names + ["checkpoints", "researchReport"]).index(x))
inv_type = "export type Inv = {\n" + "\n".join(f"  {n}: unknown;" for n in inv_fields) + "\n};\n"

inv_common = '''import { join } from "node:path";
import { homedir } from "node:os";
import {
  lastEnrichmentRun, enrichmentRunning,
  lastTradeExpiryRun, tradeExpiryRunning,
  lastModelSnapshotRun, modelSnapshotRunning,
  lastOptionScoreRun, optionScoreRunning,
  lastEventBulletsRun, eventBulletsRunning,
  lastEarningsBackfillRun, earningsBackfillRunning,
  lastFmpAnalystFeedRun, fmpAnalystFeedRunning,
  lastDeskIngestRun, deskIngestRunning,
  lastSchwabHealthRun, schwabHealthRunning,
  lastSchwab1mPollRun, schwab1mPollRunning,
  lastResearchOpsRun, researchOpsRunning,
} from "../../lib/scheduler.js";
import { getSchwabAuthStatus } from "../../lib/schwab-auth.js";
import { type ResearchOpsReport } from "../../lib/research-ops.js";
import { CHECKPOINTS_MIN, type RegimeCheckpoint } from "../../lib/intraday-regime.js";
import type { ScheduledTaskRow } from "./types.js";
import {
  LOG_DIR,
  RBH_EXPORT_PROMPT_LAST,
  RBH_LAST,
  RBH_LOG,
  RBH_SCRIPT,
  OPENJEV_LAST,
  PM_ALERTS_LAST,
  TRANSCRIPTS_LAST,
  ageLabel,
  apiStatus,
  checkpointDueMinutesPt,
  isRegimeRecorded,
  launchdState,
  pmJobStatus,
  ptParts,
  ranPtToday,
  readJsonFile,
  regimeLeanLabel,
  rhCsvReady,
  vcheck,
  withToday,
  ymdInTz,
  CHECKPOINT_TIME_PT,
} from "./helpers.js";

'''

(OUT / "inventory-types.ts").write_text(inv_type)

prepare_fn = f'''export function prepareInv(
  checkpoints: RegimeCheckpoint[],
  researchReport: ResearchOpsReport | null,
): Inv {{
  {locals_src}
  return {{ {", ".join(inv_fields)} }};
}}
'''

def rows_fn(name: str, body: str) -> str:
    destruct = ", ".join(inv_fields)
    return f'''export function {name}(inv: Inv): ScheduledTaskRow[] {{
  const {{ {destruct} }} = inv as Inv & Record<string, unknown>;
  return [
{body}
  ];
}}
'''

(OUT / "inventory-rows-1.ts").write_text(
    "// @ts-nocheck\n" + inv_common + 'import type { Inv } from "./inventory-types.js";\n\n' + rows_fn("inventoryRows1", rows1)
)
(OUT / "inventory-rows-2.ts").write_text(
    "// @ts-nocheck\n" + inv_common + 'import type { Inv } from "./inventory-types.js";\n\n' + rows_fn("inventoryRows2", rows2)
)
(OUT / "inventory-rows-3.ts").write_text(
    "// @ts-nocheck\n" + inv_common + 'import type { Inv } from "./inventory-types.js";\n\n' + rows_fn("inventoryRows3", rows3)
)

build_tasks = '''import type { RegimeCheckpoint } from "../../lib/intraday-regime.js";
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
'''
(OUT / "inventory.ts").write_text(build_tasks)

(OUT / "inventory-prepare.ts").write_text(
    "// @ts-nocheck\n"
    + inv_common
    + 'import type { Inv } from "./inventory-types.js";\n\n'
    + prepare_fn
)

routes_head = '''import { Router } from "express";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireAdmin } from "../../middleware/requireAdmin.js";
import {
  runModelSnapshotJob,
  runTradeExpiry,
  runOptionScoreJob,
  runRetentionPrune,
  runRegimeCheckpoints,
  runEventBulletsJob,
  runEarningsBackfillJob,
  runFmpAnalystFeedJob,
  runDeskIngestJob,
  runSchwabHealthJob,
  runSchwab1mPoll,
  runResearchOpsJob,
} from "../../lib/scheduler.js";
import { getResearchOpsReport } from "../../lib/research-ops.js";
import { type RegimeCheckpoint } from "../../lib/intraday-regime.js";
import { buildInventory, buildNucleus, detectOpsAlerts } from "../../lib/scheduled-tasks-inventory.js";
import {
  countOpenAlerts,
  finalizeRemediateIfPending,
  readRemediateReport,
  remediateTaskIdsFromAlerts,
  REMEDIATE_WHITELIST,
  runOpsRemediate,
} from "../../lib/ops-remediate.js";
import { priceCoverage } from "../../lib/price-coverage.js";
import { getOptionsChainSourceStats } from "../../lib/options-chain-source-stats.js";
import { buildTasks, findTask } from "./inventory.js";
import {
  checkpointsForAgenda,
  LOG_DIR,
  ptParts,
  readJsonFile,
  readMacResources,
  readTail,
  RBH_SCRIPT,
  ROOT,
  PM_PY,
  LAUNCH_AGENTS,
  launchdState,
} from "./helpers.js";
import { execFileSync } from "node:child_process";

const router = Router();

'''
routes_body = sl(1577, 1980)
(OUT / "routes.ts").write_text(routes_head + routes_body + "\nexport default router;\n")

entry = '''export type {
  TaskRunner,
  TaskStatus,
  TodayState,
  VerifyCheck,
  ScheduledTaskRow,
} from "./scheduled-tasks/types.js";
export { default } from "./scheduled-tasks/routes.js";
'''
(SRC.parent / "scheduled-tasks.ts").write_text(entry)

print("Generated", OUT)
for p in sorted(OUT.glob("*.ts")):
    print(p.name, sum(1 for _ in p.open()))
