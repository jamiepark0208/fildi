/**
 * A241 — which host this process is on.
 * unset / "mac" = today's Mac behavior (all jobs).
 * "public" = GCP shadow VM: public market jobs only; no brokerage/desk/LLM/research desktop.
 */
export type HostRole = "mac" | "public";

export function getHostRole(): HostRole {
  const v = (process.env.FILDI_HOST_ROLE || "mac").trim().toLowerCase();
  return v === "public" ? "public" : "mac";
}

export function isPublicHost(): boolean {
  return getHostRole() === "public";
}

/** Jobs that must never run on the public VM (private data, licensed desktop, or paid LLM in shadow). */
export const PUBLIC_HOST_SKIP = {
  schwab: true,
  schwab1m: true,
  deskIngest: true,
  tradeExpiry: true,
  modelListIntraday: true,
  researchOps: true,
  /** Anthropic / commentary — OFF during shadow (Jamie+Grok 10-24). */
  eventBullets: true,
  voicesIngest: true,
} as const;
