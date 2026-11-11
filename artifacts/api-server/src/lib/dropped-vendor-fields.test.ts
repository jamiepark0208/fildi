import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAPPED_FIELDS,
  STOCK_BOARD_CANDIDATE_FIELDS,
  decideVendorRawAction,
  mapFactSetHighlightRows,
  factsetActualColumn,
  mapFinnhubDropped,
  mapFmpDropped,
  vendorRawFromHttpUrl,
} from "./dropped-vendor-fields.js";

function fsRow(
  label: string,
  latest: string,
  meta: { valueType?: string | null; metric?: string; scale?: number | null },
) {
  return {
    cells: [label, latest],
    rowType: "STANDARD",
    rowMetadata: {
      valueType: { value: meta.valueType ?? "" },
      rowType: { value: "STANDARD" },
      metric: { value: meta.metric ?? "" },
      scale: { value: meta.scale ?? null },
    },
  };
}

describe("A266 mapped fields", () => {
  it("lists the 16 fields and the stock-board candidates", () => {
    assert.equal(MAPPED_FIELDS.length, 16);
    assert.ok(STOCK_BOARD_CANDIDATE_FIELDS.includes("tangibleBookValuePerShare"));
    assert.ok(STOCK_BOARD_CANDIDATE_FIELDS.includes("tier1CapitalRatio"));
  });

  it("matches the A263 FactSet JPM unit sample (RATIO is percent points)", () => {
    const jpm = mapFactSetHighlightRows([
      fsRow("Tier 1 Ratio", "15.226666", { valueType: "RATIO", metric: "RAT", scale: null }),
      fsRow("Total Capital Ratio", "16.6", { valueType: "RATIO", metric: "RAT", scale: null }),
      fsRow("Return on Tangible Equity (%)", "21.222467", { valueType: "PERCENTAGE", metric: "RAT" }),
      fsRow("Tangible Book Value Per Share", "116.53", { valueType: null, metric: "FIN", scale: 0 }),
      fsRow("Net Interest Income", "1000", { metric: "FIN", scale: 6 }),
      fsRow("Total Deposits", "2000", { metric: "FIN", scale: 6 }),
    ]);
    assert.equal(jpm.tier1CapitalRatio, 15.226666);
    assert.equal(jpm.totalCapitalRatio, 16.6);
    assert.ok(Math.abs((jpm.rotce ?? 0) - 21.222467 / 100) < 1e-12);
    assert.equal(jpm.tangibleBookValuePerShare, 116.53);
    assert.equal(jpm.netInterestIncome, 1_000_000_000);
    assert.equal(jpm.totalDeposits, 2_000_000_000);
  });

  it("matches the A263 FMP AAPL payout sample (already a decimal)", () => {
    const fmp = mapFmpDropped(
      {
        dividendPayoutRatio: 0.1376752075707526,
        interestCoverageRatio: 6.08,
        priceToFreeCashFlowRatio: 30.2,
      },
      {
        freeCashFlowYield: 0.031,
        incomeQuality: 1.12,
        stockBasedCompensationToRevenue: 0.045,
      },
    );
    assert.equal(fmp.payoutRatio, 0.1376752075707526);
    assert.equal(fmp.interestCoverage, 6.08);
    assert.equal(mapFmpDropped({ interestCoverageRatio: 0 }, {}).interestCoverage, undefined);
    assert.equal(fmp.priceToFcf, 30.2);
    assert.equal(fmp.fcfYield, 0.031);
    assert.equal(fmp.sbcToRevenue, 0.045);
    assert.equal(fmp.incomeQuality, 1.12);
  });

  it("maps Finnhub leftovers: ratios stay raw, growth and payout are percent", () => {
    const fh = mapFinnhubDropped({
      forwardPE: 28.4,
      pegTTM: 2.2,
      epsGrowth5Y: 12,
      revenueGrowth5Y: 8,
      payoutRatioTTM: 14.5,
      netInterestCoverageTTM: 9,
      ptbvAnnual: 35,
    });
    assert.equal(fh.forwardPe, 28.4);
    assert.equal(fh.pegTtm, 2.2);
    assert.equal(fh.epsGrowth5Y, 0.12);
    assert.equal(fh.revenueGrowth5Y, 0.08);
    assert.equal(fh.payoutRatio, 0.145);
    assert.equal(fh.interestCoverage, 9);
    assert.equal(fh.priceToTbv, 35);
  });

  it("stores a new row only when the hash changes", () => {
    assert.deepEqual(decideVendorRawAction(null, "2026-10-24", "a"), { op: "insert" });
    assert.deepEqual(
      decideVendorRawAction({ fetchedOn: "2026-10-23", payloadSha: "a" }, "2026-10-24", "a"),
      { op: "touch", fromDate: "2026-10-23" },
    );
    assert.deepEqual(
      decideVendorRawAction({ fetchedOn: "2026-10-24", payloadSha: "a" }, "2026-10-24", "a"),
      { op: "noop" },
    );
    assert.deepEqual(
      decideVendorRawAction({ fetchedOn: "2026-10-24", payloadSha: "a" }, "2026-10-24", "b"),
      { op: "replace" },
    );
    assert.deepEqual(
      decideVendorRawAction({ fetchedOn: "2026-10-20", payloadSha: "a" }, "2026-10-24", "b"),
      { op: "insert" },
    );
  });

  it("strips vendor secrets from the stored endpoint", () => {
    const id = vendorRawFromHttpUrl(
      "fmp",
      "https://financialmodelingprep.com/stable/ratios?symbol=AAPL&apikey=SECRET&limit=1",
    );
    assert.equal(id.source, "fmp");
    assert.equal(id.key, "AAPL");
    assert.equal(id.endpoint, "/stable/ratios?limit=1");
    assert.equal(id.endpoint.includes("SECRET"), false);
    const edgar = vendorRawFromHttpUrl(
      "edgar",
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json",
    );
    assert.equal(edgar.latestOnly, true);
    assert.equal(edgar.key, "CIK0000320193");
  });
});

describe("FactSet actual column (11-11: col 1 = in-progress FY estimates)", () => {
  const rows = [
    { rowType: "Header", cells: [null, "Dec '26", "Dec '25", "Dec '24"] },
    { cells: ["Net Income", "67274.21875", "56780.0", "50000.0"], rowMetadata: { metric: { value: "FIN" } } },
    { cells: ["Revenue", "190000.5", "170000.0", "160000.0"], rowMetadata: { metric: { value: "FIN" } } },
    { cells: ["Total Assets", "5046448.0", "4435143.0", "4000000.0"], rowMetadata: { metric: { value: "FIN" } } },
  ];
  it("skips the estimate year and reads the last reported FY", () => {
    const r = mapFactSetHighlightRows(rows as never, new Date("2026-11-11"));
    assert.equal(r.netIncome, 56780e6);
    assert.equal(r.totalAssets, 4435143e6);
  });
  it("a Sep FY 46 days old is not yet actuals (AAPL Sep '26 on 11-11)", () => {
    const end = factsetActualColumn([null, "Sep '26", "Sep '25"], new Date("2026-11-11"));
    assert.equal(end?.idx, 2);
  });
});
