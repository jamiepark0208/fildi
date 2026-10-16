import { useState } from "react";
import { Search } from "lucide-react";
import { PeerGroupEditor } from "./PeerGroupEditor";

// ── Component ────────────────────────────────────────────────────────────────

export function PeerGroupsTab() {
  const [tickerInput, setTickerInput] = useState("");
  const [activeTicker, setActiveTicker] = useState("");

  const loadTicker = () => {
    const t = tickerInput.trim().toUpperCase();
    if (t) setActiveTicker(t);
  };

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <div>
        <h2 className="text-xs font-semibold text-white uppercase tracking-wide">Sector Peers</h2>
        <p className="text-[10px] text-white mt-0.5">
          Auto-classified peer groups for sector-relative fundamental scoring. Look up a ticker to
          reassign its group or edit the roster — changes feed scoring immediately.
        </p>
      </div>

      {/* Ticker search */}
      <div className="flex items-center gap-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-white/50" />
          <input
            value={tickerInput}
            onChange={e => setTickerInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === "Enter" && loadTicker()}
            placeholder="Ticker (e.g. NVDA)"
            className="pl-7 pr-2 py-1.5 text-xs bg-zinc-950 border border-[#d4af37]/25 rounded-md text-white w-48 focus:outline-none focus:border-[#d4af37]/60"
          />
        </div>
        <button
          onClick={loadTicker}
          className="text-xs px-3 py-1.5 border border-[#d4af37]/25 rounded-md text-white/90 hover:text-[#d4af37] hover:border-[#d4af37]/50 transition-colors"
        >
          Look up
        </button>
      </div>

      {activeTicker && <PeerGroupEditor ticker={activeTicker} />}
    </div>
  );
}
