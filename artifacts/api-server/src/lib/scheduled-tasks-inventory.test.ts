import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_LAUNCH_AGENTS,
  buildInventory,
  buildNucleus,
  detectOpsAlerts,
  type InventoryTaskInput,
} from "./scheduled-tasks-inventory.ts";

const ALL_AGENTS = [...EXPECTED_LAUNCH_AGENTS];

function task(partial: Partial<InventoryTaskInput> & { id: string; name: string }): InventoryTaskInput {
  return {
    summary: partial.summary ?? partial.name,
    runner: partial.runner ?? "api-scheduler",
    status: partial.status ?? "ok",
    enabled: partial.enabled ?? true,
    todayState: partial.todayState ?? null,
    detail: partial.detail ?? null,
    verifyChecks: partial.verifyChecks ?? [],
    running: partial.running ?? false,
    ...partial,
  };
}

describe("detectOpsAlerts", () => {
  it("flags missing daily price bars below 95% coverage (critical below 80%)", () => {
    const base = { enrichmentDisabled: false, todayYmd: "2026-10-11", installedLaunchAgents: ALL_AGENTS, tasks: [] };
    const cov = (fresh: number) => ({
      expected: "2026-10-09", fresh, active: 569, pct: fresh / 569, staleSample: ["A"],
      noBar5d: 0, noBar5dSample: [] as string[],
    });
    assert.ok(!detectOpsAlerts({ ...base, priceCoverage: cov(560) }).some((a) => a.id === "prices-coverage"));
    assert.equal(detectOpsAlerts({ ...base, priceCoverage: cov(500) }).find((a) => a.id === "prices-coverage")?.severity, "warn");
    assert.equal(detectOpsAlerts({ ...base, priceCoverage: cov(305) }).find((a) => a.id === "prices-coverage")?.severity, "critical");
  });
  it("flags duplicate enrichment when Maintain loaded and API enrich on", () => {
    const alerts = detectOpsAlerts({
      enrichmentDisabled: false,
      todayYmd: "2026-10-05",
      installedLaunchAgents: ALL_AGENTS,
      tasks: [
        task({ id: "maintain", name: "Mac Maintain", runner: "launchd", status: "ok", enabled: true }),
        task({ id: "enrichment-api", name: "In-process Enrichment", status: "idle", enabled: true }),
      ],
    });
    assert.ok(alerts.some((a) => a.id === "dup-enrichment" && a.severity === "critical"));
  });

  it("is clean when Maintain owns enrich and API enrich is off", () => {
    const alerts = detectOpsAlerts({
      enrichmentDisabled: true,
      todayYmd: "2026-10-05",
      installedLaunchAgents: ALL_AGENTS,
      tasks: [
        task({ id: "maintain", name: "Mac Maintain", runner: "launchd", status: "ok", enabled: true }),
        task({ id: "enrichment-api", name: "In-process Enrichment", status: "off", enabled: false }),
      ],
    });
    assert.equal(alerts.some((a) => a.id === "dup-enrichment"), false);
    assert.equal(alerts.some((a) => a.id === "no-enrich-owner"), false);
    assert.equal(alerts.filter((a) => a.severity === "critical" || a.severity === "warn").length, 0);
  });

  it("flags overdue drift", () => {
    const alerts = detectOpsAlerts({
      enrichmentDisabled: true,
      todayYmd: "2026-10-05",
      installedLaunchAgents: ALL_AGENTS,
      tasks: [
        task({ id: "maintain", name: "Mac Maintain", runner: "launchd", status: "ok", enabled: true }),
        task({ id: "enrichment-api", name: "Enrich", status: "off", enabled: false }),
        task({ id: "event-bullets", name: "Event Bullets", todayState: "overdue", status: "idle" }),
      ],
    });
    assert.ok(alerts.some((a) => a.id === "drift-overdue"));
  });

  it("flags uncatalogued LaunchAgent", () => {
    const alerts = detectOpsAlerts({
      enrichmentDisabled: true,
      todayYmd: "2026-10-05",
      installedLaunchAgents: [...ALL_AGENTS, "com.fildi.mystery"],
      tasks: [
        task({ id: "maintain", name: "Mac Maintain", runner: "launchd", status: "ok", enabled: true }),
        task({ id: "enrichment-api", name: "Enrich", status: "off", enabled: false }),
      ],
    });
    assert.ok(alerts.some((a) => a.id === "unexpected-la-com.fildi.mystery"));
  });

  it("flags WRDS/LSEG research staleness loudly", () => {
    const alerts = detectOpsAlerts({
      enrichmentDisabled: true,
      todayYmd: "2026-10-05",
      installedLaunchAgents: ALL_AGENTS,
      ptDow: 1,
      research: {
        wrdsOverall: "down",
        lsegOverall: "warn",
        desktopReachable: false,
        fixHints: ["run sync_ibes"],
      },
      tasks: [
        task({ id: "maintain", name: "Mac Maintain", runner: "launchd", status: "ok", enabled: true }),
        task({ id: "enrichment-api", name: "Enrich", status: "off", enabled: false }),
        task({ id: "research-ops-health", name: "Research Ops", status: "warn" }),
      ],
    });
    assert.ok(alerts.some((a) => a.id === "research-wrds-stale" && a.severity === "critical"));
    assert.ok(alerts.some((a) => a.id === "research-lseg-warn" && a.severity === "warn"));
  });

  it("flags missing Sunday ops digest after 8 AM PT", () => {
    const alerts = detectOpsAlerts({
      enrichmentDisabled: true,
      todayYmd: "2026-10-05",
      installedLaunchAgents: ALL_AGENTS,
      ptDow: 0,
      nowMinutesPt: 9 * 60,
      opsDigest: { lastTs: "2026-09-20T12:00:00.000Z", ageDays: 15 },
      tasks: [
        task({ id: "maintain", name: "Mac Maintain", runner: "launchd", status: "ok", enabled: true }),
        task({ id: "enrichment-api", name: "Enrich", status: "off", enabled: false }),
        task({ id: "ops-digest", name: "Weekly Ops Digest", status: "warn" }),
      ],
    });
    assert.ok(alerts.some((a) => a.id === "ops-digest-missing"));
  });
});

describe("buildInventory", () => {
  it("maps known catalog ids with writes + owner", () => {
    const rows = buildInventory([
      task({ id: "maintain", name: "Mac Maintain", runner: "launchd" }),
      task({ id: "option-scores", name: "Option Score Snapshots" }),
      task({ id: "unknown-skip", name: "Should skip" }),
    ]);
    assert.deepEqual(rows.map((r) => r.taskId).sort(), ["maintain", "option-scores"]);
    assert.ok((rows.find((r) => r.taskId === "maintain")?.writes.length ?? 0) > 0);
    assert.match(rows.find((r) => r.taskId === "option-scores")?.mutex ?? "", /skip Fri noon/i);
  });
});

describe("buildNucleus", () => {
  const healthyTasks = (): InventoryTaskInput[] => [
    task({
      id: "maintain",
      name: "Mac Maintain",
      runner: "launchd",
      status: "ok",
      verified: true,
      lastRun: "2026-10-05T14:00:00.000Z",
      outcome: "full ok",
      verifyChecks: [{ ok: true, label: "Postgres up" }],
    }),
    task({ id: "stack-ensure", name: "Stack Ensure", runner: "launchd", status: "ok" }),
    task({ id: "enrichment-api", name: "Enrich", status: "off", enabled: false }),
    task({ id: "schwab-health", name: "Schwab", status: "ok" }),
    task({ id: "research-ops-health", name: "Research Ops", status: "ok" }),
    task({ id: "option-scores", name: "Option Scores", status: "ok" }),
    task({ id: "model-snapshot", name: "Model Snapshot", status: "ok" }),
    task({ id: "model-grade", name: "Model Grade", status: "idle" }),
    task({ id: "rbh-ingest", name: "RH Ingest", runner: "launchd", status: "ok" }),
    task({ id: "rbh-export", name: "RH Export", runner: "launchd", status: "idle" }),
  ];

  it("returns L0+L1 gates and 7 workers when stack is healthy", () => {
    const alerts = detectOpsAlerts({
      enrichmentDisabled: true,
      todayYmd: "2026-10-05",
      installedLaunchAgents: ALL_AGENTS,
      tasks: healthyTasks(),
    });
    const nucleus = buildNucleus({
      tasks: healthyTasks(),
      alerts,
      inventory: buildInventory(healthyTasks()),
      enrichmentDisabled: true,
      research: { wrdsOverall: "ok", lsegOverall: "ok", desktopReachable: true },
    });
    assert.deepEqual(
      nucleus.gates.map((g) => g.id),
      ["L0_process", "L1_data"],
    );
    assert.deepEqual(
      nucleus.workers.map((w) => w.id),
      ["maintain", "stack", "vendors", "research", "scores", "model", "rh"],
    );
    assert.equal(nucleus.gates[0]?.status, "ok");
    assert.equal(nucleus.gates[1]?.status, "ok");
    assert.equal(nucleus.summary.clean, true);
  });

  it("rolls L0 critical when Maintain is missing", () => {
    const tasks = healthyTasks().map((t) =>
      t.id === "maintain" ? { ...t, status: "missing" as const, enabled: false } : t,
    );
    const nucleus = buildNucleus({
      tasks,
      alerts: [],
      enrichmentDisabled: true,
    });
    assert.equal(nucleus.gates.find((g) => g.id === "L0_process")?.status, "critical");
    assert.ok(nucleus.summary.critical >= 1);
  });

  it("rolls L1 critical when WRDS is down", () => {
    const nucleus = buildNucleus({
      tasks: healthyTasks(),
      alerts: [],
      enrichmentDisabled: true,
      research: { wrdsOverall: "down", lsegOverall: "ok", desktopReachable: true },
    });
    assert.equal(nucleus.gates.find((g) => g.id === "L1_data")?.status, "critical");
    assert.equal(nucleus.workers.find((w) => w.id === "research")?.status, "critical");
  });
});
