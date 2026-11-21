/**
 * Trade-ticket entry points (one home): QuoteChip = live Bid (sell) / Ask (buy) on a chain row;
 * AddToTicket = "+ Ticket" for any contract or multi-leg rec (legs repriced live by the store).
 */
import { cn } from "@/lib/utils";
import { ticket, type ContractSpec } from "@/lib/trade-ticket-store";
import type { TicketLeg } from "@/lib/trade-ticket";

type Live = Pick<TicketLeg, "ticker" | "kind" | "strike" | "expiry" | "iv" | "spot">;

/** Robinhood-style quote chip: click adds the leg at that price; never bubbles to the row. */
export function QuoteChip({ side, price, contract, tip }: {
  side: "long" | "short"; price: number | null; contract: Live; tip?: string;
}) {
  const ok = price != null && price > 0;
  return (
    <button
      type="button"
      disabled={!ok}
      title={ok ? `${side === "long" ? "Buy at ask" : "Sell at bid"} $${price!.toFixed(2)} → add to trade ticket` : (tip ?? (side === "long" ? "No ask" : "No live bid"))}
      onClick={(e) => { e.stopPropagation(); if (ok) ticket.add({ ...contract, side, price: price! }); }}
      className={cn(
        "w-[52px] rounded border px-1 font-mono text-[11px] leading-4",
        !ok
          ? "cursor-default border-transparent text-amber-200/35"
          : side === "short"
            ? "border-red-500/40 text-red-200 hover:bg-red-900/50"
            : "border-emerald-500/40 text-emerald-200 hover:bg-emerald-900/50",
      )}
    >
      {ok ? `$${price!.toFixed(2)}` : "—"}
    </button>
  );
}

/** Bid + Ask pair for one chain row. */
export function QuoteChips({ bid, ask, contract, bidTip }: { bid: number | null; ask: number | null; contract: Live; bidTip?: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <QuoteChip side="short" price={bid} contract={contract} tip={bidTip} />
      <QuoteChip side="long" price={ask != null && (bid == null || ask >= bid) ? ask : null} contract={contract} />
    </span>
  );
}

/** "+ Ticket" for a contract set; expired legs are skipped by the store. */
export function AddToTicket({ legs, label = "+ Ticket", className, tip }: {
  legs: ContractSpec[]; label?: string; className?: string; tip?: string;
}) {
  const live = legs.filter((l) => l.kind === "stock" || !l.expiry || Date.parse(`${l.expiry}T21:00:00Z`) > Date.now());
  return (
    <button
      type="button"
      disabled={!live.length}
      title={live.length ? (tip ?? `Add ${live.length} leg${live.length > 1 ? "s" : ""} to the trade ticket at live bid/ask`) : "Expired"}
      onClick={(e) => { e.stopPropagation(); ticket.addContracts(live); }}
      className={cn(
        "rounded border px-1.5 text-[11px] leading-4",
        live.length ? "border-[#d4af37]/50 text-[#fef3c7] hover:bg-[#d4af37]/20" : "cursor-default border-transparent text-amber-200/35",
        className,
      )}
    >
      {label}
    </button>
  );
}
