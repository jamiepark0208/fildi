import { Redirect } from "wouter";

// COT positioning is now surfaced inline on the macro Volatility tab (CotSection
// renders the same positioning-extremes table there) — this page is a redirect only.
export default function Sentiment() {
  return <Redirect to="/live?page=macro&tab=volatility" replace />;
}
