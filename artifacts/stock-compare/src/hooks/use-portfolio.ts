import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

export type PositionType = "stock" | "short_put" | "short_call" | "long_put" | "long_call" | "crypto";

export interface PortfolioEntry {
  id: string;
  ticker: string;
  positionType: PositionType;
  qty: number;
  avgPrice: number;    // per share (stock) or premium per contract (options)
  strike?: number;     // options only
  expiry?: string;     // options only, "YYYY-MM-DD"
  openedAt: string;    // "YYYY-MM-DD"
  notes?: string;      // legacy — used as portfolio name for old entries
  portfolioName?: string;
  currentValue?: number;  // actual market value from CSV snapshot (positions: marketValue, options: markPrice×100×qty)
  unrealizedPnL?: number;
  delta?: number;
  theta?: number;
}

// bug/14 (2026-07-11): this hook used to be 100% localStorage
// (`fildi_portfolio_v1` / `fildi_portfolio_names_v1`), unscoped by user, so
// manual entries didn't survive a second device/browser. It's now backed by
// the server `positions` + `user_portfolio_names` tables via
// api-server/src/routes/positions.ts (userId-scoped through `requireAuth` —
// no client-side scoping needed, the server does it from the session).
//
// This hook is the "regular user" manual-entry path (see portfolio.tsx split
// by `isAdmin` — admins use the Robinhood-CSV-driven view instead and never
// call the mutators here). Do not delete this hook or its callers thinking
// they're dead code; they're the intentional non-admin experience.
//
// Field map: PortfolioEntry.portfolioName <-> positions.accountId (reused,
// not a new column — same column Robinhood-derived entries put the account
// nickname into via dbToEntries() in portfolio.tsx).
// PortfolioEntry.id becomes `db-${row.id}` to avoid colliding with the
// `rh-pos-`/`rh-opt-` ids Robinhood entries use.
// positions.positionType is a free-text column (not a DB enum) — we store
// the same PositionType strings used everywhere in the frontend ("stock",
// not "long_stock" as an old code comment on the schema implies).

const MIGRATION_FLAG_KEY = "fildi_portfolio_migrated_v1";
const LEGACY_STORAGE_KEY = "fildi_portfolio_v1";
const LEGACY_PORTFOLIOS_KEY = "fildi_portfolio_names_v1";

interface ServerPosition {
  id: number;
  ticker: string;
  positionType: string;
  qty: number;
  avgPrice: string;
  strike: string | null;
  expiry: string | null;
  openedAt: string;
  notes: string | null;
  accountId: string;
}

function serverToEntry(row: ServerPosition): PortfolioEntry {
  return {
    id: `db-${row.id}`,
    ticker: row.ticker,
    positionType: row.positionType as PositionType,
    qty: row.qty,
    avgPrice: parseFloat(row.avgPrice),
    strike: row.strike != null ? parseFloat(row.strike) : undefined,
    expiry: row.expiry ?? undefined,
    openedAt: row.openedAt.slice(0, 10),
    notes: row.notes ?? undefined,
    portfolioName: row.accountId,
  };
}

function entryToServerBody(entry: Omit<PortfolioEntry, "id" | "openedAt">) {
  return {
    accountId: entry.portfolioName || "Unassigned",
    ticker: entry.ticker,
    positionType: entry.positionType,
    qty: entry.qty,
    avgPrice: entry.avgPrice,
    strike: entry.strike,
    expiry: entry.expiry,
    notes: entry.notes,
  };
}

/** Remove option entries whose expiry has passed (past 4 PM ET on expiry date). */
function purgeExpiredOptions(entries: PortfolioEntry[]): PortfolioEntry[] {
  const now = Date.now();
  return entries.filter(e => {
    if (e.positionType === "stock" || !e.expiry) return true;
    const expiryMs = new Date(e.expiry + "T16:00:00").getTime();
    return expiryMs > now;
  });
}

/** Resolve the portfolio an entry belongs to, handling legacy `notes` field. */
export function entryPortfolio(entry: PortfolioEntry): string {
  return entry.portfolioName?.trim() || entry.notes?.trim() || "";
}

// One-time client-side import of any pre-migration localStorage entries into
// the server. Safe to delete this function (and the two LEGACY_*_KEY consts
// above) once confirmed no browser still has unmigrated localStorage data —
// bug/14 regression watchlist says not to remove it before then.
async function migrateLegacyLocalStorage(): Promise<void> {
  if (localStorage.getItem(MIGRATION_FLAG_KEY)) return;
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    const legacyEntries: PortfolioEntry[] = raw ? JSON.parse(raw) : [];
    for (const entry of legacyEntries) {
      const { id: _id, openedAt: _openedAt, ...rest } = entry;
      await fetch("/api/positions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entryToServerBody(rest)),
      });
    }
    const rawNames = localStorage.getItem(LEGACY_PORTFOLIOS_KEY);
    const legacyNames: string[] = rawNames ? JSON.parse(rawNames) : [];
    for (const name of legacyNames) {
      await fetch("/api/portfolio-names", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
    }
  } finally {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(LEGACY_PORTFOLIOS_KEY);
    localStorage.setItem(MIGRATION_FLAG_KEY, "done");
  }
}

async function fetchPositions(): Promise<PortfolioEntry[]> {
  await migrateLegacyLocalStorage();
  const res = await fetch("/api/positions", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load positions");
  const rows: ServerPosition[] = await res.json();
  return purgeExpiredOptions(rows.map(serverToEntry));
}

async function fetchPortfolioNames(): Promise<string[]> {
  const res = await fetch("/api/portfolio-names", { credentials: "include" });
  if (!res.ok) throw new Error("Failed to load portfolio names");
  return res.json();
}

export function usePortfolio() {
  const queryClient = useQueryClient();

  const positionsQuery = useQuery({
    queryKey: ["positions"],
    queryFn: fetchPositions,
  });
  const namesQuery = useQuery({
    queryKey: ["portfolio-names"],
    queryFn: fetchPortfolioNames,
  });

  const entries = positionsQuery.data ?? [];
  const portfolioNames = namesQuery.data ?? [];
  const isLoaded = !positionsQuery.isLoading && !namesQuery.isLoading;

  const addEntryMutation = useMutation({
    mutationFn: (entry: Omit<PortfolioEntry, "id" | "openedAt">) =>
      fetch("/api/positions", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entryToServerBody(entry)),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["positions"] }),
  });

  const removeEntryMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/positions/${id.replace(/^db-/, "")}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["positions"] }),
  });

  const updateEntryMutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<Omit<PortfolioEntry, "id">> }) => {
      const body: Record<string, unknown> = { ...patch };
      if (patch.portfolioName !== undefined) { body.accountId = patch.portfolioName; delete body.portfolioName; }
      return fetch(`/api/positions/${id.replace(/^db-/, "")}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["positions"] }),
  });

  const addPortfolioNameMutation = useMutation({
    mutationFn: (name: string) =>
      fetch("/api/portfolio-names", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["portfolio-names"] }),
  });

  const removePortfolioNameMutation = useMutation({
    mutationFn: (name: string) =>
      fetch(`/api/portfolio-names/${encodeURIComponent(name)}`, { method: "DELETE", credentials: "include" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["portfolio-names"] }),
  });

  return {
    entries, portfolioNames, isLoaded,
    addEntry: addEntryMutation.mutate,
    removeEntry: removeEntryMutation.mutate,
    updateEntry: (id: string, patch: Partial<Omit<PortfolioEntry, "id">>) => updateEntryMutation.mutate({ id, patch }),
    addPortfolioName: addPortfolioNameMutation.mutate,
    removePortfolioName: removePortfolioNameMutation.mutate,
  };
}

// ── Derived helpers ───────────────────────────────────────────────────────────

export function isOptionsPosition(type: PositionType): boolean {
  return type !== "stock" && type !== "crypto";
}

export function isShortPosition(type: PositionType): boolean {
  return type === "short_put" || type === "short_call";
}

export function positionLabel(type: PositionType): string {
  return {
    stock: "Stock",
    short_put: "Short Put",
    short_call: "Short Call",
    long_put: "Long Put",
    long_call: "Long Call",
    crypto: "Crypto",
  }[type];
}

export function cashCollateral(entry: PortfolioEntry): number {
  if (entry.positionType !== "short_put") return 0;
  return (entry.strike ?? 0) * 100 * entry.qty;
}

export function notionalValue(entry: PortfolioEntry): number {
  if (entry.positionType === "stock" || entry.positionType === "crypto") return entry.qty * entry.avgPrice;
  return (entry.strike ?? 0) * 100 * entry.qty;
}

export function premiumReceived(entry: PortfolioEntry): number {
  // avgPrice is already the per-contract dollar total (Robinhood's "Avg Premium (per
  // contract)" convention, matched by the manual-entry form's "per contract" label) —
  // do not re-multiply by 100 here, that double-counts the 100-shares-per-contract factor.
  if (!isShortPosition(entry.positionType)) return 0;
  return entry.avgPrice * entry.qty;
}

export function daysToExpiry(expiry: string | undefined): number | null {
  if (!expiry) return null;
  const ms = new Date(expiry + "T16:00:00").getTime() - Date.now();
  return Math.ceil(ms / 86_400_000);
}
