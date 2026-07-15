// Rotates the two log surfaces that grow unbounded outside the DB:
//   1. /tmp/api-server.log — start.sh redirects both stdout/stderr here with `>>`
//      and never truncates it, so it grows forever across the life of the container.
//   2. logs/*.log — one file per manual/scheduled script run (backfills, nightly
//      enrichment), never cleaned up.
// Both run off the same heartbeat as the retention prune (scheduler.ts) rather than
// a separate cron — this container has no system-level logrotate.
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { logger } from "./logger.js";

const API_SERVER_LOG = "/tmp/api-server.log";
const MAX_LOG_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_GZ_BACKUPS = 3;

// start.sh opens this file with O_APPEND. Truncating the inode in place (rather than
// renaming it away) is safe for an O_APPEND writer — the next write just continues
// from the new EOF (0) — this is the same "copytruncate" strategy logrotate uses,
// and avoids needing to signal/restart the bash process holding the fd.
export function rotateApiServerLogIfNeeded(): void {
  try {
    const stat = fs.statSync(API_SERVER_LOG);
    if (stat.size <= MAX_LOG_BYTES) return;

    const backupPath = `${API_SERVER_LOG}.${Date.now()}.gz`;
    const content = fs.readFileSync(API_SERVER_LOG);
    fs.writeFileSync(backupPath, zlib.gzipSync(content));
    fs.truncateSync(API_SERVER_LOG, 0);

    logger.info({ backupPath, originalBytes: stat.size }, "log-rotation: rotated api-server.log");
    pruneOldBackups();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err }, "log-rotation: rotate failed");
    }
  }
}

function pruneOldBackups(): void {
  const dir = path.dirname(API_SERVER_LOG);
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith("api-server.log.") && f.endsWith(".gz"))
    .sort()
    .reverse(); // newest first (timestamp-prefixed names sort chronologically)

  for (const stale of backups.slice(MAX_GZ_BACKUPS)) {
    fs.unlinkSync(path.join(dir, stale));
  }
}

// Per-script log files (backfill-*, nightly-enrichment-*) are written once and never
// re-opened, so simple age-based deletion is enough — no O_APPEND concern like above.
const SCRIPT_LOG_DIR = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const SCRIPT_LOG_RETENTION_DAYS = 30;

export function pruneScriptLogs(): void {
  try {
    const cutoff = Date.now() - SCRIPT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const entries = fs.readdirSync(SCRIPT_LOG_DIR).filter(f => f.endsWith(".log"));
    let deleted = 0;
    for (const name of entries) {
      const full = path.join(SCRIPT_LOG_DIR, name);
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        deleted++;
      }
    }
    if (deleted > 0) logger.info({ deleted, dir: SCRIPT_LOG_DIR }, "log-rotation: pruned old script logs");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err }, "log-rotation: script log prune failed");
    }
  }
}
