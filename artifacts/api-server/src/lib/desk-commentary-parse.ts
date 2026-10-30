/**
 * Pure FactSet desk email parsers (no DB). Used by ingest + unit tests.
 */
import { basename } from "node:path";
import { normalizeDeskPayload } from "./desk-commentary-normalize.js";

/** Whole email body (D0 10-30: the old 12,000 cut dropped the back half of 47 % of emails). The ceiling only guards
 *  against a malformed file; real briefs are 10–60k. Readers that feed an LLM cap their own input. */
export const MAX_BODY_CHARS = 200_000;

export type DeskKind =
  | "us_overnight"
  | "us_market_recap"
  | "politics"
  | "sector_consumer"
  | "sector_energy"
  | "sector_technology"
  | "macro_oil"
  | "us_monthly_recap"
  | "us_quarterly_recap"
  | "us_week_ahead"
  | "morning_watchlist"
  | "seekingalpha"
  | "lseg"
  | "other";

export interface ParsedDeskItem {
  source: string;
  kind: DeskKind | string;
  gmailMessageId: string | null;
  subject: string;
  receivedAt: Date;
  tickersMentioned: string[];
  synopsis: string;
  bodyPlain: string;
  driveFileName: string;
  meta: Record<string, unknown>;
  /** v2 normalize fields (also mirrored into columns on upsert) */
  fromAddress?: string | null;
  fromDomain?: string | null;
  category?: string | null;
  articlePublishedAt?: Date | null;
  noiseScore?: number | null;
  parserVersion?: number | null;
}

export const KIND_PRIORITY: DeskKind[] = [
  "us_overnight",
  "us_market_recap",
  "macro_oil",
  "politics",
  "sector_technology",
  "sector_energy",
  "sector_consumer",
  "us_week_ahead",
  "morning_watchlist",
  "us_monthly_recap",
  "us_quarterly_recap",
  "other",
];

export const KIND_LABEL: Record<DeskKind, string> = {
  us_overnight: "US Overnight",
  us_market_recap: "US Market Recap",
  politics: "Politics of the Market",
  sector_consumer: "Sector — Consumer",
  sector_energy: "Sector — Energy",
  sector_technology: "Sector — Technology",
  macro_oil: "Macro — Oil",
  us_monthly_recap: "US Monthly Recap",
  us_quarterly_recap: "US Quarterly Recap",
  us_week_ahead: "US Week Ahead",
  morning_watchlist: "Morning Watchlist",
  seekingalpha: "Seeking Alpha",
  lseg: "LSEG / Refinitiv",
  other: "Other desk note",
};

export function classifyKind(subject: string, source?: string): DeskKind {
  const s = subject.toLowerCase();
  const src = (source ?? "").toLowerCase();
  if (src === "seekingalpha" || src.includes("seeking")) return "seekingalpha";
  if (src === "lseg" || src.includes("refinitiv")) return "lseg";
  if (s.includes("overnight")) return "us_overnight";
  if (s.includes("market recap")) return "us_market_recap";
  if (s.includes("week ahead")) return "us_week_ahead";
  if (s.includes("politics")) return "politics";
  if (s.includes("sector") && s.includes("consumer")) return "sector_consumer";
  if (s.includes("sector") && s.includes("energy")) return "sector_energy";
  if (s.includes("sector") && (s.includes("techno") || s.includes("tech"))) return "sector_technology";
  if (s.includes("oil")) return "macro_oil";
  if (s.includes("monthly")) return "us_monthly_recap";
  if (s.includes("quarterly")) return "us_quarterly_recap";
  if (s.includes("watchlist")) return "morning_watchlist";
  return "other";
}

/** Parse `yyyy-MM-dd_HHmm-[{account}-]{source}-{gmailId}-{subj}.ext` */
export function parseDriveFileName(name: string): {
  day: string | null;
  hhmm: string | null;
  account: string | null;
  source: string | null;
  gmailId: string | null;
  subjectSlug: string | null;
} {
  const base = name.replace(/\.(eml|json)$/i, "");
  // New: …-usc-factset-{gmailId}-subj  or  …-personal-desk-{gmailId}-subj
  const withAcct = base.match(
    /^(\d{4}-\d{2}-\d{2})_(\d{4})-(usc|personal|[a-z0-9]{2,16})-([a-z0-9_]+)-([0-9a-f]{10,})-(.+)$/i,
  );
  if (withAcct) {
    return {
      day: withAcct[1]!,
      hhmm: withAcct[2]!,
      account: withAcct[3]!.toLowerCase(),
      source: withAcct[4]!.toLowerCase(),
      gmailId: withAcct[5]!.toLowerCase(),
      subjectSlug: withAcct[6]!,
    };
  }
  // Legacy dual-write / pre-account: …-factset-{gmailId}-subj
  const m = base.match(/^(\d{4}-\d{2}-\d{2})_(\d{4})-([a-z0-9_]+)-([0-9a-f]{10,})-(.+)$/i);
  if (m) {
    return {
      day: m[1]!,
      hhmm: m[2]!,
      account: null,
      source: m[3]!.toLowerCase(),
      gmailId: m[4]!.toLowerCase(),
      subjectSlug: m[5]!,
    };
  }
  const legacy = base.match(/^(\d{4}-\d{2}-\d{2})_(\d{4})-([a-z0-9_]+)-(.+)$/i);
  if (legacy) {
    return {
      day: legacy[1]!,
      hhmm: legacy[2]!,
      account: null,
      source: legacy[3]!.toLowerCase(),
      gmailId: null,
      subjectSlug: legacy[4]!,
    };
  }
  return { day: null, hhmm: null, account: null, source: null, gmailId: null, subjectSlug: null };
}

export function gmailIdFromFileName(name: string): string | null {
  return parseDriveFileName(name).gmailId;
}

export function sourceFromFileName(name: string): string | null {
  const parsed = parseDriveFileName(name);
  if (!parsed.source) return null;
  if (parsed.source === "factset") return "factset_streetaccount";
  return parsed.source;
}

/** Prefer Gmail hex id over SES Message-ID for stable dedupe. */
export function preferredMessageKey(gmailId: string | null, messageId: string | null): string | null {
  if (gmailId && /^[0-9a-f]{10,}$/i.test(gmailId)) return gmailId.toLowerCase();
  if (messageId) return messageId.replace(/^<|>$/g, "");
  return gmailId;
}

export function extractSynopsis(plain: string): string {
  const m = plain.match(/Synopsis:([\s\S]{0,900}?)(?:Notable|Market Summary|Commodities|Intraday|Subjects:|$)/i);
  if (m?.[1]) return m[1].replace(/\s+/g, " ").trim().slice(0, 600);
  const bullets = plain.match(/(?:Notable stories|Notable events|Headline:)([\s\S]{0,900}?)(?:Subjects:|Please do not reply|DISCLAIMER|$)/i);
  if (bullets?.[1]) return bullets[1].replace(/\s+/g, " ").trim().slice(0, 600);
  return plain.replace(/\s+/g, " ").trim().slice(0, 400);
}

export function extractTickers(text: string): string[] {
  const out = new Set<string>();
  const stop = new Set([
    "US", "SA", "AM", "PM", "ET", "EST", "EDT", "PT", "PST", "PDT", "UTC",
    "CEO", "CFO", "COO", "IPO", "ETF", "GDP", "CPI", "PPI", "FED", "FOMC",
    "FDA", "SEC", "AI", "EV", "UK", "EU", "NY", "DC", "Q1", "Q2", "Q3", "Q4",
    "YOY", "QOQ", "MOM", "ATM", "OTM", "ITM", "DTE", "IV", "PE", "EPS",
  ]);
  const re = /\b([A-Z]{1,5})(?:\s*\(|\s+--|\/)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = m[1]!;
    if (!stop.has(t)) out.add(t);
  }
  return [...out].slice(0, 40);
}

function decodeQuotedPrintable(input: string): string {
  return input
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function headerValue(raw: string, name: string): string | null {
  const re = new RegExp(`^${name}:\\s*(.+)$`, "im");
  const m = raw.match(re);
  if (!m?.[1]) return null;
  let val = m[1];
  const start = m.index! + m[0].length;
  const rest = raw.slice(start);
  const cont = rest.match(/^(?:\r?\n[ \t].+)+/);
  if (cont) val += cont[0].replace(/\r?\n[ \t]/g, " ");
  return val.trim();
}

export function parseEml(raw: string, driveFileName: string): ParsedDeskItem {
  const parsed = parseDriveFileName(driveFileName);
  const src = sourceFromFileName(driveFileName);
  const subject = headerValue(raw, "Subject") ?? basename(driveFileName, ".eml");
  const dateHdr = headerValue(raw, "Date");
  const receivedAt = dateHdr ? new Date(dateHdr) : new Date();
  const messageId = headerValue(raw, "Message-ID")?.replace(/^<|>$/g, "") ?? null;
  const gmailFromName = parsed.gmailId;

  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  let plain = "";
  if (boundaryMatch) {
    const parts = raw.split(`--${boundaryMatch[1]}`);
    for (const part of parts) {
      if (!/Content-Type:\s*text\/plain/i.test(part)) continue;
      const bodyIdx = part.search(/\r?\n\r?\n/);
      if (bodyIdx < 0) continue;
      let body = part.slice(bodyIdx).replace(/^\r?\n\r?\n/, "");
      if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(part)) {
        body = decodeQuotedPrintable(body);
      } else if (/Content-Transfer-Encoding:\s*base64/i.test(part)) {
        try {
          body = Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
        } catch { /* keep */ }
      }
      plain = body;
      break;
    }
  }
  if (!plain) {
    const bodyIdx = raw.search(/\r?\n\r?\n/);
    plain = bodyIdx >= 0 ? raw.slice(bodyIdx + 2) : raw;
  }

  plain = plain
    .replace(/\r\n/g, "\n")
    .replace(/Please do not reply[\s\S]*$/i, "")
    .replace(/DISCLAIMER:[\s\S]*$/i, "")
    .trim();

  const kind = classifyKind(subject, src ?? undefined);
  return {
    source: src ?? "factset_streetaccount",
    kind,
    gmailMessageId: preferredMessageKey(gmailFromName, messageId),
    subject,
    receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
    tickersMentioned: extractTickers(plain + " " + subject),
    synopsis: extractSynopsis(plain),
    bodyPlain: plain.slice(0, MAX_BODY_CHARS),
    driveFileName,
    meta: { messageId, parser: "eml", fileSource: parsed.source },
  };
}

export function parseJsonSidecar(raw: string, driveFileName: string): ParsedDeskItem | null {
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const parsed = parseDriveFileName(driveFileName);
    const srcHint =
      (j.source ? String(j.source) : null) ??
      sourceFromFileName(driveFileName) ??
      "factset_streetaccount";
    const subject = String(j.subject ?? "");
    const receivedAt = new Date(String(j.receivedAt ?? Date.now()));
    const bodyPlain = String(j.bodyPlain ?? "").slice(0, MAX_BODY_CHARS);
    const gmailFromJson = j.gmailMessageId ? String(j.gmailMessageId) : null;
    const norm = normalizeDeskPayload({
      source: srcHint,
      kind: j.kind ? String(j.kind) : classifyKind(subject, srcHint),
      subject,
      from: j.from ? String(j.from) : null,
      fromDomain: j.fromDomain ? String(j.fromDomain) : null,
      receivedAt,
      synopsis: j.synopsis ? String(j.synopsis) : null,
      bodyPlain,
      bodyHtml: j.bodyHtml ? String(j.bodyHtml).slice(0, 20000) : null,
      tickersMentioned: j.tickersMentioned,
      outboundLinks: Array.isArray(j.outboundLinks) ? j.outboundLinks as never : null,
      parserVersion: typeof j.parserVersion === "number" ? j.parserVersion : 2,
    });
    return {
      source: norm.sourceId,
      kind: norm.kind,
      gmailMessageId: preferredMessageKey(parsed.gmailId ?? gmailFromJson, null),
      subject,
      receivedAt: Number.isNaN(receivedAt.getTime()) ? new Date() : receivedAt,
      tickersMentioned: norm.tickersMentioned,
      synopsis: norm.synopsis,
      bodyPlain: cleanBodyForStore(bodyPlain),
      driveFileName,
      fromAddress: norm.fromAddress,
      fromDomain: norm.fromDomain,
      category: norm.category,
      articlePublishedAt: norm.articlePublishedAt,
      noiseScore: norm.noiseScore,
      parserVersion: norm.parserVersion,
      meta: {
        parser: "json",
        parserVersion: norm.parserVersion,
        ingestedAtSrc: j.ingestedAt,
        account: j.account ?? parsed.account ?? null,
        script: j.script ?? null,
        category: norm.category,
        noiseScore: norm.noiseScore,
        noiseReasons: norm.noiseReasons,
        includeInBrief: norm.includeInBrief,
        contentLinks: norm.contentLinks,
        outboundLinks: norm.outboundLinks.slice(0, 40),
        articlePublishedAt: norm.articlePublishedAt?.toISOString() ?? null,
        fromAddress: norm.fromAddress,
        fromDomain: norm.fromDomain,
      },
    };
  } catch {
    return null;
  }
}

function cleanBodyForStore(plain: string): string {
  return plain
    .replace(/ZjQcmQRYFpfptBannerStart[\s\S]*?ZjQcmQRYFpfptBannerEnd/gi, " ")
    .slice(0, MAX_BODY_CHARS);
}
