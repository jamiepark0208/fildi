import { useEffect, useRef } from "react";

/**
 * TradingView's own Advanced Chart embed (Jamie 11-04: "outsource the buy/sell logic to TradingView").
 * Every indicator here is TradingView's code, not ours — add/remove/edit settings from its Indicators menu;
 * TradingView keeps the layout in this browser. Built-in indicators only: the free embed cannot load community
 * scripts (UT Bot / BigBeluga / AlgoAlpha / Zeiierman / LazyBear) — those need TradingView alerts → webhook.
 */
const SRC = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
const DEFAULT_STUDIES = ["STD;Supertrend", "STD;MACD", "STD;RSI"];

function tvSymbol(t: string): string {
  if (t.includes(":")) return t;
  if (t === "SPY" || t === "IWM" || t === "DIA") return `AMEX:${t}`;
  if (t === "QQQ") return `NASDAQ:${t}`;
  return t; // TradingView resolves bare US tickers
}

export function TradingViewAdvancedChart({ symbol, height = 460 }: { symbol: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.innerHTML = "";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    host.appendChild(widget);
    const s = document.createElement("script");
    s.src = SRC;
    s.async = true;
    s.type = "text/javascript";
    s.innerHTML = JSON.stringify({
      autosize: true,
      symbol: tvSymbol(symbol),
      interval: "5",
      timezone: "America/Los_Angeles",
      theme: "dark",
      style: "1",
      locale: "en",
      backgroundColor: "#09090b",
      allow_symbol_change: true,
      hide_side_toolbar: false,
      withdateranges: true,
      details: false,
      calendar: false,
      studies: DEFAULT_STUDIES,
      support_host: "https://www.tradingview.com",
    });
    host.appendChild(s);
    return () => { host.innerHTML = ""; };
  }, [symbol]);
  return <div ref={ref} className="tradingview-widget-container w-full" style={{ height }} />;
}
