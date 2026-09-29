import { useEffect, useRef, useState } from "react";

const TV_SCRIPT_SRC = "https://s3.tradingview.com/external-embedding/embed-widget-technical-analysis.js";

/** Maps yfinance/FMP exchange labels to TradingView prefixes. Bare ticker works for major US names. */
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
  /** Fixed viewport height of the box (px). */
  height?: number;
  /**
   * Visual size of the gauge inside the fixed box.
   * 1 = fit; &gt;1 enlarges (may clip); &lt;1 shrinks.
   */
  zoom?: number;
}

/**
 * Lazy-loaded TradingView Technical Analysis embed.
 * Box size is fixed; `zoom` CSS-scales the widget content so +/- changes gauge size.
 */
export function TradingViewTechnicalWidget({
  ticker,
  exchange,
  height = 220,
  zoom = 1,
}: TradingViewTechnicalWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const safeZoom = Math.min(1.5, Math.max(0.55, zoom));

  useEffect(() => {
    if (visible || !containerRef.current) return;
    const el = containerRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) setVisible(true);
      },
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
    widgetDiv.style.width = "100%";
    widgetDiv.style.height = "100%";
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
      showIntervalTabs: false,
      displayMode: "single",
      locale: "en",
      colorTheme: "dark",
    });
    container.appendChild(script);

    return () => {
      container.innerHTML = "";
    };
  }, [visible, ticker, exchange, height]);

  return (
    <div className="w-full overflow-hidden bg-zinc-950 rounded" style={{ height }}>
      <div
        className="tradingview-widget-container"
        ref={containerRef}
        style={{
          width: "100%",
          height,
          transform: `scale(${safeZoom})`,
          transformOrigin: "top center",
        }}
      />
    </div>
  );
}
