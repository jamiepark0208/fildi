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
    const raw = localStorage.getItem("fildi_scanner_extra");
    const tickers: string[] = raw ? JSON.parse(raw) : [];
    if (tickers.includes(ticker)) return;
    localStorage.setItem("fildi_scanner_extra", JSON.stringify([...tickers, ticker]));
  } catch {}
}
