/**
 * One circuit breaker for every vendor (A303, runtime audit 10-28). Before, Yahoo and Schwab each hand-rolled one and
 * FRED / Finnhub / FMP had none, so an outage meant every caller kept hitting the dead vendor.
 *
 * `fails` network-type failures within `windowMs` → open for `openMs`: callers skip the vendor and use saved data.
 * After `openMs` it half-opens: the next call is a probe; success closes it, failure re-opens it.
 * Only outages count (network errors, timeouts, 5xx) — 4xx/429 are answers, handled by the caller's retry/back-off.
 */
import { logger } from "./logger.js";

export interface CircuitPolicy { fails: number; windowMs: number; openMs: number }
export const DEFAULT_CIRCUIT: CircuitPolicy = { fails: 3, windowMs: 60_000, openMs: 60_000 };

const OUTAGE = /fetch failed|ConnectTimeout|UND_ERR|ECONN|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|socket hang up|timeout|aborted|HTTP 5\d\d/i;
/** True for failures that mean "vendor unreachable", not "vendor said no". */
export function isOutageError(err: unknown): boolean {
  const e = err as { name?: string; message?: string } | null;
  return e?.name === "TimeoutError" || e?.name === "AbortError" || OUTAGE.test(String(e?.message ?? err));
}

export class VendorCircuit {
  private failsAt: number[] = [];
  private openUntil = 0;
  private opened = 0;

  constructor(readonly name: string, private policy: CircuitPolicy = DEFAULT_CIRCUIT) {}

  isOpen(now = Date.now()): boolean { return now < this.openUntil; }

  /** Record a failure; ignored unless it is an outage-type error. */
  noteFailure(err: unknown, now = Date.now()): void {
    if (!isOutageError(err)) return;
    this.failsAt = [...this.failsAt.filter((t) => now - t < this.policy.windowMs), now];
    if (this.failsAt.length >= this.policy.fails && !this.isOpen(now)) {
      this.openUntil = now + this.policy.openMs;
      this.failsAt = [];
      this.opened++;
      logger.warn({ vendor: this.name, until: new Date(this.openUntil).toISOString() }, `${this.name}: circuit open — vendor unreachable, using saved data for ${Math.round(this.policy.openMs / 1000)}s`);
    }
  }

  noteSuccess(): void { this.failsAt = []; }

  snapshot(): { name: string; open: boolean; openUntil: string | null; recentFailures: number; timesOpened: number } {
    const open = this.isOpen();
    return { name: this.name, open, openUntil: open ? new Date(this.openUntil).toISOString() : null, recentFailures: this.failsAt.length, timesOpened: this.opened };
  }
}

const circuits = new Map<string, VendorCircuit>();
/** Shared per-vendor circuit (same instance for every caller in this process). */
export function vendorCircuit(name: string, policy?: CircuitPolicy): VendorCircuit {
  let c = circuits.get(name);
  if (!c) circuits.set(name, (c = new VendorCircuit(name, policy)));
  return c;
}
export function allCircuits(): ReturnType<VendorCircuit["snapshot"]>[] {
  return [...circuits.values()].map((c) => c.snapshot());
}
