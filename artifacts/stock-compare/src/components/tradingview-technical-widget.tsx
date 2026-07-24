import { useEffect, useRef, useState } from "react";

const TV_SCRIPT_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-technical-analysis.js";

// Maps common exchange labels (yfinance/FMP) to TradingView's exchange prefix. Falls back to
// a bare ticker — TradingView's technical-analysis widget resolves major US tickers on its own.
function toTradingViewSymbol(ticker: string, exchange?: string | null): string {
  const e = (exchange ?? "").toLowerCase();
  if (e.includes("nasdaq")) return `NASDAQ:${ticker}`;
  if (e.includes("nyse")) return `NYSE:${ticker}`;
  if (e.includes("amex") || e.includes("arca")) return `AMEX:${ticker}`;
  if (e.includes("bats") || e.includes("cboe")) return `BATS:${ticker}`;
  return ticker;
}

interface TradingViewTechnicalWidgetProps {
  ticker: string;
  exchange?: string | null;
  height?: number;
}

/**
 * Lazy-loaded TradingView Technical Analysis widget. It's a single embedded iframe with
 * no client-side indicator computation, so it's cheap even with several stock breakdowns
 * open in a session — the script is only injected once the container scrolls into view.
 */
export function TradingViewTechnicalWidget({ ticker, exchange, height = 425 }: TradingViewTechnicalWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (visible || !containerRef.current) return;
    const el = containerRef.current;
    const observer = new IntersectionObserver(
      entries => { if (entries[0]?.isIntersecting) setVisible(true); },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    const container = containerRef.current;
    if (!visible || !container) return;
    container.innerHTML = "";

    const widgetDiv = document.createElement("div");
    widgetDiv.className = "tradingview-widget-container__widget";
    container.appendChild(widgetDiv);

    const script = document.createElement("script");
    script.src = TV_SCRIPT_SRC;
    script.type = "text/javascript";
    script.async = true;
    script.text = JSON.stringify({
      interval: "1D",
      width: "100%",
      isTransparent: true,
      height,
      symbol: toTradingViewSymbol(ticker, exchange),
      showIntervalTabs: true,
      displayMode: "single",
      locale: "en",
      colorTheme: "dark",
    });
    container.appendChild(script);

    return () => { container.innerHTML = ""; };
  }, [visible, ticker, exchange, height]);

  return <div className="tradingview-widget-container" ref={containerRef} style={{ height }} />;
}
