/** A252/A274 — rankings live prices are opt-in only (default off = DB snapshots). */
export function rankingsWantLivePrices(queryVal: unknown): boolean {
  return String(queryVal ?? "0") === "1";
}
