/**
 * A267: every Schwab HTTP request counts in api_usage (source `schwab`).
 * Installed on global fetch so schwab-client.ts (busy while A266 landed) is covered
 * without editing it. Retries are separate requests and count again.
 */
import { recordApiUsage } from "./api-usage.js";

let installed = false;

export function installSchwabUsageMeter(): void {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const res = await orig(input, init);
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("api.schwabapi.com")) {
      void recordApiUsage("schwab", 1).catch(() => undefined);
    }
    return res;
  };
}
