import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { shouldRunRegimeCheckpointsAt } from "./scheduler-catchup.ts";

const LAST_CP = 330;

describe("shouldRunRegimeCheckpointsAt", () => {
  const open = new Date("2026-10-07T13:30:00.000Z"); // 9:30 ET on a trading day

  it("runs during RTH", () => {
    assert.equal(
      shouldRunRegimeCheckpointsAt({
        isOpen: true,
        marketOpenUtc: open,
        now: new Date(open.getTime() + 60 * 60_000),
        lastRun: null,
        lastCheckpointMin: LAST_CP,
      }),
      true,
    );
  });

  it("skips pre-market / non-trading (no open)", () => {
    assert.equal(
      shouldRunRegimeCheckpointsAt({
        isOpen: false,
        marketOpenUtc: null,
        now: new Date("2026-10-07T12:00:00.000Z"),
        lastRun: null,
        lastCheckpointMin: LAST_CP,
      }),
      false,
    );
  });

  it("catch-up after final checkpoint when host was down all session", () => {
    const afterClose = new Date(open.getTime() + (LAST_CP + 60) * 60_000);
    assert.equal(
      shouldRunRegimeCheckpointsAt({
        isOpen: false,
        marketOpenUtc: open,
        now: afterClose,
        lastRun: null,
        lastCheckpointMin: LAST_CP,
      }),
      true,
    );
  });

  it("catch-up after close when last run was mid-session (missed final CPs)", () => {
    const midSession = new Date(open.getTime() + 120 * 60_000);
    const afterClose = new Date(open.getTime() + (LAST_CP + 30) * 60_000);
    assert.equal(
      shouldRunRegimeCheckpointsAt({
        isOpen: false,
        marketOpenUtc: open,
        now: afterClose,
        lastRun: midSession,
        lastCheckpointMin: LAST_CP,
      }),
      true,
    );
  });

  it("no hammer after a successful at/after-final-window run", () => {
    const afterFinal = new Date(open.getTime() + LAST_CP * 60_000 + 5_000);
    const later = new Date(open.getTime() + (LAST_CP + 90) * 60_000);
    assert.equal(
      shouldRunRegimeCheckpointsAt({
        isOpen: false,
        marketOpenUtc: open,
        now: later,
        lastRun: afterFinal,
        lastCheckpointMin: LAST_CP,
      }),
      false,
    );
  });
});
