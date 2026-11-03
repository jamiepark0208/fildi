/**
 * Live vendor-path probe for Settings › API Monitor + Maintain.
 * Cheap: one Yahoo chart hit (deadline), circuit + DNS bypass status, last disk snapshot.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { Resolver } from "node:dns";
import { DNS_BYPASS_ACTIVE, PUBLIC_DNS } from "./dns-bypass.js";
import { getYahooCircuitSnapshot, withDeadline, noteYahooFailure, noteYahooSuccess } from "./yahoo-client.js";
import { LIVE_PRICE_TTL_MS } from "./live-quote.js";

const LOG_DIR = "/tmp/fildi-logs";
const SNAP_FILE = join(LOG_DIR, "vendor-health-last.json");
const MAINTAIN_FILE = join(LOG_DIR, "maintain-last.json");
const HISTORY_FILE = join(LOG_DIR, "vendor-health-history.jsonl");

export type VendorProbe = {
  name: string;
  ok: boolean;
  ms: number;
  status?: number;
  detail?: string;
  slow?: boolean;
};

export type VendorHealthPayload = {
  checkedAt: string;
  dnsBypass: { active: boolean; servers: string[] };
  yahooCircuit: ReturnType<typeof getYahooCircuitSnapshot>;
  livePriceTtlSec: number;
  probes: VendorProbe[];
  /** Last few Maintain/API probe outcomes (newest last). */
  recent?: { ts: string; overall: string; yahooOk: boolean | null; dnsSystemOk: boolean | null }[];
  /** From last Maintain run, if present. */
  maintain?: {
    ts: string | null;
    vendorsOk: boolean | null;
    yahooChart: { ok: boolean; ms: number | null; detail?: string } | null;
    dnsSystem?: { ok: boolean; ms: number | null; detail?: string } | null;
    vendorFailed: string[];
    softFailed?: string[];
  };
  overall: "ok" | "warn" | "down";
};

function readMaintainSlice(): VendorHealthPayload["maintain"] {
  try {
    if (!existsSync(MAINTAIN_FILE)) return undefined;
    const j = JSON.parse(readFileSync(MAINTAIN_FILE, "utf8")) as {
      ts?: string;
      vendorsOk?: boolean;
      vendorFailed?: string[];
      softFailed?: string[];
      healthResults?: { name: string; ok: boolean; ms?: number; detail?: string }[];
      results?: { name: string; ok: boolean; ms?: number; detail?: string }[];
    };
    const rows = j.healthResults ?? j.results ?? [];
    const yahoo = rows.find((r) => r.name === "yahoo_chart");
    const dnsSystem = rows.find((r) => r.name === "dns_system");
    return {
      ts: j.ts ?? null,
      vendorsOk: typeof j.vendorsOk === "boolean" ? j.vendorsOk : null,
      yahooChart: yahoo
        ? { ok: !!yahoo.ok, ms: yahoo.ms ?? null, detail: yahoo.detail }
        : null,
      dnsSystem: dnsSystem
        ? { ok: !!dnsSystem.ok, ms: dnsSystem.ms ?? null, detail: dnsSystem.detail }
        : null,
      vendorFailed: Array.isArray(j.vendorFailed) ? j.vendorFailed : [],
      softFailed: Array.isArray(j.softFailed) ? j.softFailed : [],
    };
  } catch {
    return undefined;
  }
}

function readRecentHistory(limit = 8): VendorHealthPayload["recent"] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const lines = readFileSync(HISTORY_FILE, "utf8").trim().split("\n").filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map((line) => {
      const j = JSON.parse(line) as {
        ts?: string;
        overall?: string;
        yahooOk?: boolean | null;
        dnsSystemOk?: boolean | null;
      };
      return {
        ts: j.ts ?? "",
        overall: j.overall ?? "?",
        yahooOk: j.yahooOk ?? null,
        dnsSystemOk: j.dnsSystemOk ?? null,
      };
    });
  } catch {
    return [];
  }
}

async function probeDnsPublic(): Promise<VendorProbe> {
  const started = Date.now();
  try {
    const addrs = await new Promise<string[]>((resolve, reject) => {
      const r = new Resolver();
      r.setServers([PUBLIC_DNS[0] ?? "1.1.1.1"]);
      const t = setTimeout(() => reject(new Error("timeout 3s")), 3000);
      r.resolve4("query1.finance.yahoo.com", (err, a) => {
        clearTimeout(t);
        if (err) reject(err);
        else resolve(a);
      });
    });
    return {
      name: "dns_public",
      ok: addrs.length > 0,
      ms: Date.now() - started,
      detail: addrs[0] ? `${PUBLIC_DNS[0]} → ${addrs[0]}` : "empty",
    };
  } catch (err: unknown) {
    return {
      name: "dns_public",
      ok: false,
      ms: Date.now() - started,
      detail: String((err as Error)?.message ?? err),
    };
  }
}

async function probeYahooChart(): Promise<VendorProbe> {
  const circuit = getYahooCircuitSnapshot();
  if (circuit.open) {
    return {
      name: "yahoo_chart",
      ok: false,
      ms: 0,
      detail: `circuit open until ${circuit.openUntil}`,
    };
  }
  const started = Date.now();
  try {
    const res = await withDeadline(
      fetch("https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1d&interval=1d", {
        signal: AbortSignal.timeout(8_000),
        headers: { "User-Agent": "TradeDash/1.0", Accept: "application/json" },
      }),
      8_000,
      "yahoo_chart",
    );
    const ms = Date.now() - started;
    // 429 = reachable but throttled — path works
    const ok = res.ok || res.status === 429;
    if (ok) noteYahooSuccess();
    else noteYahooFailure(new Error(`HTTP ${res.status}`));
    return {
      name: "yahoo_chart",
      ok,
      ms,
      status: res.status,
      detail: res.status === 429 ? "reachable (429 rate-limit)" : undefined,
      slow: ms > 2_500,
    };
  } catch (err: unknown) {
    noteYahooFailure(err);
    return {
      name: "yahoo_chart",
      ok: false,
      ms: Date.now() - started,
      detail: String((err as Error)?.message ?? err),
    };
  }
}

export async function buildVendorHealth(opts?: { probe?: boolean }): Promise<VendorHealthPayload> {
  const probe = opts?.probe !== false;
  const probes: VendorProbe[] = probe ? await Promise.all([probeDnsPublic(), probeYahooChart()]) : [];

  const yahooCircuit = getYahooCircuitSnapshot();
  const maintain = readMaintainSlice();
  const recent = readRecentHistory(8);
  const yahooProbe = probes.find((p) => p.name === "yahoo_chart");
  const dnsProbe = probes.find((p) => p.name === "dns_public");
  let overall: VendorHealthPayload["overall"] = "ok";
  if (yahooCircuit.open || yahooProbe?.ok === false || dnsProbe?.ok === false) overall = "down";
  else if (
    yahooProbe?.slow ||
    maintain?.vendorsOk === false ||
    maintain?.dnsSystem?.ok === false ||
    (maintain?.softFailed?.length ?? 0) > 0
  ) {
    overall = "warn";
  }

  const payload: VendorHealthPayload = {
    checkedAt: new Date().toISOString(),
    dnsBypass: { active: DNS_BYPASS_ACTIVE, servers: [...PUBLIC_DNS] },
    yahooCircuit,
    livePriceTtlSec: Math.round(LIVE_PRICE_TTL_MS / 1000),
    probes,
    recent,
    maintain,
    overall,
  };

  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(SNAP_FILE, JSON.stringify(payload, null, 2));
    if (probe) {
      appendFileSync(
        HISTORY_FILE,
        JSON.stringify({
          ts: payload.checkedAt,
          overall,
          yahooOk: yahooProbe?.ok ?? null,
          yahooMs: yahooProbe?.ms ?? null,
          dnsPublicOk: dnsProbe?.ok ?? null,
          dnsSystemOk: maintain?.dnsSystem?.ok ?? null,
          source: "api",
        }) + "\n",
      );
    }
  } catch {
    /* ignore disk */
  }
  return payload;
}

export function readVendorHealthSnapshot(): VendorHealthPayload | null {
  try {
    if (!existsSync(SNAP_FILE)) return null;
    return JSON.parse(readFileSync(SNAP_FILE, "utf8")) as VendorHealthPayload;
  } catch {
    return null;
  }
}
