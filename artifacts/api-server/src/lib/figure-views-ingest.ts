/**
 * A85 — free-source ingest for figure_views.
 * Phase 1 pipe: Fed speeches RSS → registry figures (Powell/Waller/Bowman).
 * No LLM extraction yet — claim = speech title; direction null until scored extract.
 */
import { sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { insertView, FIGURE_REGISTRY } from "./figure-views.js";
import { logger } from "./logger.js";

const FED_SPEECHES_RSS = "https://www.federalreserve.gov/feeds/speeches.xml";
const FED_PRESS_RSS = "https://www.federalreserve.gov/feeds/press_all.xml";
const FED_TESTIMONY_RSS = "https://www.federalreserve.gov/feeds/Testimony.xml";

/** Last-name / slug → figure_id (only registry Fed officials). */
const FED_SPEAKER_MAP: Record<string, string> = {
  powell: "fed-powell",
  waller: "fed-waller",
  bowman: "fed-bowman",
};

export function mapFedSpeaker(title: string): string | null {
  const head = title.split(",")[0]?.trim().toLowerCase() ?? "";
  // "Michelle W. Bowman" or "Bowman" or "Governor Christopher J. Waller"
  for (const [key, id] of Object.entries(FED_SPEAKER_MAP)) {
    if (head === key || head.endsWith(` ${key}`) || head.startsWith(`${key} `)) return id;
  }
  // URL slug fallback handled by caller
  return null;
}

export function mapFedSpeakerFromUrl(url: string): string | null {
  const m = /\/(?:speech|testimony)\/([a-z]+)20\d{6}/i.exec(url);
  if (!m) return null;
  return FED_SPEAKER_MAP[m[1]!.toLowerCase()] ?? null;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&uuml;/g, "ü")
    .trim();
}

export type FedSpeechItem = {
  title: string;
  link: string;
  pubDate: string;
  description: string;
};

export function parseFedSpeechesRss(xml: string): FedSpeechItem[] {
  const items: FedSpeechItem[] = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1]!;
    const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "");
    const link = decodeXml(
      (/<link>([\s\S]*?)<\/link>/.exec(block)?.[1]
        ?? /<guid[^>]*>([\s\S]*?)<\/guid>/.exec(block)?.[1]
        ?? "").trim(),
    );
    const pubDate = decodeXml(/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block)?.[1] ?? "");
    const description = decodeXml(/<description>([\s\S]*?)<\/description>/.exec(block)?.[1] ?? "");
    if (title && link) items.push({ title, link, pubDate, description });
  }
  return items;
}

function asOfFromPub(pubDate: string): string {
  const d = new Date(pubDate);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

async function sourceExists(url: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM figure_views WHERE source_url = ${url} LIMIT 1`);
  const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
  return list.length > 0;
}

export type VoicesIngestResult = {
  fetched: number;
  inserted: number;
  skipped: number;
  unknownSpeaker: number;
  errors: number;
};

/** Fetch Fed speeches RSS and insert new views for known registry figures. */
export async function ingestFedSpeechesOnly(opts?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<VoicesIngestResult> {
  const limit = opts?.limit ?? 40;
  const result: VoicesIngestResult = {
    fetched: 0, inserted: 0, skipped: 0, unknownSpeaker: 0, errors: 0,
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let xml: string;
  try {
    const res = await fetch(FED_SPEECHES_RSS, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0 (A85 voices ingest)" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Fed RSS HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    clearTimeout(timer);
    logger.warn({ err: String(err) }, "figure-views-ingest: Fed RSS fetch failed");
    result.errors++;
    return result;
  }

  const items = parseFedSpeechesRss(xml).slice(0, limit);
  result.fetched = items.length;
  const known = new Set(FIGURE_REGISTRY.map((f) => f.id));

  for (const item of items) {
    const figureId = mapFedSpeaker(item.title) ?? mapFedSpeakerFromUrl(item.link);
    if (!figureId || !known.has(figureId)) {
      result.unknownSpeaker++;
      continue;
    }
    try {
      if (await sourceExists(item.link)) {
        result.skipped++;
        continue;
      }
      const claim = item.description
        ? `${item.title.replace(/^[^,]+,\s*/, "")} — ${item.description}`
        : item.title;
      if (opts?.dryRun) {
        result.inserted++;
        continue;
      }
      await insertView({
        figureId,
        asOf: asOfFromPub(item.pubDate),
        claim: claim.slice(0, 500),
        asset: "rates",
        direction: null,
        horizon: null,
        confidence: null,
        sourceUrl: item.link,
      });
      result.inserted++;
    } catch (err) {
      result.errors++;
      logger.warn({ err: String(err), link: item.link }, "figure-views-ingest: insert failed");
    }
  }
  return result;
}

/** Monetary-policy press (FOMC minutes/statements) -> fed-powell. */
export async function ingestFedMonetaryPress(opts?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<VoicesIngestResult> {
  const limit = opts?.limit ?? 20;
  const result: VoicesIngestResult = {
    fetched: 0, inserted: 0, skipped: 0, unknownSpeaker: 0, errors: 0,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let xml: string;
  try {
    const res = await fetch(FED_PRESS_RSS, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0 (A85 voices ingest)" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Fed press RSS HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    clearTimeout(timer);
    logger.warn({ err: String(err) }, "figure-views-ingest: Fed press RSS failed");
    result.errors++;
    return result;
  }
  const items = parseFedSpeechesRss(xml).filter((it) => {
    const t = `${it.title} ${it.description}`.toLowerCase();
    return t.includes("federal open market") || t.includes("fomc") || t.includes("monetary policy");
  }).slice(0, limit);
  result.fetched = items.length;
  for (const item of items) {
    try {
      if (await sourceExists(item.link)) { result.skipped++; continue; }
      if (opts?.dryRun) { result.inserted++; continue; }
      await insertView({
        figureId: "fed-powell",
        asOf: asOfFromPub(item.pubDate),
        claim: item.title.slice(0, 500),
        asset: "rates",
        direction: null,
        horizon: null,
        confidence: null,
        sourceUrl: item.link,
      });
      result.inserted++;
    } catch (err) {
      result.errors++;
      logger.warn({ err: String(err), link: item.link }, "figure-views-ingest: press insert failed");
    }
  }
  return result;
}

/** Fed congressional testimony RSS → registry Fed figures. */
export async function ingestFedTestimony(opts?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<VoicesIngestResult> {
  const limit = opts?.limit ?? 20;
  const result: VoicesIngestResult = {
    fetched: 0, inserted: 0, skipped: 0, unknownSpeaker: 0, errors: 0,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  let xml: string;
  try {
    const res = await fetch(FED_TESTIMONY_RSS, {
      signal: controller.signal,
      headers: { "User-Agent": "TradeDash/1.0 (A85 voices ingest)" },
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Fed testimony RSS HTTP ${res.status}`);
    xml = await res.text();
  } catch (err) {
    clearTimeout(timer);
    logger.warn({ err: String(err) }, "figure-views-ingest: Fed testimony RSS failed");
    result.errors++;
    return result;
  }
  const items = parseFedSpeechesRss(xml).slice(0, limit);
  result.fetched = items.length;
  for (const item of items) {
    try {
      const figureId = mapFedSpeaker(item.title) ?? mapFedSpeakerFromUrl(item.link);
      if (!figureId) { result.unknownSpeaker++; continue; }
      if (await sourceExists(item.link)) { result.skipped++; continue; }
      if (opts?.dryRun) { result.inserted++; continue; }
      await insertView({
        figureId,
        asOf: asOfFromPub(item.pubDate),
        claim: item.title.slice(0, 500),
        asset: "rates",
        direction: null,
        horizon: null,
        confidence: null,
        sourceUrl: item.link,
      });
      result.inserted++;
    } catch (err) {
      result.errors++;
      logger.warn({ err: String(err), link: item.link }, "figure-views-ingest: testimony insert failed");
    }
  }
  return result;
}

function mergeResults(a: VoicesIngestResult, b: VoicesIngestResult): VoicesIngestResult {
  return {
    fetched: a.fetched + b.fetched,
    inserted: a.inserted + b.inserted,
    skipped: a.skipped + b.skipped,
    unknownSpeaker: a.unknownSpeaker + b.unknownSpeaker,
    errors: a.errors + b.errors,
  };
}

/** Match registry figure when full name (or distinctive last name) appears in text. */
export function matchFigureFromText(text: string): string | null {
  const t = text.toLowerCase();
  // Longer / more specific names first
  const ordered = [...FIGURE_REGISTRY].sort((a, b) => b.name.length - a.name.length);
  for (const fig of ordered) {
    if (t.includes(fig.name.toLowerCase())) return fig.id;
  }
  // Distinctive last-name fallback (avoid short/ambiguous: Lee, Wu, Ives)
  const lastOnly: Array<[string, string]> = [
    ["tudor jones", "ptj"],
    ["yardeni", "yardeni"],
    ["cabana", "cabana"],
    ["el-erian", "el-erian"],
    ["el erian", "el-erian"],
    ["jeremy siegel", "siegel"],
    ["gundlach", "gundlach"],
    ["druckenmiller", "druckenmiller"],
    ["powell", "fed-powell"],
    ["waller", "fed-waller"],
    ["bowman", "fed-bowman"],
  ];
  for (const [needle, id] of lastOnly) {
    if (t.includes(needle)) return id;
  }
  return null;
}

const NEWS_FEEDS: Array<{ url: string; asset: string }> = [
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/Business.xml", asset: "equity" },
  { url: "https://seekingalpha.com/feed.xml", asset: "equity" },
];

/** Free news RSS → figure_views when title/description names a registry figure. */
export async function ingestKeywordNewsFeeds(opts?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<VoicesIngestResult> {
  const perFeed = opts?.limit ?? 30;
  const result: VoicesIngestResult = {
    fetched: 0, inserted: 0, skipped: 0, unknownSpeaker: 0, errors: 0,
  };
  for (const feed of NEWS_FEEDS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let xml: string;
    try {
      const res = await fetch(feed.url, {
        signal: controller.signal,
        headers: { "User-Agent": "TradeDash/1.0 (A85 voices ingest)" },
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`news RSS HTTP ${res.status}`);
      xml = await res.text();
    } catch (err) {
      clearTimeout(timer);
      logger.warn({ err: String(err), url: feed.url }, "figure-views-ingest: news RSS failed");
      result.errors++;
      continue;
    }
    const items = parseFedSpeechesRss(xml).slice(0, perFeed);
    result.fetched += items.length;
    for (const item of items) {
      try {
        const figureId = matchFigureFromText(`${item.title} ${item.description}`);
        if (!figureId) { result.unknownSpeaker++; continue; }
        if (await sourceExists(item.link)) { result.skipped++; continue; }
        if (opts?.dryRun) { result.inserted++; continue; }
        await insertView({
          figureId,
          asOf: asOfFromPub(item.pubDate),
          claim: item.title.slice(0, 500),
          asset: feed.asset,
          direction: null,
          horizon: null,
          confidence: null,
          sourceUrl: item.link,
        });
        result.inserted++;
      } catch (err) {
        result.errors++;
        logger.warn({ err: String(err), link: item.link }, "figure-views-ingest: news insert failed");
      }
    }
  }
  return result;
}

/** Speeches + FOMC/monetary press + testimony + keyword news. */
export async function ingestFedSpeeches(opts?: {
  limit?: number;
  dryRun?: boolean;
}): Promise<VoicesIngestResult> {
  const a = await ingestFedSpeechesOnly(opts);
  const b = await ingestFedMonetaryPress(opts);
  const c = await ingestFedTestimony(opts);
  const d = await ingestKeywordNewsFeeds(opts);
  return mergeResults(mergeResults(mergeResults(a, b), c), d);
}

