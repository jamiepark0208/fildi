// Idle-time JS chunk prefetch for lazy routes (enh/34 Wave B).
// Only prefetches the compiled chunk, never data — data prefetch is banned
// by the launch policy (no background options/macro API calls before the
// user visits a page). Import specifiers must match the React.lazy() calls
// in App.tsx so the browser/bundler dedupes the fetch.
type ChunkLoader = () => Promise<unknown>;

const ROUTE_CHUNKS: Record<string, ChunkLoader> = {
  watchlist: () => import("@/pages/watchlist"),
  "options-scanner": () => import("@/pages/options-scanner"),
};

const MAX_IDLE_PREFETCH = 2;
let idlePrefetchScheduled = false;

function hasSaveData(): boolean {
  const conn = (navigator as unknown as { connection?: { saveData?: boolean } }).connection;
  return conn?.saveData === true;
}

function runIdle(fn: () => void) {
  const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) {
    ric(fn, { timeout: 5000 });
  } else {
    setTimeout(fn, 2000);
  }
}

// Call once after the calling page's own data has finished loading.
export function idlePrefetchRouteChunks(routes: string[] = ["watchlist", "options-scanner"]) {
  if (idlePrefetchScheduled || hasSaveData()) return;
  idlePrefetchScheduled = true;
  runIdle(() => {
    for (const route of routes.slice(0, MAX_IDLE_PREFETCH)) {
      ROUTE_CHUNKS[route]?.().catch(() => {});
    }
  });
}

// Call on sidebar link hover to warm a single route's chunk immediately.
export function prefetchRouteChunk(route: string) {
  if (hasSaveData()) return;
  ROUTE_CHUNKS[route]?.().catch(() => {});
}
