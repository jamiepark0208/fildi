/**
 * Live Schwab edge-case simulation (uses real tokens + network).
 *
 *   cd artifacts/api-server && node --env-file=../../.env.local --import tsx src/scripts/simulate-schwab.ts
 */
import { getSchwabAuthStatus, getSchwabAccessToken } from "../lib/schwab-auth.js";
import {
  getSchwabOptionChains,
  getSchwabQuotes,
  getSchwabUsageStats,
  schwabChainCache,
} from "../lib/schwab-client.js";

async function main() {
  const cases: Array<{ name: string; ok: boolean; detail: string }> = [];

  const status = getSchwabAuthStatus();
  cases.push({
    name: "auth configured + tokens",
    ok: status.configured && status.hasTokens,
    detail: `configured=${status.configured} hasTokens=${status.hasTokens} daysLeft=${status.refreshDaysLeft?.toFixed(2)}`,
  });

  const token = await getSchwabAccessToken();
  cases.push({
    name: "access token obtainable",
    ok: Boolean(token),
    detail: token ? `len=${token.length}` : `err=${status.lastError}`,
  });

  // Empty symbols
  const empty = await getSchwabQuotes([]);
  cases.push({ name: "quotes empty → null", ok: empty === null, detail: String(empty) });

  // Invalid ticker
  const bad = await getSchwabQuotes(["NOTAREALTICKERZZZ"]);
  const badPrice = bad?.get("NOTAREALTICKERZZZ")?.price ?? null;
  cases.push({
    name: "quotes bogus ticker → null price (no throw)",
    ok: bad != null && badPrice == null,
    detail: `mapSize=${bad?.size} price=${badPrice}`,
  });

  // Valid batch
  const quotes = await getSchwabQuotes(["AAPL", "MSFT", "aapl"]); // dedupe case
  cases.push({
    name: "quotes batch + dedupe",
    ok: Boolean(quotes?.get("AAPL")?.price && quotes?.get("MSFT")?.price && quotes.size === 2),
    detail: `size=${quotes?.size} aapl=${quotes?.get("AAPL")?.price} msft=${quotes?.get("MSFT")?.price}`,
  });

  // Chain + coalescing
  schwabChainCache.clear();
  const t0 = Date.now();
  const [c1, c2] = await Promise.all([getSchwabOptionChains("AAPL"), getSchwabOptionChains("AAPL")]);
  const elapsed = Date.now() - t0;
  const usage = getSchwabUsageStats();
  cases.push({
    name: "chain coalescing (2 concurrent → 1 upstream)",
    ok: Boolean(c1?.length && c2?.length && c1[0]!.expiry === c2[0]!.expiry),
    detail: `expiries=${c1?.length} elapsedMs=${elapsed} req60s=${usage.requestsLast60s}`,
  });

  // Cache hit (no extra RPM)
  const before = usage.totalRequests;
  const c3 = await getSchwabOptionChains("AAPL");
  const after = getSchwabUsageStats().totalRequests;
  cases.push({
    name: "chain cache hit (no new request)",
    ok: Boolean(c3?.length) && after === before,
    detail: `before=${before} after=${after}`,
  });

  // Weird/empty chain symbol
  const junk = await getSchwabOptionChains("ZZZZZNOPE");
  cases.push({
    name: "chain junk ticker → null (Yahoo path would take over)",
    ok: junk === null,
    detail: String(junk),
  });

  console.log("\n── Schwab simulation ──");
  let failed = 0;
  for (const c of cases) {
    const mark = c.ok ? "PASS" : "FAIL";
    if (!c.ok) failed++;
    console.log(`${mark}  ${c.name} — ${c.detail}`);
  }
  console.log(`── ${cases.length - failed}/${cases.length} passed ──\n`);
  console.log("usage:", getSchwabUsageStats());
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
