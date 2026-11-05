/** A329 seg3 — Yahoo mostRecentQuarter → ISO date (gold EPS period for the audit). */

type YahooQuotePayload = {
  defaultKeyStatistics?: { mostRecentQuarter?: unknown };
  financialData?: { mostRecentQuarter?: unknown };
};

/** Raw MRQ from vendor_raw quoteSummary — Yahoo puts it on defaultKeyStatistics, not financialData. */
export function yahooMostRecentQuarterRawFromPayload(payload: unknown): string | null {
  if (payload == null || typeof payload !== "object") return null;
  const p = payload as YahooQuotePayload;
  const raw = p.defaultKeyStatistics?.mostRecentQuarter ?? p.financialData?.mostRecentQuarter;
  if (raw == null || raw === "") return null;
  return String(raw).trim();
}

export function yahooMostRecentQuarterFromPayload(payload: unknown): string | null {
  return parseYahooMostRecentQuarter(yahooMostRecentQuarterRawFromPayload(payload));
}

export function parseYahooMostRecentQuarter(raw: string | null | undefined): string | null {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();
  const n = Number(s);
  if (Number.isFinite(n) && n > 1e8) {
    return new Date(n * (n > 1e12 ? 1 : 1000)).toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/** SEC TTM EPS wins over Yahoo trailingEps when statement period end is after Yahoo MRQ (A329 seg3 r5). */
export function pickEarningsPerShareByPeriod(
  candidates: { src: string; val: number }[],
  secPeriodEnd: string | null | undefined,
  yahooMrq: string | null | undefined,
): { src: string; val: number } | null {
  if (candidates.length === 0) return null;
  const sec = candidates.find((c) => c.src === "sec");
  const secWins =
    sec != null &&
    secPeriodEnd != null &&
    secPeriodEnd !== "" &&
    yahooMrq != null &&
    yahooMrq !== "" &&
    secPeriodEnd > yahooMrq;
  if (secWins && sec != null) return sec;
  const withoutStaleSec = secWins ? candidates : candidates.filter((c) => c.src !== "sec");
  const pool = withoutStaleSec.length > 0 ? withoutStaleSec : candidates;
  const yahoo = pool.find((c) => c.src === "yahoo");
  if (yahoo) return yahoo;
  return pool[0] ?? null;
}

/** Among share candidates, prefer the source with the newest pull timestamp (statement-date tie-break). */
export function pickSharesByStatementDate(
  candidates: { src: string; val: number }[],
  pulledAtBySrc: Map<string, number>,
  _statementEnd?: string | null,
): { src: string; val: number } {
  if (candidates.length === 0) throw new Error("pickSharesByStatementDate: no candidates");
  let best = candidates[0]!;
  let bestTs = pulledAtBySrc.get(best.src) ?? 0;
  for (const c of candidates.slice(1)) {
    const ts = pulledAtBySrc.get(c.src) ?? 0;
    if (ts > bestTs) {
      best = c;
      bestTs = ts;
    }
  }
  return best;
}
