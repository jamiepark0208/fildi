import { TrendingUp, TrendingDown } from "lucide-react";
import type { Recommendations } from "./analyst-ratings-section";

export function MarketSentimentSection({
  recs, bullBullets, bearBullets,
}: {
  recs: Recommendations | null;
  bullBullets: string[];
  bearBullets: string[];
}) {
  const total = recs ? recs.strongBuy + recs.buy + recs.hold + recs.sell + recs.strongSell : 0;
  const bullPct = total > 0 ? Math.round(((recs!.strongBuy + recs!.buy) / total) * 100) : 0;
  const neutralPct = total > 0 ? Math.round((recs!.hold / total) * 100) : 0;
  const bearPct = total > 0 ? 100 - bullPct - neutralPct : 0;

  const hasSentiment = total > 0;
  const hasBullets = bullBullets.length > 0 || bearBullets.length > 0;
  if (!hasSentiment && !hasBullets) return null;

  return (
    <div className="bg-card border border-border/50 rounded-xl p-4 space-y-5">
      <span className="text-base font-bold tracking-tight text-foreground block">Market Sentiment</span>

      {/* Bullish / Neutral / Bearish bar */}
      {hasSentiment && (
        <div>
          <div className="text-[10px] text-foreground uppercase tracking-widest mb-2">Wall St. Consensus</div>
          <div className="flex h-3 rounded-full overflow-hidden gap-px">
            {bullPct > 0 && (
              <div className="bg-green-500/80 transition-all" style={{ width: `${bullPct}%` }} />
            )}
            {neutralPct > 0 && (
              <div className="bg-yellow-500/60 transition-all" style={{ width: `${neutralPct}%` }} />
            )}
            {bearPct > 0 && (
              <div className="bg-red-500/70 transition-all" style={{ width: `${bearPct}%` }} />
            )}
          </div>
          <div className="flex justify-between mt-2 text-[11px]">
            <span className="text-green-400 font-semibold">{bullPct}% Bullish</span>
            <span className="text-yellow-400/80">{neutralPct}% Neutral</span>
            <span className="text-red-400 font-semibold">{bearPct}% Bearish</span>
          </div>
          <div className="text-[10px] text-foreground mt-1">Based on {total} Wall St. analyst recommendations</div>
        </div>
      )}

      {/* Bull / Bear table */}
      {hasBullets && (
        <div className="grid grid-cols-2 gap-3">
          <div className="border border-green-500/20 rounded-lg p-3 bg-green-500/5">
            <div className="flex items-center gap-1.5 mb-2">
              <TrendingUp className="w-3.5 h-3.5 text-green-400" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-green-400">Bull Case</span>
            </div>
            <ul className="space-y-1.5">
              {bullBullets.map((b, i) => (
                <li key={i} className="text-[11px] text-foreground flex gap-1.5">
                  <span className="shrink-0 text-green-500/70 mt-0.5">▲</span>
                  {b}
                </li>
              ))}
              {bullBullets.length === 0 && (
                <li className="text-[11px] text-foreground italic">No strong bull signals from current metrics</li>
              )}
            </ul>
          </div>
          <div className="border border-red-500/20 rounded-lg p-3 bg-red-500/5">
            <div className="flex items-center gap-1.5 mb-2">
              <TrendingDown className="w-3.5 h-3.5 text-red-400" />
              <span className="text-[10px] font-bold uppercase tracking-widest text-red-400">Bear Case</span>
            </div>
            <ul className="space-y-1.5">
              {bearBullets.map((b, i) => (
                <li key={i} className="text-[11px] text-foreground flex gap-1.5">
                  <span className="shrink-0 text-red-500/70 mt-0.5">▼</span>
                  {b}
                </li>
              ))}
              {bearBullets.length === 0 && (
                <li className="text-[11px] text-foreground italic">No significant bear signals from current metrics</li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
