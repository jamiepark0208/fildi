/**
 * Bypass a wedged macOS mDNSResponder (getaddrinfo hangs / pegs CPU).
 * Route Node DNS through public resolvers so undici/yahoo/Schwab don't stall
 * every tab for ~10s on ConnectTimeout.
 *
 * Must load before any outbound fetch (imported first from index.ts).
 * No logger import — keep this dependency-free so boot stays safe.
 *
 * Disable: FILDI_DNS_BYPASS=0 (default on when unset).
 */
import dns from "node:dns";
import { Resolver } from "node:dns";
import { loadEnvLocal } from "./load-env-local.js";

loadEnvLocal();

export const PUBLIC_DNS = ["1.1.1.1", "8.8.8.8", "9.9.9.9"];

function dnsBypassEnabled(): boolean {
  const v = process.env.FILDI_DNS_BYPASS;
  if (v === undefined || v.trim() === "") return true;
  return !/^(0|false|no|off)$/i.test(v.trim());
}

/** True when this process patched dns.lookup to use PUBLIC_DNS first. */
export const DNS_BYPASS_ACTIVE = dnsBypassEnabled();

if (DNS_BYPASS_ACTIVE) {
  const resolver = new Resolver();
  resolver.setServers(PUBLIC_DNS);

  try {
    dns.setDefaultResultOrder("ipv4first");
  } catch {
    /* node < 17 */
  }

  const origLookup = dns.lookup.bind(dns);

  type LookupCallback = (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number,
  ) => void;

  function resolveViaPublic(
    hostname: string,
    options: dns.LookupOneOptions | dns.LookupAllOptions | number | undefined,
    callback: LookupCallback,
  ): void {
    const opts = typeof options === "object" && options ? options : {};
    const all = !!(opts as dns.LookupAllOptions).all;

    resolver.resolve4(hostname, (err4, addrs4) => {
      if (!err4 && addrs4?.length) {
        if (all) {
          callback(null, addrs4.map((address) => ({ address, family: 4 })));
          return;
        }
        callback(null, addrs4[0], 4);
        return;
      }
      resolver.resolve6(hostname, (err6, addrs6) => {
        if (!err6 && addrs6?.length) {
          if (all) {
            callback(null, addrs6.map((address) => ({ address, family: 6 })));
            return;
          }
          callback(null, addrs6[0], 6);
          return;
        }
        // OS resolver last — may hang if mDNS is dead; rare if Cloudflare works.
        origLookup(hostname, options as dns.LookupOptions, callback as never);
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (dns as any).lookup = (
    hostname: string,
    options?: dns.LookupOneOptions | dns.LookupAllOptions | number | LookupCallback,
    callback?: LookupCallback,
  ) => {
    if (typeof options === "function") {
      resolveViaPublic(hostname, undefined, options);
      return;
    }
    resolveViaPublic(hostname, options, callback!);
  };

  console.info(`[dns-bypass] Node lookups via ${PUBLIC_DNS.join(", ")} (FILDI_DNS_BYPASS on; skip wedged mDNS)`);
} else {
  console.info("[dns-bypass] disabled (FILDI_DNS_BYPASS=0); using OS resolver");
}
