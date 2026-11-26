import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const probe = path.join(repoRoot, "research/common/reviews/2026-11-03-stockdb-repair-probe.cjs");

describe("merge-trusted price-ratio repair eligibility (A318)", () => {
  it("four currency/override faults + two USD controls (stockdb-repair-probe)", () => {
    execFileSync(process.execPath, [probe], { cwd: repoRoot, stdio: "pipe" });
  });
});