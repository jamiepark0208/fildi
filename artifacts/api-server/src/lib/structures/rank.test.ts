import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { rationalApproxInvNorm } from "./legs.js";
import { atmIv } from "./rank.js";
import type { OptionsChainResult } from "../options.js";

// A205 D1/D2 (Codex implementation-delta-check 11-11): Ranker's own invNorm gave 0.0381 at p = 0.95 (truth 1.6449)
// and its ATM IV came from the first listed strike ≤ spot. Ranker now uses the one validated inverse normal.
describe("structures ranker distribution inputs", () => {
  it("inverse normal matches reference quantiles (< 1e-5)", () => {
    for (const [p, ref] of [[0.025, -1.959963984540054], [0.05, -1.6448536269514729], [0.5, 0], [0.95, 1.6448536269514722], [0.975, 1.959963984540054]]) {
      assert.ok(Math.abs(rationalApproxInvNorm(p) - ref) < 1e-5, `p=${p}: ${rationalApproxInvNorm(p)} vs ${ref}`);
    }
  });

  it("ATM IV comes from the strike nearest spot, not the farthest listed", () => {
    const chain = {
      spot: 100, expiry: "2026-12-18", daysToExpiry: 30,
      puts: [{ strike: 60, iv: 0.9 }, { strike: 95, iv: 0.32 }, { strike: 100, iv: 0.3 }],
      calls: [{ strike: 100, iv: 0.28 }, { strike: 105, iv: 0.27 }, { strike: 150, iv: 0.8 }],
    } as unknown as OptionsChainResult;
    assert.ok(Math.abs(atmIv(chain) - 0.29) < 1e-9, String(atmIv(chain)));
  });

  it("ATM IV skips zero/missing IV and falls back to 0.25 only with no chain", () => {
    const chain = { spot: 100, puts: [{ strike: 100, iv: 0 }, { strike: 98, iv: 0.4 }], calls: [] } as unknown as OptionsChainResult;
    assert.equal(atmIv(chain), 0.4);
    assert.equal(atmIv(null), 0.25);
  });
});
