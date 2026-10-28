/** Avg of two numeric strings (commas ok). */
function avgNum(a: string, b: string): number {
  return (parseFloat(a.replace(/,/g, "")) + parseFloat(b.replace(/,/g, ""))) / 2;
}

function fmtPctMid(mid: number, sign: string): string {
  const abs = Math.abs(mid);
  const body = abs < 1 ? mid.toFixed(2) : abs < 10 ? mid.toFixed(1) : String(Math.round(mid));
  const cleaned = body.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (sign === "+" || sign === "-") return `${sign}${cleaned.replace(/^[+-]/, "")}%`;
  return `~${cleaned.replace(/^[+-]/, "")}%`;
}

function fmtLevelMid(mid: number, dollar: boolean): string {
  if (dollar) {
    if (mid >= 100) return `$${Math.round(mid).toLocaleString("en-US")}`;
    return `$${mid.toFixed(1)}`;
  }
  if (mid >= 1000) return `~${Math.round(mid).toLocaleString("en-US")}`;
  if (mid >= 100) return Number.isInteger(mid) ? `~${mid}` : `~${mid.toFixed(1)}`;
  return `~${mid.toFixed(2)}`;
}

/** Canonical desk skim: `NAME ~level (±pct%)`. */
function fmtNameLevelPct(name: string, level: string, pct: string): string {
  return `${name.trim()} ${normLevelToken(level)} (${normPctToken(pct)})`;
}

function normPctToken(pct: string, forceSign?: "+" | "-"): string {
  let p = pct
    .replace(/~/g, "")
    .replace(/[\u2212\u2013]/g, "-")
    .replace(/\s+/g, "")
    .trim();
  if (!p.endsWith("%")) p += "%";
  const body = p.replace(/%$/, "").replace(/^[+-]/, "");
  let sign = p.startsWith("-") ? "-" : p.startsWith("+") ? "+" : (forceSign ?? "+");
  if (forceSign) sign = forceSign;
  return `${sign}${body}%`;
}

function normLevelToken(lvl: string): string {
  const raw = lvl.trim();
  const dollar = /\$/.test(raw);
  const n = parseFloat(raw.replace(/[$,~]/g, "").replace(/,/g, ""));
  if (!Number.isFinite(n)) return raw.startsWith("~") || raw.startsWith("$") ? raw : `~${raw}`;
  return fmtLevelMid(n, dollar);
}

/**
 * Desk-skim Muse bullets: avg ranges, drop fluff, keep levels/%.
 * Display only — full Muse file unchanged on disk.
 */
export function compressMuseBullet(raw: string): string {
  let s = raw.replace(/\s+/g, " ").trim();

  // Unhelpful hedges / meta
  s = s.replace(/\s*Exact prints vary by timestamp;\s*direction is consistent\.?/gi, "");
  s = s.replace(/\s*The claim is unconfirmed[^.]*\./gi, "");
  s = s.replace(/\s*[—–-]?\s*the price response is real,\s*the physical disruption is not yet verified\.?/gi, "");
  s = s.replace(/\s*\(Actuals for these[^)]*\)\.?/gi, "");
  s = s.replace(/\s*sources checked conflict on the expected move[^.]*\./gi, "");

  // Lead-ins → short (keep levels; cut essay)
  s = s.replace(/^Futures are mixed into the day's double event:\s*/i, "Futures mixed. ");
  s = s.replace(/^Tuesday closed strong:\s*/i, "Tue close: ");
  s = s.replace(/^Asia was the overnight story:\s*/i, "Asia: ");
  s = s.replace(/^Oil jumped back:\s*/i, "Oil: ");
  s = s.replace(/^Rates sit on the wrong side of 5%:\s*/i, "Rates: ");
  s = s.replace(/^Today is the main event, not the warm-up:\s*/i, "");
  s = s.replace(/\btech leading, Dow lagging\.?/gi, "Technology leads. Dow lags.");
  s = s.replace(/\bEurope is softer in afternoon trading:\s*/gi, "Europe soft: ");
  // Times: "2:00 PM ET" → "2:00 ET" (PM is noise next to ET)
  s = s.replace(/\b(\d{1,2}:\d{2})\s*PM\s*ET\b/gi, "$1 ET");
  s = s.replace(/\b(\d{1,2}:\d{2})\s*AM\s*ET\b/gi, "$1 ET");
  // FOMC hold prose → tight
  s = s.replace(
    /\bA hold is\s*(~?[\d.]+(?:\s*[\u2013\-]\s*[\d.]+)?)%\s*priced\s*[—–·-]\s*the trade is in Warsh's tone on December, where a further hike remains the open question\.?/gi,
    (_m, band: string) => {
      const parts = band.replace(/~/g, "").split(/\s*[\u2013\-]\s*/).map((x) => parseFloat(x));
      const mid = parts.length === 2 && parts.every(Number.isFinite)
        ? (parts[0]! + parts[1]!) / 2
        : parts[0];
      const pct = mid != null && Number.isFinite(mid)
        ? String(Math.round(mid))
        : band.replace(/[~%\s]/g, "");
      return `Hold ~${pct}% priced; watch Warsh tone on Dec hike.`;
    },
  );
  s = s.replace(
    /\bThe market is rewarding companies with real orders and cash \(power, memory\) and punishing misses harshly\s*[—–·-]\s*breadth is narrow even on an up tape\.?/gi,
    "Real orders/cash bid (power, memory); misses punished; breadth narrow.",
  );
  s = s.replace(
    /\bA hawkish Warsh read plus hot PCE would reprice December fast;\s*that is the two-day tail for any premium sold today\.?/gi,
    "Hawkish Warsh + hot PCE → Dec reprice; tail for premium sold today.",
  );
  s = s.replace(
    /\bOil near multi-month highs keeps an inflation tail alive into tomorrow's GDP\/PCE prints\.?/gi,
    "Oil highs → inflation tail into GDP/PCE.",
  );
  s = s.replace(
    /\bA 5%\+\s*10Y plus \$(\d+)\s*Brent is a tight backdrop for expensive growth names\.?/gi,
    (_m, n: string) => `5%+ 10Y + $${n} Brent = tight for expensive growth.`,
  );

  // % ranges → avg (before level ranges so "1.1–1.6%" wins over bare numbers)
  s = s.replace(
    /([+\u2212\u2013\-])?\s*~?(\d+(?:\.\d+)?)\s*[\u2013\-]\s*~?(\d+(?:\.\d+)?)\s*%/g,
    (_m, sign: string | undefined, a: string, b: string) => {
      const mid = avgNum(a, b);
      const sgn =
        sign === "-" || sign === "\u2212" || sign === "\u2013" ? "-"
          : sign === "+" ? "+"
            : "";
      // Leading space so "up ~0.15%" keeps word boundary for later rewrite
      return ` ${fmtPctMid(sgn === "-" ? -Math.abs(mid) : mid, sgn || "~")}`;
    },
  );

  // $ ranges → avg
  s = s.replace(
    /~?\$([\d,.]+)\s*[\u2013\-]\s*\$?([\d,.]+)/g,
    (_m, a: string, b: string) => fmtLevelMid(avgNum(a, b), true),
  );

  // near 7,767–7,772 → ~7,770
  s = s.replace(
    /near\s+([\d,.]+)\s*[\u2013\-]\s*([\d,.]+)/gi,
    (_m, a: string, b: string) => fmtLevelMid(avgNum(a, b), false),
  );

  // bare level ranges: 17.50–17.52 / 7,767–7,772 → avg.
  // Both sides must look like levels (≥2 int digits or thousands comma) — never "600 -0.26%".
  s = s.replace(
    /(?<![\d.$])~?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{2,}(?:\.\d+)?)\s*[\u2013\-]\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d{2,}(?:\.\d+)?)(?!\d)(?!\s*%)/g,
    (_m, a: string, b: string) => fmtLevelMid(avgNum(a, b), false),
  );

  // "NAME futures up|down PCT [near] LEVEL" → "NAME futures LEVEL (signed%)"
  s = s.replace(
    /\b((?:S&P\s*500|Nasdaq(?:\s*100)?|Dow)\s*futures)\s+(up|down)\s+(~?[+\-]?\d+(?:\.\d+)?%)\s+(?:near\s+)?(~?[\d,]+)/gi,
    (_m, name: string, dir: string, pct: string, lvl: string) =>
      fmtNameLevelPct(name, lvl, dir.toLowerCase() === "down" ? `-${pct.replace(/^[+\-~]/g, "")}` : pct),
  );

  // "NAME ±X% to LEVEL" → "NAME LEVEL (±X%)" (closes, Asia, etc.)
  s = s.replace(
    /\b((?:S&P\s*500|Nasdaq(?:\s*Composite|\s*100)?|Russell\s*2000|KOSPI|Nikkei|Shanghai|Hang\s*Seng|Taiwan|Gold|bitcoin|Bitcoin|WTI|Brent|Dow)(?:\s+futures)?)\s+([+\u2212\u2013\-]\s*~?\d+(?:\.\d+)?%)\s+to\s+(~?\$?[\d,.]+)/gi,
    (_m, name: string, pct: string, lvl: string) => fmtNameLevelPct(name, lvl, pct),
  );

  // "NAME slipped|eased|fell|rose|jumped PCT to LEVEL"
  s = s.replace(
    /\b(Gold|VIX|bitcoin|Bitcoin)\s+(slipped|eased|fell|dropped|rose|jumped|rallied)\s+(~?[+\-]?\d+(?:\.\d+)?%)\s+to\s+(~?\$?[\d,.]+)/gi,
    (_m, name: string, verb: string, pct: string, lvl: string) => {
      const neg = /slip|ease|fell|drop/i.test(verb);
      return fmtNameLevelPct(name, lvl, neg ? `-${pct.replace(/^[+\-~]/g, "")}` : pct);
    },
  );

  // "Dow essentially flat at LEVEL (±X%)"
  s = s.replace(
    /\b(Dow|S&P\s*500|Nasdaq(?:\s*Composite)?)\s+essentially\s+flat\s+at\s+([\d,.]+)\s*\(([+\-]?\d+(?:\.\d+)?%)\)/gi,
    (_m, name: string, lvl: string, pct: string) => fmtNameLevelPct(name, lvl, pct),
  );

  // "VIX eased to LEVEL" (level only)
  s = s.replace(/\bVIX\s+eased\s+to\s+(~?[\d.]+)/gi, (_m, lvl: string) => `VIX ${normLevelToken(lvl)}`);

  // "bitcoin bounced … to LEVEL" (allow commas inside $79,300)
  s = s.replace(
    /\bbitcoin\s+bounced\s+off\b[\s\S]*?\sto\s+(~?\$?[\d,.]+)/gi,
    (_m, lvl: string) => `Bitcoin ${normLevelToken(lvl)}`,
  );

  // Already-level commodities: "Brent $115 (+1.4%)" — just tidy
  s = s.replace(
    /\b(Brent|WTI)\s+(~?\$[\d,.]+)\s*\(\s*([+\u2212\u2013\-]?\s*~?\d+(?:\.\d+)?%)\s*\)/gi,
    (_m, name: string, lvl: string, pct: string) => fmtNameLevelPct(name, lvl, pct),
  );

  // Index with % only (no print): "Hang Seng +0.23%" / "DAX flat to −0.16%" / "STOXX 600 -0.26%"
  s = s.replace(
    /\b(Hang\s*Seng|Taiwan|DAX|FTSE\s*100|STOXX\s*600)\s+(?:flat\s+to\s+)?([+\u2212\u2013\-]?\s*~?\d+(?:\.\d+)?%)/gi,
    (_m, name: string, pct: string) => `${name} (${normPctToken(pct)})`,
  );

  // Separate stacked names after a closed paren level-pct unit
  s = s.replace(/(\))\s+(Nasdaq|Dow|S&P|Russell|KOSPI|Nikkei|Shanghai|Hang|Taiwan|Gold|Bitcoin|WTI|Brent|VIX)/gi, "$1; $2");

  return s
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.;])/g, "$1")
    .replace(/\.\s*\./g, ".")
    .trim();
}

/** Pull Muse "So what:" trailer off a single-name bullet. */
export function splitMuseSoWhat(raw: string): { fact: string; soWhat: string | null } {
  const m =
    raw.match(/^(.*?)\.\s*So what:\s*(.+)$/is)
    ?? raw.match(/^(.*?)\s+So what:\s*(.+)$/is);
  if (!m) return { fact: raw.trim(), soWhat: null };
  return {
    fact: m[1]!.trim().replace(/[·.;]\s*$/g, ""),
    soWhat: m[2]!.trim(),
  };
}

/** Ticker/lead label from a single-name fact line. */
export function singleNameLead(fact: string): string {
  if (/^Tonight'?s binaries:/i.test(fact)) return "GOOGL/MSFT";
  if (/^SK\s*Hynix\b/i.test(fact)) return "SK Hynix";
  const multi = fact.match(/^([A-Z]{1,5})\b/);
  if (multi) return multi[1]!;
  return "";
}

/** Split Implications into gold lead + body when Muse uses `Label: …`. */
export function splitImplicationLead(text: string): { lead: string; body: string } | null {
  const m = text.match(/^([A-Za-z][^:]{0,40}?):\s+(.+)$/);
  if (!m) return null;
  const lead = m[1]!.trim();
  // Guard against "Fed 2:00" mid-time splits
  if (/\b\d{1,2}$/.test(lead) || lead.length > 36) return null;
  return { lead, body: m[2]!.trim() };
}

/** Compress pulled so-whats into a short desk skim list (keep tickers + verbs). */
export function synthesizeSingleNameSoWhats(
  rows: Array<{ lead: string; soWhat: string }>,
): string[] {
  return rows.map(({ lead, soWhat }) => {
    let s = soWhat
      .replace(/\s*[—–]\s*/g, " · ")
      .replace(/\bdon't chase short puts into\b/gi, "no chase short puts into")
      .replace(/\bno naked short premium into either\b/gi, "no naked short premium")
      .replace(/\bor sit out and sell the vol crush after\.?/gi, "or sit out, sell crush after")
      .replace(/\bthe platform's own stock weakness is sentiment, not a book signal, but it sets a sour tone for fintech premium\.?/gi, "fintech tone soft")
      .replace(/\bsingle-name premium into any of these prints is gap risk, not income\.?/gi, "single-name premium = gap risk, not income")
      .replace(/\s*·\s*·\s*/g, " · ")
      .replace(/\s+/g, " ")
      .trim();
    if (s.length > 160) s = `${s.slice(0, 157)}…`;
    return lead ? `${lead}: ${s}` : s;
  });
}

/**
 * Implications skim: keep levels/actions, cut essay.
 * Prefer `Lead: action` when a colon lead exists.
 */
export function compressImplicationBullet(raw: string): string {
  let s = compressMuseBullet(raw);
  // Invent short leads for skim (pair with splitImplicationLead in UI)
  s = s.replace(
    /^Two event walls today\s*\(([^)]+)\):\s*/i,
    "Event walls: $1 · ",
  );
  s = s.replace(
    /^VIX\s+([~.0-9]+)\s+is not cheap with\b/i,
    "VIX: $1 not cheap with",
  );
  s = s.replace(/\ba hold with a hawkish presser is still a vol event\.?/gi, "hawkish hold still = vol event");
  s = s.replace(/\btonight's prints are the exception that proves the rule\.?/gi, "");
  s = s.replace(/\bFavor broad-index premium over single-name earnings premium today;?/gi, "Prefer index premium over single-name earnings;");
  s = s.replace(/\bunder Robinhood's rule,\s*/gi, "RH: ");
  s = s.replace(
    /\s*so the effective deadline to close or roll ITM shorts is Thursday's close, not Friday's expiry\.?/gi,
    " · close/roll ITM by Thu close (not Fri expiry).",
  );
  s = s.replace(/\bCheck the book before Thursday's close\.?/gi, "Check book before Thu close.");
  s = s.replace(
    /\band don't short calls on energy into a headline that could reverse fast\.?/gi,
    "; no short energy calls into headline whipsaw",
  );
  s = s.replace(
    /\bavoid short puts on airlines\/transports while fuel is a margin tax\b/gi,
    "no short puts on airlines/transports (fuel tax)",
  );
  s = s.replace(
    /\bstandard width is fine on broad index only if strikes sit outside the ±1-day implied range\.?/gi,
    "index width OK only outside ±1d implied",
  );
  s = s.replace(
    /\bwider on tech and hyperscaler-adjacent names into tonight;?/gi,
    "wider strikes on tech/hyperscaler into tonight;",
  );
  s = s.replace(
    /\bkeep new short premium short-dated and sized for vol expansion if Warsh leans hawkish on December\s*[·—–-]\s*/gi,
    "short-dated premium sized for Dec-hawkish Warsh · ",
  );
  return s.replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim();
}

/**
 * Parse Haiku desk brief into section cards.
 * Accepts markdown list bullets AND bare catalyst lines (`**Lead** — detail`).
 */
export function parseSections(md: string): Array<{ title: string; bullets: string[] }> {
  const sections: Array<{ title: string; bullets: string[] }> = [];
  let cur: { title: string; bullets: string[] } | null = null;
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t || t === "---" || t === "***") continue;
    if (t.startsWith("## ")) {
      cur = { title: t.slice(3).trim(), bullets: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    if (t.startsWith("- ") || t.startsWith("* ")) {
      cur.bullets.push(t.slice(2).trim());
      continue;
    }
    if (/^\d+[\).]\s+/.test(t)) {
      cur.bullets.push(t.replace(/^\d+[\).]\s+/, "").trim());
      continue;
    }
    if (t.length >= 12 && !t.startsWith("#")) {
      cur.bullets.push(t);
    }
  }
  return sections.filter((s) => s.bullets.length > 0);
}
