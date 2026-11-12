import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assignStyleBucket, isFinancialLike } from "./fund-score-style.js";
import type { FundRowInput } from "./fund-score-types.js";

function row(over: Partial<FundRowInput>): FundRowInput {
  return {
    ticker: "X",
    netIncome: 1_000,
    totalRevenue: 5_000_000_000,
    peerGroupId: null,
    scoringMode: null,
    ...over,
  } as FundRowInput;
}

describe("isFinancialLike", () => {
  it("keeps banks, insurers, and REITs on the financial style", () => {
    assert.equal(isFinancialLike(row({ scoringMode: "financial", peerGroupId: "financials.banks" })), true);
    assert.equal(isFinancialLike(row({ scoringMode: "insurance", peerGroupId: "financials.insurance" })), true);
    assert.equal(isFinancialLike(row({ scoringMode: "reit", peerGroupId: "real_estate.reits_diversified" })), true);
    assert.equal(isFinancialLike(row({ scoringMode: null, peerGroupId: "financials.banks" })), true);
  });

  it("does not put payments, brokers, or health insurers on bank weights", () => {
    assert.equal(
      isFinancialLike(row({ scoringMode: "financial_mixed", peerGroupId: "fintech.digital_finance_payments" })),
      false,
    );
    assert.equal(
      isFinancialLike(row({ scoringMode: "standard", peerGroupId: "financials.payment_networks_credit" })),
      false,
    );
    assert.equal(
      isFinancialLike(row({ scoringMode: "healthcare_services", peerGroupId: "healthcare.health_insurance_managed_care" })),
      false,
    );
    assert.equal(
      isFinancialLike(row({ scoringMode: null, peerGroupId: "financials.payment_networks_credit" })),
      false,
    );
  });

  it("assigns HOOD-like rows by value and growth, not the bank bucket", () => {
    const hood = row({
      ticker: "HOOD",
      scoringMode: "financial_mixed",
      peerGroupId: "fintech.digital_finance_payments",
    });
    assert.equal(assignStyleBucket(hood, 0.5, 0.5), "blend");
    assert.equal(assignStyleBucket(row({ scoringMode: "financial", peerGroupId: "financials.banks" }), 0.2, 0.2), "financial");
  });
});
