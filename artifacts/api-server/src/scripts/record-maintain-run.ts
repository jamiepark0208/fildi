/**
 * Record a daily maintain run into enrichment_runs so Stock DB Pipeline Health sees it.
 *
 *   pnpm exec tsx src/scripts/record-maintain-run.ts --report=/tmp/fildi-logs/maintain-last.json
 */
import { readFileSync } from "node:fs";
import { db, enrichmentRuns } from "@workspace/db";

const reportArg = process.argv.find((a) => a.startsWith("--report="));
const reportPath = reportArg?.split("=")[1] ?? "/tmp/fildi-logs/maintain-last.json";

type MaintainReport = {
  ts?: string;
  ms?: number;
  healthOk?: boolean;
  actions?: string[];
  budget?: {
    goldCoverage?: string | null;
    /** Field-fill % across core gold columns — true coverage state (not row existence). */
    fieldFillPct?: number | null;
    fieldFillPctBefore?: number | null;
    needsReview?: number | null;
    anomalies?: string[];
  };
};

function parseGoldPct(cov: string | null | undefined): number | null {
  if (!cov || !cov.includes("/")) return null;
  const [a, b] = cov.split("/").map((x) => Number(x));
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  return Math.round((a / b) * 1000) / 10;
}

async function main() {
  const raw = readFileSync(reportPath, "utf8");
  const report = JSON.parse(raw) as MaintainReport;
  const actions = report.actions ?? [];
  const startedAt = report.ts ? new Date(report.ts) : new Date();
  // Prefer started_at ≈ end - duration
  const ms = Number(report.ms) || 0;
  const started = new Date(startedAt.getTime() - ms);
  const finished = startedAt;

  const failedStep = actions.some((a) => /_exit_[1-9]/.test(a) || /_exit_-/.test(a));
  const status: "success" | "partial" | "failed" =
    report.healthOk === false || failedStep ? (failedStep && report.healthOk === false ? "failed" : "partial") : "success";

  const detail = [
    ...actions,
    ...(report.budget?.anomalies?.length ? [`anomalies:${report.budget.anomalies.join("|")}`] : []),
    report.budget?.needsReview != null ? `NR=${report.budget.needsReview}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
    .slice(0, 800);

  // Prefer field-fill % (current state of gold cells). Row-existence goldCoverage
  // is ~100% once every ticker has a row and was wrongly used for both before+after.
  const afterPct =
    typeof report.budget?.fieldFillPct === "number" && Number.isFinite(report.budget.fieldFillPct)
      ? report.budget.fieldFillPct
      : parseGoldPct(report.budget?.goldCoverage ?? null);
  const beforePct =
    typeof report.budget?.fieldFillPctBefore === "number" && Number.isFinite(report.budget.fieldFillPctBefore)
      ? report.budget.fieldFillPctBefore
      : afterPct;

  await db.insert(enrichmentRuns).values({
    startedAt: started,
    finishedAt: finished,
    status,
    trigger: "maintain",
    perSource: {
      maintain: {
        targeted: actions.length,
        fetched: actions.filter((a) => /exit_0/.test(a)).length,
        nodata: 0,
        failed: actions.filter((a) => /_exit_[1-9]/.test(a)).length,
        budgetSkipped: actions.filter((a) => /skipped/.test(a)).length,
      },
      __detail: detail,
      __coverageNote: "field_fill_pct",
      __goldRows: report.budget?.goldCoverage ?? null,
    },
    coverageBefore: beforePct != null ? String(beforePct) : null,
    coverageAfter: afterPct != null ? String(afterPct) : null,
    error: status === "failed" ? detail : null,
  });

  console.log(JSON.stringify({ ok: true, trigger: "maintain", status, detail: detail.slice(0, 200) }));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
