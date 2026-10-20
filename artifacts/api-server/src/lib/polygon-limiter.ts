/**
 * Shared Polygon free-tier gate (A96 / A185): 5 calls/min → 12.5 s gap.
 * Cross-process: same file lock + stamp as scripts/watchlist_sync/polygon_gate.py
 * (`/tmp/fildi-logs/polygon.gate`). In-process chain still serializes Node callers.
 */
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { recordApiUsage } from "./api-usage.js";

const GAP_MS = 12_500;
const GATE_PATH = "/tmp/fildi-logs/polygon.gate";
const LOCK_PATH = `${GATE_PATH}.lock`;

let chain: Promise<void> = Promise.resolve();

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise((r) => setTimeout(r, ms));
}

/** Exclusive lock via O_EXCL lockfile (portable; matches Python flock intent). */
async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(GATE_PATH), { recursive: true });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const fh = await open(LOCK_PATH, "wx");
      try {
        return await fn();
      } finally {
        await fh.close().catch(() => undefined);
        await unlink(LOCK_PATH).catch(() => undefined);
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      await sleep(50);
    }
  }
  throw new Error("polygon gate: lock timeout");
}

/** Sleep until GAP_MS after the last cross-process call, then stamp now. */
async function crossProcessWait(): Promise<void> {
  await withFileLock(async () => {
    let last = 0;
    try {
      const raw = (await readFile(GATE_PATH, "utf8")).trim();
      last = Number(raw);
      if (!Number.isFinite(last)) last = 0;
    } catch {
      last = 0;
    }
    // Stamp is epoch seconds (same as polygon_gate.py).
    const pause = last * 1000 + GAP_MS - Date.now();
    if (pause > 0) await sleep(pause);
    await writeFile(GATE_PATH, String(Date.now() / 1000), "utf8");
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
