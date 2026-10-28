/** Add a ticker to the compare shelf (fildi_tickers, capped at 5) from outside the Router tree. */
export function addToCompareShelf(ticker: string): void {
  try {
    const raw = sessionStorage.getItem("fildi_tickers");
    const tickers: string[] = raw ? JSON.parse(raw) : [];
    if (tickers.includes(ticker) || tickers.length >= 5) return;
    sessionStorage.setItem("fildi_tickers", JSON.stringify([...tickers, ticker]));
  } catch {}
}

/** Add a ticker to the options scanner's extra list from outside that page. */
export function addToScannerShelf(ticker: string): void {
  try {
    const t = ticker.trim().toUpperCase();
    if (!t) return;
    const raw = localStorage.getItem("fildi_scanner_extra");
    const tickers: string[] = raw ? JSON.parse(raw) : [];
    if (tickers.includes(t)) return;
    localStorage.setItem("fildi_scanner_extra", JSON.stringify([...tickers, t]));
  } catch {}
}

/** Deep-link path for ticker-scoped Options (A179) — board scopes to one name + opens chain. */
export function optionsScannerHref(ticker: string): string {
  return `/options-scanner?ticker=${encodeURIComponent(ticker.trim().toUpperCase())}`;
}

export function readScannerExtras(): string[] {
  try {
    const raw = localStorage.getItem("fildi_scanner_extra");
    const tickers: string[] = raw ? JSON.parse(raw) : [];
    return tickers.map((t) => String(t).toUpperCase()).filter(Boolean);
  } catch {
    return [];
  }
}
