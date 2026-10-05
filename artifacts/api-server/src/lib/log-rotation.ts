// Rotates / prunes log surfaces that grow unbounded outside the DB:
//   1. /tmp/api-server.log — start.sh redirects stdout/stderr with `>>`
//   2. logs/*.log — one file per manual/scheduled script run
//   3. /tmp/fildi-logs/* — maintain/stack-ensure/api/vite launchd + runtime logs
// Runs from retention prune (Mac Maintain primary; API scheduler backup).
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { logger } from "./logger.js";

const API_SERVER_LOG = "/tmp/api-server.log";
const MAX_LOG_BYTES = 20 * 1024 * 1024; // 20MB
const MAX_GZ_BACKUPS = 3;
const FILDI_LOG_DIR = "/tmp/fildi-logs";
const FILDI_LOG_RETENTION_DAYS = 14;
const FILDI_GZ_RETENTION_DAYS = 14;

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
    .reverse();

  for (const stale of backups.slice(MAX_GZ_BACKUPS)) {
    fs.unlinkSync(path.join(dir, stale));
  }
}

const SCRIPT_LOG_DIR = path.resolve(new URL(import.meta.url).pathname, "../../../../../logs");
const SCRIPT_LOG_RETENTION_DAYS = 30;

/** @returns number of script log files deleted */
export function pruneScriptLogs(): number {
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
    return deleted;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err }, "log-rotation: script log prune failed");
    }
    return 0;
  }
}

/**
 * Prune /tmp/fildi-logs: age-delete dated leftovers + gz; rotate live logs over 20MB.
 * Keeps status JSON and pid files.
 */
export function pruneFildiRuntimeLogs(): number {
  let deleted = 0;
  try {
    if (!fs.existsSync(FILDI_LOG_DIR)) return 0;
    const now = Date.now();
    const ageCutoff = now - FILDI_LOG_RETENTION_DAYS * 86_400_000;
    const gzCutoff = now - FILDI_GZ_RETENTION_DAYS * 86_400_000;
    const keepExact = new Set([
      "maintain-last.json",
      "model-snapshot-last.json",
      "api.pid",
      "vite.pid",
    ]);

    for (const name of fs.readdirSync(FILDI_LOG_DIR)) {
      const full = path.join(FILDI_LOG_DIR, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (keepExact.has(name)) continue;

      if (name.endsWith(".gz") && st.mtimeMs < gzCutoff) {
        fs.unlinkSync(full);
        deleted++;
        continue;
      }

      const isTextLog = /\.(log|out|err)$/.test(name);
      if (!isTextLog) continue;

      if (st.size > MAX_LOG_BYTES) {
        try {
          const backupPath = `${full}.${Date.now()}.gz`;
          fs.writeFileSync(backupPath, zlib.gzipSync(fs.readFileSync(full)));
          fs.truncateSync(full, 0);
          logger.info({ file: name, bytes: st.size }, "log-rotation: rotated fildi runtime log");
        } catch (err) {
          logger.warn({ err, file: name }, "log-rotation: fildi rotate failed");
        }
        continue;
      }

      if (st.mtimeMs < ageCutoff && st.size === 0) {
        fs.unlinkSync(full);
        deleted++;
      } else if (st.mtimeMs < ageCutoff && /\.\d{8}/.test(name)) {
        fs.unlinkSync(full);
        deleted++;
      }
    }
    if (deleted > 0) logger.info({ deleted, dir: FILDI_LOG_DIR }, "log-rotation: pruned fildi runtime logs");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.error({ err }, "log-rotation: fildi log prune failed");
    }
  }
  return deleted;
}
