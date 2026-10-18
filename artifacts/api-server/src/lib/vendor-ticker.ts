/**
 * Vendor symbol aliases — our registry uses BRK.B / BF.B; Yahoo wants BRK-B / BF-B,
 * Schwab wants BRK/B / BF/B. Store bars under the registry ticker always (A87).
 */

const YAHOO: Record<string, string> = {
  "BRK.B": "BRK-B",
  "BF.B": "BF-B",
};

const SCHWAB: Record<string, string> = {
  "BRK.B": "BRK/B",
  "BF.B": "BF/B",
};

export function yahooSymbol(ticker: string): string {
  const t = ticker.toUpperCase();
  return YAHOO[t] ?? t.replace(/\./g, "-");
}

export function schwabSymbol(ticker: string): string {
  const t = ticker.toUpperCase();
  return SCHWAB[t] ?? t.replace(/\./g, "/");
}
