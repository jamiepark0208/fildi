/**
 * A147 — soft-remove stale auto peer memberships for override tickers.
 * Usage: cd artifacts/api-server && pnpm exec tsx src/scripts/a147-cleanup-peers.ts
 */
import { cleanupOverrideDualMemberships } from "../lib/peer-classifier.js";

const r = await cleanupOverrideDualMemberships();
console.log(JSON.stringify(r, null, 2));
process.exit(0);
