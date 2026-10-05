/**
 * Desk commentary ingest — labeled desk emails from Google Drive.
 *
 * Pipeline:
 *   Gmail (Apps Script, cloud) → Drive "TradeDash Briefs" (.json only)
 *   → this module → desk_commentaries (Postgres)
 *   → Live Daily News Haiku (ad-hoc) / soft regime + scorecard context (later)
 *
 * Laptop closed: Apps Script keeps saving to Drive. Mac ingest catches up on wake
 * when Drive for desktop syncs — no need to replay missed 15‑min polls.
 *
 * Soft context only: do NOT feed these into fund_score math.
 * Prefer .json sidecars; .eml still accepted for legacy files.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { desc, eq, gte, sql } from "drizzle-orm";
import { db, deskCommentaries, type DeskCommentary } from "@workspace/db";
import { logger } from "./logger.js";
import {
  KIND_LABEL,
  KIND_PRIORITY,
  parseEml,
  parseJsonSidecar,
  type DeskKind,
  type ParsedDeskItem,
} from "./desk-commentary-parse.js";

export * from "./desk-commentary-parse.js";

const DEFAULT_DRIVE_DIR =
  process.env["DESK_BRIEFS_DIR"] ??
  join(
    process.env["HOME"] ?? "",
    "Library/CloudStorage/GoogleDrive-parkjami@usc.edu/My Drive/TradeDash Briefs",
  );

export async function ensureDeskCommentariesTable(): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "desk_commentaries" (
      "id" serial PRIMARY KEY,
      "source" text NOT NULL DEFAULT 'factset_streetaccount',
      "kind" text NOT NULL,
      "gmail_message_id" text,
      "subject" text NOT NULL,
      "received_at" timestamp with time zone NOT NULL,
      "ingested_at" timestamp with time zone NOT NULL DEFAULT now(),
      "tickers_mentioned" jsonb NOT NULL DEFAULT '[]'::jsonb,
      "synopsis" text,
      "body_plain" text,
      "drive_file_name" text,
      "meta" jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await db.execute(sql`ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "from_address" text`);
  await db.execute(sql`ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "from_domain" text`);
  await db.execute(sql`ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "category" text`);
  await db.execute(sql`ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "article_published_at" timestamp with time zone`);
  await db.execute(sql`ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "noise_score" integer`);
  await db.execute(sql`ALTER TABLE "desk_commentaries" ADD COLUMN IF NOT EXISTS "parser_version" integer`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS "desk_commentaries_gmail_id_uidx"
      ON "desk_commentaries" ("gmail_message_id") WHERE "gmail_message_id" IS NOT NULL
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "desk_commentaries_received_idx"
      ON "desk_commentaries" ("received_at" DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "desk_commentaries_kind_day_idx"
      ON "desk_commentaries" ("kind", "received_at" DESC)
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "desk_commentaries_category_idx"
      ON "desk_commentaries" ("category", "received_at" DESC)
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS "desk_news_feedback" (
      "id" serial PRIMARY KEY,
      "created_at" timestamp with time zone NOT NULL DEFAULT now(),
      "session_date" text NOT NULL,
      "feedback_type" text NOT NULL,
      "bullet_text" text,
      "reason" text,
      "question" text,
      "meta" jsonb NOT NULL DEFAULT '{}'::jsonb
    )
  `);
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS "desk_news_feedback_session_idx"
      ON "desk_news_feedback" ("session_date", "created_at" DESC)
  `);
}

async function upsertParsed(item: ParsedDeskItem): Promise<"inserted" | "updated" | "skipped"> {
  if (!item.gmailMessageId) {
    const existing = await db
      .select({ id: deskCommentaries.id })
      .from(deskCommentaries)
      .where(eq(deskCommentaries.driveFileName, item.driveFileName))
      .limit(1);
    if (existing.length) return "skipped";
  }

  const row = {
    source: item.source,
    kind: String(item.kind),
    gmailMessageId: item.gmailMessageId,
    subject: item.subject,
    receivedAt: item.receivedAt,
    ingestedAt: new Date(),
    tickersMentioned: item.tickersMentioned,
    synopsis: item.synopsis,
    bodyPlain: item.bodyPlain,
    driveFileName: item.driveFileName,
    meta: item.meta,
    fromAddress: item.fromAddress ?? null,
    fromDomain: item.fromDomain ?? null,
    category: item.category ?? null,
    articlePublishedAt: item.articlePublishedAt ?? null,
    noiseScore: item.noiseScore ?? null,
    parserVersion: item.parserVersion ?? null,
  };

  if (item.gmailMessageId) {
    const existing = await db
      .select({ id: deskCommentaries.id })
      .from(deskCommentaries)
      .where(eq(deskCommentaries.gmailMessageId, item.gmailMessageId))
      .limit(1);
    if (existing[0]) {
      await db
        .update(deskCommentaries)
        .set({
          source: row.source,
          subject: row.subject,
          kind: row.kind,
          synopsis: row.synopsis,
          bodyPlain: row.bodyPlain,
          tickersMentioned: row.tickersMentioned,
          driveFileName: row.driveFileName,
          meta: row.meta,
          ingestedAt: row.ingestedAt,
          fromAddress: row.fromAddress,
          fromDomain: row.fromDomain,
          category: row.category,
          articlePublishedAt: row.articlePublishedAt,
          noiseScore: row.noiseScore,
          parserVersion: row.parserVersion,
        })
        .where(eq(deskCommentaries.id, existing[0].id));
      return "updated";
    }
  }

  await db.insert(deskCommentaries).values(row);
  return "inserted";
}

export interface IngestResult {
  dir: string;
  scanned: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: number;
}

export async function ingestDeskCommentaries(opts?: {
  dir?: string;
  sinceMs?: number;
  limit?: number;
  dryRun?: boolean;
}): Promise<IngestResult> {
  const dir = opts?.dir ?? DEFAULT_DRIVE_DIR;
  const result: IngestResult = { dir, scanned: 0, inserted: 0, updated: 0, skipped: 0, errors: 0 };

  if (!existsSync(dir)) {
    logger.warn({ dir }, "desk-commentary: Drive folder missing — is Drive for desktop syncing?");
    return result;
  }

  if (!opts?.dryRun) await ensureDeskCommentariesTable();

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".eml") || f.endsWith(".json"))
    .sort();

  const byStem = new Map<string, { json?: string; eml?: string }>();
  for (const f of files) {
    const stem = f.replace(/\.(eml|json)$/i, "");
    const entry = byStem.get(stem) ?? {};
    if (f.endsWith(".json")) entry.json = f;
    else entry.eml = f;
    byStem.set(stem, entry);
  }

  let processed = 0;
  for (const [, pair] of byStem) {
    if (opts?.limit != null && processed >= opts.limit) break;
    const file = pair.json ?? pair.eml;
    if (!file) continue;
    const full = join(dir, file);
    try {
      if (opts?.sinceMs != null) {
        const mtime = statSync(full).mtimeMs;
        if (mtime < opts.sinceMs) {
          result.skipped++;
          continue;
        }
      }
      result.scanned++;
      processed++;
      const raw = readFileSync(full, "utf8");
      const parsed = file.endsWith(".json")
        ? parseJsonSidecar(raw, file)
        : parseEml(raw, file);
      if (!parsed) {
        result.errors++;
        continue;
      }
      if (opts?.dryRun) {
        result.inserted++;
        continue;
      }
      const status = await upsertParsed(parsed);
      if (status === "inserted") result.inserted++;
      else if (status === "updated") result.updated++;
      else result.skipped++;
    } catch (err) {
      result.errors++;
      logger.warn({ err: String(err), file }, "desk-commentary: parse/ingest failed");
    }
  }

  return result;
}

export async function loadDeskPack(hours = 36, limit = 12): Promise<DeskCommentary[]> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(deskCommentaries)
    .where(gte(deskCommentaries.receivedAt, since))
    .orderBy(desc(deskCommentaries.receivedAt))
    .limit(40);

  const picked: DeskCommentary[] = [];
  const used = new Set<number>();
  for (const kind of KIND_PRIORITY) {
    if (kind === "other") continue;
    const hit = rows.find((r) => r.kind === kind && !used.has(r.id));
    if (hit) {
      picked.push(hit);
      used.add(hit.id);
    }
  }
  for (const r of rows) {
    if (picked.length >= limit) break;
    if (!used.has(r.id)) {
      picked.push(r);
      used.add(r.id);
    }
  }
  return picked.slice(0, limit);
}

export function formatDeskPackForBrief(rows: DeskCommentary[]): string {
  if (!rows.length) return "(No FactSet desk commentaries ingested for the last ~36h.)";
  return rows
    .map((r) => {
      const when = r.receivedAt.toISOString().replace("T", " ").slice(0, 16) + "Z";
      const label = KIND_LABEL[(r.kind as DeskKind)] ?? r.kind;
      const tickers = Array.isArray(r.tickersMentioned) && r.tickersMentioned.length
        ? `\nTickers: ${(r.tickersMentioned as string[]).slice(0, 12).join(", ")}`
        : "";
      const body = (r.synopsis || r.bodyPlain || "").slice(0, 700);
      return `[${label}] ${when}\n${r.subject}\n${body}${tickers}`;
    })
    .join("\n\n---\n\n");
}

/**
 * Soft context for future live/regime surfaces — narrative hints only.
 * Never mutate fund_score / technical scores from this.
 */
export async function getDeskSoftContext(hours = 24): Promise<{
  kindsPresent: string[];
  headlines: string[];
  tickersHot: string[];
  oilNote: string | null;
  politicsNote: string | null;
}> {
  const rows = await loadDeskPack(hours, 10);
  const tickers = new Map<string, number>();
  for (const r of rows) {
    for (const t of (r.tickersMentioned as string[]) ?? []) {
      tickers.set(t, (tickers.get(t) ?? 0) + 1);
    }
  }
  const oil = rows.find((r) => r.kind === "macro_oil");
  const politics = rows.find((r) => r.kind === "politics");
  return {
    kindsPresent: [...new Set(rows.map((r) => r.kind))],
    headlines: rows.map((r) => r.subject).slice(0, 8),
    tickersHot: [...tickers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t]) => t),
    oilNote: oil?.synopsis ?? null,
    politicsNote: politics?.synopsis ?? null,
  };
}

export function getDefaultBriefsDir(): string {
  return DEFAULT_DRIVE_DIR;
}
