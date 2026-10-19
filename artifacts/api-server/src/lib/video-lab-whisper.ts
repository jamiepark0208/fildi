/**
 * A125 — local Whisper transcript for Video Lab (optional binary).
 * Uses `whisper` CLI if on PATH; otherwise returns a clear unavailable status.
 */
import { spawn } from "node:child_process";
import { access, readFile, writeFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { logger } from "./logger.js";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

async function ensureTranscriptCol(): Promise<void> {
  await db.execute(sql`
    ALTER TABLE video_lab_videos ADD COLUMN IF NOT EXISTS transcript text`);
}

function whichWhisper(): Promise<string | null> {
  return new Promise((resolve) => {
    const p = spawn("which", ["whisper"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout?.on("data", (d) => { out += String(d); });
    p.on("close", (code) => resolve(code === 0 ? out.trim() || null : null));
    p.on("error", () => resolve(null));
  });
}

function runWhisper(bin: string, mediaPath: string, outDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      mediaPath,
      "--model", "base",
      "--output_format", "txt",
      "--output_dir", outDir,
      "--verbose", "False",
    ];
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    child.stderr?.on("data", (d) => { err += String(d); });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(err.trim() || `whisper exit ${code}`));
        return;
      }
      const stem = basename(mediaPath).replace(/\.[^.]+$/, "");
      const txtPath = join(outDir, `${stem}.txt`);
      try {
        const text = await readFile(txtPath, "utf8");
        resolve(text.trim());
      } catch (e) {
        reject(e);
      }
    });
  });
}

export type WhisperResult = {
  ok: boolean;
  videoId: number;
  transcript?: string;
  error?: string;
  engine?: string;
};

/** Transcribe a video_lab_videos row; persist transcript column. */
export async function transcribeVideoLab(videoId: number): Promise<WhisperResult> {
  await ensureTranscriptCol();
  const rows = rowsOf<{ id: number; path: string | null }>((await db.execute(sql`
    SELECT id, path FROM video_lab_videos WHERE id = ${videoId} LIMIT 1`)) as SqlRows<never>);
  const row = rows[0];
  if (!row?.path) {
    return { ok: false, videoId, error: "video missing or no path" };
  }
  try {
    await access(row.path, constants.R_OK);
  } catch {
    return { ok: false, videoId, error: `file not readable: ${row.path}` };
  }

  const bin = await whichWhisper();
  if (!bin) {
    return {
      ok: false,
      videoId,
      error: "whisper CLI not on PATH — brew install openai-whisper (or pip)",
      engine: "none",
    };
  }

  const outDir = join(dirname(row.path), ".whisper");
  await mkdir(outDir, { recursive: true });
  try {
    const transcript = await runWhisper(bin, row.path, outDir);
    await db.execute(sql`
      UPDATE video_lab_videos SET transcript = ${transcript} WHERE id = ${videoId}`);
    return { ok: true, videoId, transcript, engine: "whisper-cli" };
  } catch (err) {
    logger.warn({ err: String(err), videoId }, "video-lab-whisper: failed");
    return { ok: false, videoId, error: String(err), engine: "whisper-cli" };
  }
}
