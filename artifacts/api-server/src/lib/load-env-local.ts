/**
 * Belt-and-suspenders: ensure repo-root .env.local keys are present in process.env.
 * Does not override vars already set (dev-spawn / LaunchAgent win).
 * Fixes tsx-watch orphan children that lost SCHWAB_* after a stale watcher reclaimed :8080.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CRITICAL = [
  "SCHWAB_CLIENT_ID",
  "SCHWAB_SECRET",
  "SCHWAB_APP_KEY",
  "SCHWAB_APP_SECRET",
  "DATABASE_URL",
  "SESSION_SECRET",
  "FACTSET_PROXY_URL",
  "FACTSET_PROXY_SECRET",
  "FMP_API_KEY",
  "DISABLE_SCHEDULER_ENRICHMENT",
] as const;

export function loadEnvLocal(): { path: string | null; filled: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  // artifacts/api-server/src/lib → repo root
  const candidates = [
    resolve(here, "../../../../.env.local"),
    resolve(process.cwd(), "../../.env.local"),
    resolve(process.cwd(), ".env.local"),
  ];
  const path = candidates.find((p) => existsSync(p)) ?? null;
  if (!path) return { path: null, filled: [] };

  const filled: string[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (!k) continue;
    // Only fill missing — never clobber spawn/LaunchAgent env.
    // Prefer filling critical keys; also fill any other missing key from .env.local
    // so FACTSET/FMP/etc. survive orphan-watcher reclaim.
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
      if ((CRITICAL as readonly string[]).includes(k) || k.startsWith("SCHWAB_")) {
        filled.push(k);
      }
    }
  }
  return { path, filled };
}
