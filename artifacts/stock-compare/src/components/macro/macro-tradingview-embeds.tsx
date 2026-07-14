import { useRef, useEffect } from "react";

// ── TradingView Widgets ────────────────────────────────────────────────────────

export function TradingViewMarketOverview() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-market-overview.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      colorTheme: "dark", dateRange: "12M", showChart: true,
      locale: "en", width: "100%", height: 660, largeChartUrl: "",
      isTransparent: false, showSymbolLogo: true, showFloatingTooltip: false,
      plotLineColorGrowing: "rgba(41, 98, 255, 1)",
      plotLineColorFalling: "rgba(41, 98, 255, 1)",
      gridLineColor: "rgba(240, 243, 250, 0)",
      scaleFontColor: "rgba(106, 109, 120, 1)",
      belowLineFillColorGrowing: "rgba(41, 98, 255, 0.12)",
      belowLineFillColorFalling: "rgba(41, 98, 255, 0.12)",
      belowLineFillColorGrowingBottom: "rgba(41, 98, 255, 0)",
      belowLineFillColorFallingBottom: "rgba(41, 98, 255, 0)",
      symbolActiveColor: "rgba(41, 98, 255, 0.12)",
      tabs: [
        {
          title: "Indices", symbols: [
            { s: "FOREXCOM:SPXUSD", d: "S&P 500" },
            { s: "FOREXCOM:NSXUSD", d: "Nasdaq 100" },
            { s: "FOREXCOM:DJI",    d: "Dow Jones" },
            { s: "INDEX:RTY",       d: "Russell 2000" },
            { s: "INDEX:VIX",       d: "VIX" },
          ], originalTitle: "Indices",
        },
        {
          title: "Bonds", symbols: [
            { s: "CBOT:ZB1!", d: "T-Bond Futures" },
            { s: "CBOT:ZN1!", d: "10Y Note Futures" },
            { s: "CBOT:ZF1!", d: "5Y Note Futures" },
            { s: "CBOT:ZT1!", d: "2Y Note Futures" },
          ], originalTitle: "Bonds",
        },
        {
          title: "Commodities", symbols: [
            { s: "CME_MINI:NQ1!", d: "Crude Oil" },
            { s: "NYMEX:CL1!",   d: "WTI Crude" },
            { s: "NYMEX:NG1!",   d: "Natural Gas" },
            { s: "COMEX:GC1!",   d: "Gold" },
            { s: "COMEX:SI1!",   d: "Silver" },
          ], originalTitle: "Commodities",
        },
        {
          title: "Forex", symbols: [
            { s: "FX:EURUSD", d: "EUR/USD" },
            { s: "FX:GBPUSD", d: "GBP/USD" },
            { s: "FX:USDJPY", d: "USD/JPY" },
            { s: "FX:USDCNY", d: "USD/CNY" },
            { s: "FX:USDCHF", d: "USD/CHF" },
          ], originalTitle: "Forex",
        },
      ],
    });
    el.appendChild(s);
  }, []);
  return (
    <div
      ref={ref}
      className="tradingview-widget-container rounded-lg overflow-hidden border border-border"
      style={{ height: 660, width: "100%" }}
    />
  );
}

export function TradingViewForexCrossRates() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-forex-cross-rates.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      width: "100%", height: 400,
      currencies: ["EUR", "USD", "JPY", "GBP", "CHF", "AUD", "CAD", "CNY"],
      isTransparent: false, colorTheme: "dark", locale: "en",
    });
    el.appendChild(s);
  }, []);
  return (
    <div
      ref={ref}
      className="tradingview-widget-container rounded-lg overflow-hidden border border-border"
      style={{ height: 400, width: "100%" }}
    />
  );
}

export function TradingViewHeatmap() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget" style="height:100%;width:100%"></div>';
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      exchanges: [], dataSource: "SPX500", grouping: "sector",
      blockSize: "market_cap_basic", blockColor: "change",
      locale: "en", colorTheme: "dark",
      hasTopBar: true, isDataSetEnabled: true, isZoomEnabled: true,
      hasSymbolTooltip: true, isMonoSize: false,
      width: "100%", height: 720,
    });
    el.appendChild(s);
  }, []);
  return (
    <div
      ref={ref}
      className="tradingview-widget-container rounded-lg overflow-hidden border border-border"
      style={{ height: 720, width: "100%" }}
    />
  );
}

export function TradingViewEconomicCalendar() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
    const s = document.createElement("script");
    s.type = "text/javascript";
    s.src = "https://s3.tradingview.com/external-embedding/embed-widget-events.js";
    s.async = true;
    s.innerHTML = JSON.stringify({
      colorTheme: "dark", isTransparent: false,
      width: "100%", height: "560", locale: "en",
      importanceFilter: "0,1", countryFilter: "us",
    });
    el.appendChild(s);
  }, []);
  return (
    <div
      ref={ref}
      className="tradingview-widget-container rounded-lg overflow-hidden border border-border"
      style={{ height: 560 }}
    />
  );
}
