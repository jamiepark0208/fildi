/**
 * Re-apply every peer_group_overrides row to ticker_registry + sole membership (keeps scoring_mode), then recompute
 * fund scores. Use after any re-seed. Usage: cd artifacts/api-server && pnpm exec tsx src/scripts/restore-peer-overrides.ts
 */
import { db, peerGroupOverrides } from "@workspace/db";
import { setPeerGroupOverride } from "../lib/peer-classifier.js";
import { computeAndPersistFundamentalScores } from "../lib/fundamentals-db.js";
import { getLatestRegime } from "../routes/regime.js";

const rows = await db.select().from(peerGroupOverrides);
for (const o of rows) await setPeerGroupOverride(o.ticker, o.groupId, o.note);
const n = (await computeAndPersistFundamentalScores(await getLatestRegime(), "peer_override")).length;
console.log(`restored ${rows.length} overrides; rescored ${n}`);
process.exit(0);
