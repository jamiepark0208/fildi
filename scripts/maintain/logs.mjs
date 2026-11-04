import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, createReadStream, createWriteStream } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { LOG_DIR, MAX_LOG_BYTES } from "./constants.mjs";

async function compressLog(path) {
  const gz = `${path}.${Date.now()}.gz`;
  await pipeline(createReadStream(path), createGzip(), createWriteStream(gz));
  unlinkSync(path);
  writeFileSync(path, ""); // keep empty live file for appenders
  return gz;
}

async function rotateLogs() {
  mkdirSync(LOG_DIR, { recursive: true });
  const rotated = [];
  for (const name of readdirSync(LOG_DIR)) {
    if (!name.endsWith(".log")) continue;
    const path = join(LOG_DIR, name);
    const st = statSync(path);
    if (st.size < MAX_LOG_BYTES) continue;
    const gz = await compressLog(path);
    rotated.push({ from: name, to: gz, bytes: st.size });
  }
  // prune gzipped logs older than 14 days
  const cutoff = Date.now() - 14 * 86400_000;
  let pruned = 0;
  for (const name of readdirSync(LOG_DIR)) {
    if (!name.endsWith(".gz")) continue;
    const path = join(LOG_DIR, name);
    if (statSync(path).mtimeMs < cutoff) {
      unlinkSync(path);
      pruned++;
    }
  }
  return { rotated, pruned };
}

export { rotateLogs };
