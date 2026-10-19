/**
 * A125 — Video Lab / Reel inbox (mp4s under ~/.fildi/videos/; Postgres metadata).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, basename } from "node:path";
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

type SqlRows<T> = T[] | { rows?: T[] };
const rowsOf = <T,>(r: SqlRows<T>): T[] => (Array.isArray(r) ? r : r.rows ?? []);

let ensured = false;

async function ensure(): Promise<void> {
  if (ensured) return;
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS video_lab_ideas (
      id bigserial PRIMARY KEY,
      topic text NOT NULL,
      hook text NOT NULL,
      outline jsonb NOT NULL DEFAULT '[]'::jsonb,
      status text NOT NULL DEFAULT 'backlog',
      rating integer,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`
    ALTER TABLE video_lab_ideas ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'idea';
    ALTER TABLE video_lab_ideas ADD COLUMN IF NOT EXISTS source_url text;
    ALTER TABLE video_lab_ideas ADD COLUMN IF NOT EXISTS asks_ref text;
    CREATE TABLE IF NOT EXISTS video_lab_videos (
      id bigserial PRIMARY KEY,
      title text NOT NULL,
      hook text,
      topic text,
      status text NOT NULL DEFAULT 'draft',
      path text,
      idea_id bigint REFERENCES video_lab_ideas(id) ON DELETE SET NULL,
      rating integer,
      notes text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await db.execute(sql`
    ALTER TABLE video_lab_videos ADD COLUMN IF NOT EXISTS transcript text`);
  ensured = true;
}

export async function listIdeas(limit = 50) {
  await ensure();
  return rowsOf<{
    id: number; topic: string; hook: string; outline: unknown; status: string;
    rating: number | null; notes: string | null; created_at: string;
    source: string; source_url: string | null; asks_ref: string | null;
  }>((await db.execute(sql`
    SELECT id, topic, hook, outline, status, rating, notes, created_at::text,
           source, source_url, asks_ref
    FROM video_lab_ideas ORDER BY created_at DESC LIMIT ${limit}`)) as SqlRows<never>);
}

export async function listVideos(limit = 50) {
  await ensure();
  return rowsOf<{
    id: number; title: string; hook: string | null; topic: string | null; status: string;
    path: string | null; idea_id: number | null; rating: number | null; notes: string | null;
    created_at: string; transcript: string | null;
  }>((await db.execute(sql`
    SELECT id, title, hook, topic, status, path, idea_id, rating, notes, created_at::text, transcript
    FROM video_lab_videos ORDER BY created_at DESC LIMIT ${limit}`)) as SqlRows<never>);
}

export async function insertIdea(input: {
  topic: string; hook: string; outline?: unknown[]; status?: string;
  source?: string; sourceUrl?: string | null; asksRef?: string | null; notes?: string | null;
}): Promise<number> {
  await ensure();
  const rows = rowsOf<{ id: number }>((await db.execute(sql`
    INSERT INTO video_lab_ideas (topic, hook, outline, status, source, source_url, asks_ref, notes)
    VALUES (
      ${input.topic}, ${input.hook},
      ${JSON.stringify(input.outline ?? [])}::jsonb,
      ${input.status ?? "backlog"},
      ${input.source ?? "idea"},
      ${input.sourceUrl ?? null},
      ${input.asksRef ?? null},
      ${input.notes ?? null}
    ) RETURNING id`)) as SqlRows<never>);
  return Number(rows[0]?.id);
}

export function videoLabDir(): string {
  return process.env.FILDI_VIDEOS_DIR ?? join(homedir(), ".fildi", "videos");
}

export async function insertVideo(input: {
  title: string;
  hook?: string | null;
  topic?: string | null;
  status?: string;
  path?: string | null;
  ideaId?: number | null;
  notes?: string | null;
}): Promise<number> {
  await ensure();
  const rows = rowsOf<{ id: number }>((await db.execute(sql`
    INSERT INTO video_lab_videos (title, hook, topic, status, path, idea_id, notes)
    VALUES (
      ${input.title},
      ${input.hook ?? null},
      ${input.topic ?? null},
      ${input.status ?? "draft"},
      ${input.path ?? null},
      ${input.ideaId ?? null},
      ${input.notes ?? null}
    ) RETURNING id`)) as SqlRows<never>);
  return Number(rows[0]?.id);
}

const MAX_BYTES = 80 * 1024 * 1024; // 80MB shorts

/** Save mp4 bytes under ~/.fildi/videos and insert metadata row. */
export async function saveUploadedVideo(opts: {
  title: string;
  filename: string;
  bytes: Buffer;
  hook?: string | null;
  topic?: string | null;
  notes?: string | null;
}): Promise<{ id: number; path: string }> {
  if (opts.bytes.length === 0) throw new Error("empty file");
  if (opts.bytes.length > MAX_BYTES) throw new Error(`file too large (max ${MAX_BYTES} bytes)`);
  const safeName = basename(opts.filename).replace(/[^a-zA-Z0-9._-]/g, "_");
  if (!/\.(mp4|webm|mov)$/i.test(safeName)) throw new Error("only mp4/webm/mov allowed");
  const dir = videoLabDir();
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const dest = join(dir, `${stamp}-${randomBytes(4).toString("hex")}-${safeName}`);
  await writeFile(dest, opts.bytes);
  const id = await insertVideo({
    title: opts.title.trim() || safeName,
    hook: opts.hook ?? null,
    topic: opts.topic ?? null,
    path: dest,
    status: "uploaded",
    notes: opts.notes ?? null,
  });
  return { id, path: dest };
}
