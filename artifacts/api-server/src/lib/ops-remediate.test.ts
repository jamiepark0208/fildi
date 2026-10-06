/**
 * Unit tests for ops whitelist remediate helpers (no spawn).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countOpenAlerts,
  remediateTaskIdsFromAlerts,
  REMEDIATE_WHITELIST,
} from "./ops-remediate.ts";
import type { OpsAlert } from "./scheduled-tasks-inventory.ts";

function alert(partial: Partial<OpsAlert> & { id: string }): OpsAlert {
  return {
    severity: partial.severity ?? "warn",
    title: partial.title ?? partial.id,
    detail: partial.detail ?? "",
    taskIds: partial.taskIds ?? [],
    fix: partial.fix ?? null,
    ...partial,
  };
}

describe("ops-remediate whitelist", () => {
  it("REMEDIATE_WHITELIST excludes Duo/OAuth/scores", () => {
    assert.equal(REMEDIATE_WHITELIST.has("maintain"), true);
    assert.equal(REMEDIATE_WHITELIST.has("regime"), true);
    assert.equal(REMEDIATE_WHITELIST.has("schwab-health"), false);
    assert.equal(REMEDIATE_WHITELIST.has("research-ops-health"), false);
    assert.equal(REMEDIATE_WHITELIST.has("option-scores"), false);
  });

  it("countOpenAlerts ignores info", () => {
    const n = countOpenAlerts([
      alert({ id: "a", severity: "critical", taskIds: ["maintain"] }),
      alert({ id: "b", severity: "warn", taskIds: ["regime"] }),
      alert({ id: "c", severity: "info", taskIds: ["maintain"] }),
    ]);
    assert.equal(n, 2);
  });

  it("remediateTaskIdsFromAlerts maps maintain + regime, collapses stack into maintain", () => {
    const ids = remediateTaskIdsFromAlerts([
      alert({
        id: "failed-maintain",
        severity: "critical",
        taskIds: ["maintain", "stack-ensure"],
        fix: "Run Maintain",
      }),
      alert({
        id: "regime-overdue",
        severity: "warn",
        taskIds: ["regime"],
        detail: "Regime checkpoint overdue",
      }),
      alert({
        id: "schwab-oauth",
        severity: "critical",
        taskIds: ["schwab-health"],
        fix: "Re-run schwab-oauth",
      }),
    ]);
    assert.deepEqual(ids.sort(), ["maintain", "regime"].sort());
  });

  it("returns empty when only NEEDS_YOU alerts", () => {
    const ids = remediateTaskIdsFromAlerts([
      alert({
        id: "duo",
        severity: "warn",
        taskIds: ["research-ops-health"],
        fix: "Approve Duo push",
      }),
    ]);
    assert.deepEqual(ids, []);
  });
});
