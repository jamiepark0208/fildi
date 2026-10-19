/**
 * A125 — Video Lab / Reel inbox metadata (mp4s on disk later; Postgres metadata only).
 */
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
  ensured = true;
}

export async function listIdeas(limit = 50) {
  await ensure();
  return rowsOf<{
    id: number; topic: string; hook: string; outline: unknown; status: string;
    rating: number | null; notes: string | null; created_at: string;
  }>((await db.execute(sql`
    SELECT id, topic, hook, outline, status, rating, notes, created_at::text
    FROM video_lab_ideas ORDER BY created_at DESC LIMIT ${limit}`)) as SqlRows<never>);
}

export async function listVideos(limit = 50) {
  await ensure();
  return rowsOf<{
    id: number; title: string; hook: string | null; topic: string | null; status: string;
    path: string | null; idea_id: number | null; rating: number | null; notes: string | null; created_at: string;
  }>((await db.execute(sql`
    SELECT id, title, hook, topic, status, path, idea_id, rating, notes, created_at::text
    FROM video_lab_videos ORDER BY created_at DESC LIMIT ${limit}`)) as SqlRows<never>);
}

export async function insertIdea(input: {
  topic: string; hook: string; outline?: unknown[]; status?: string;
}): Promise<number> {
  await ensure();
  const rows = rowsOf<{ id: number }>((await db.execute(sql`
    INSERT INTO video_lab_ideas (topic, hook, outline, status)
    VALUES (
      ${input.topic}, ${input.hook},
      ${JSON.stringify(input.outline ?? [])}::jsonb,
      ${input.status ?? "backlog"}
    ) RETURNING id`)) as SqlRows<never>);
  return Number(rows[0]?.id);
}
