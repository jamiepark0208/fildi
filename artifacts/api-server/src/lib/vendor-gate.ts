/**
 * Cross-process vendor budget (A303, runtime audit 10-28). The API server, the Python pipeline and scripts each paced
 * themselves, so together they could exceed a vendor's limit → 429 → retries. This gate is shared by every process on
 * the Mac: a slot file holds the next free time for the vendor; reserving takes a short exclusive lock, writes
 * slot = max(now, last + gap), releases, then sleeps outside the lock. Same protocol as
 * scripts/watchlist_sync/vendor_gate.py. Polygon keeps its own flock gate (polygon-limiter.ts, A267) — not changed.
 *
 * Lock = exclusive-create of `<vendor>.lock` (Node has no flock); a lock older than 2 s is from a dead process → removed.
 */
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GATE_DIR = process.env.FILDI_GATE_DIR ?? "/tmp/fildi-logs/gate";
const STALE_LOCK_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withLock<T>(vendor: string, fn: () => T): Promise<T> {
  mkdirSync(GATE_DIR, { recursive: true });
  const lock = join(GATE_DIR, `${vendor}.lock`);
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error(`vendor gate ${vendor}: lock timeout`);
      await sleep(5 + Math.random() * 10);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lock); } catch { /* already gone */ } }
}

/** Wait for this vendor's next cross-process slot (gap = http-client VENDOR_POLICY.crossGapMs). No-op without a gap. */
export async function acquireCrossProcessSlot(vendor: string, gapMs: number | undefined): Promise<void> {
  if (!gapMs) return;
  const slotFile = join(GATE_DIR, `${vendor}.slot`);
  const slot = await withLock(vendor, () => {
    let last = 0;
    try { last = Number(readFileSync(slotFile, "utf8").trim()) || 0; } catch { /* first call */ }
    const now = Date.now();
    const next = Math.max(now, last + gapMs);
    writeFileSync(slotFile, String(next));
    return next;
  });
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);
}
