/**
 * Shared Polygon free-tier gate (A96 / A185): 5 calls/min → 12.5 s gap.
 * Cross-process: the same flock + stamp as scripts/watchlist_sync/polygon_gate.py
 * (`/tmp/fildi-logs/polygon.gate`). A separate .lock file raced Python and 429'd
 * when a study was running (A267). In-process chain still serializes Node callers.
 */
import { spawn } from "node:child_process";
import { recordApiUsage } from "./api-usage.js";

let chain: Promise<void> = Promise.resolve();

/**
 * Reserve the next slot (12.5s after the last reservation from ANY process), release the flock, then sleep outside it.
 * 10-26: sleeping while holding the flock let one process lose the (unfair) lock repeatedly → 120 s "lock timeout"
 * with only two callers → refresh-unused-feeds exit 1. The lock is now held for milliseconds; the stamp is the slot.
 */
function crossProcessWait(): Promise<void> {
  return new Promise((resolve, reject) => {
    let out = "";
    const py = spawn("python3", ["-c", `
import fcntl, time
from pathlib import Path
p = Path("/tmp/fildi-logs/polygon.gate")
p.parent.mkdir(parents=True, exist_ok=True)
with open(p, "a+") as f:
    fcntl.flock(f, fcntl.LOCK_EX)
    f.seek(0)
    raw = f.read().strip()
    try:
        last = float(raw or 0)
    except ValueError:
        last = 0.0
    now = time.time()
    slot = max(now, last + 12.5)
    f.seek(0)
    f.truncate()
    f.write(str(slot))
    f.flush()
print(slot - now)
`], { stdio: ["ignore", "pipe", "ignore"] });
    py.stdout.on("data", (d) => { out += String(d); });
    const timer = setTimeout(() => {
      py.kill();
      reject(new Error("polygon gate: lock timeout"));
    }, 30_000);
    py.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    py.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`polygon gate: python exit ${code}`));
      const pause = Number(out.trim());
      setTimeout(resolve, Number.isFinite(pause) && pause > 0 ? pause * 1000 : 0);
    });
  });
}

/** Serialize callers and enforce the free-tier gap. Counts every call via recordApiUsage. */
export async function polygonFetch(url: string, init?: RequestInit): Promise<Response> {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const prev = chain;
  chain = gate;
  await prev;
  try {
    await crossProcessWait();
    const res = await fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) });
    void recordApiUsage("polygon", 1).catch(() => {});
    if (res.status === 429) {
      void recordApiUsage("polygon_429", 1).catch(() => {});
    }
    return res;
  } finally {
    release();
  }
}

export function polygonApiKey(): string | undefined {
  return process.env.POLYGON_API_KEY || undefined;
}
