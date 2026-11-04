// Run the indicator track-record grader once (the nightly job does this after the close).
// Usage: tsx src/scripts/grade-indicators.ts [--tickers SPY,QQQ]
import { runIndicatorGrading } from "../lib/indicator-grading-job.js";

async function main(): Promise<void> {
  const i = process.argv.indexOf("--tickers");
  const tickers = i > 0 ? process.argv[i + 1]?.split(",").map((t) => t.trim().toUpperCase()).filter(Boolean) : undefined;
  const r = await runIndicatorGrading({ tickers });
  console.log(JSON.stringify(r));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
