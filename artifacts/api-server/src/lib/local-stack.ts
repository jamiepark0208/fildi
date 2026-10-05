/**
 * Mac local-dev stack status (API :8080 + Vite :8081).
 * Soft-adopts pidfiles when a sole healthy listener drifted (no process kill).
 * Pidfiles written by scripts/dev-spawn.mjs / heal.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const LOG_DIR = "/tmp/fildi-logs";
const API_PORT = Number(process.env.API_PORT || 8080);
const VITE_PORT = Number(process.env.VITE_PORT || 8081);

type PidRecord = {
  pid: number;
  pgid?: number;
  port?: number | null;
  cmd?: string;
  log?: string;
  startedAt?: string;
};

export type LocalStackService = {
  up: boolean;
  pid: number | null;
  ageSec: number | null;
  orphan: boolean;
  port: number;
  log: string;
};

export type LocalStackStatus = {
  enabled: boolean;
  api: LocalStackService;
  vite: LocalStackService;
  orphans: { pid: number; port: number; cmd: string }[];
  hint: string;
  clean: boolean;
};

function readPidfile(path: string): PidRecord | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as PidRecord;
  } catch {
    return null;
  }
}

function alive(pid: number | undefined | null): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listenerPids(port: number): number[] {
  try {
    const out = execFileSync("/usr/sbin/lsof", ["-tiTCP:" + port, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return [];
    return out
      .split(/\s+/)
      .map((x) => Number(x))
      .filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function cmdline(pid: number): string {
  try {
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function ageSec(startedAt: string | undefined): number | null {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function httpOk(url: string): boolean {
  try {
    execFileSync("/usr/bin/curl", ["-sf", "-o", "/dev/null", "--max-time", "2", url], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Port this Node process is serving (set by dev-spawn). Avoid self-curl deadlock. */
function selfListenPort(): number | null {
  const p = Number(process.env.PORT || "");
  return Number.isFinite(p) && p > 0 ? p : null;
}

function matchesCanonical(listenerPid: number, record: PidRecord | null): boolean {
  if (!record || !alive(record.pid)) return false;
  if (listenerPid === record.pid) return true;
  const leader = record.pgid || record.pid;
  try {
    let cur = listenerPid;
    for (let i = 0; i < 16; i++) {
      const raw = execFileSync("/bin/ps", ["-o", "ppid=,pgid=", "-p", String(cur)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      const parts = raw.split(/\s+/).map(Number);
      const ppid = parts[0];
      const pgid = parts[1];
      if (cur === record.pid || ppid === record.pid || pgid === leader || pgid === record.pid) {
        return true;
      }
      if (!ppid || ppid <= 1) break;
      cur = ppid;
    }
    return false;
  } catch {
    return true;
  }
}

function pgidOf(pid: number): number | undefined {
  try {
    const raw = execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

/** When the sole healthy listener drifted from a dead/stale pidfile, rewrite pidfile (no kill). */
function softAdopt(name: "api" | "vite", port: number, listenerPid: number, record: PidRecord | null): PidRecord {
  const next: PidRecord = {
    pid: listenerPid,
    pgid: pgidOf(listenerPid),
    port,
    cmd: cmdline(listenerPid) || record?.cmd || "",
    log: record?.log || `${LOG_DIR}/${name}.log`,
    startedAt:
      record?.startedAt && record.pid === listenerPid
        ? record.startedAt
        : new Date().toISOString(),
  };
  try {
    writeFileSync(`${LOG_DIR}/${name}.pid.json`, JSON.stringify(next, null, 2));
  } catch {
    /* best-effort */
  }
  return next;
}

function inspect(name: "api" | "vite", port: number, health: string): LocalStackService & { listeners: number[] } {
  const pidfile = `${LOG_DIR}/${name}.pid.json`;
  let record = readPidfile(pidfile);
  const listeners = listenerPids(port);
  const primary = listeners[0] ?? null;
  // Never curl our own PORT: this helper runs inside the API request and uses
  // execFileSync, which blocks the event loop — self-healthz would time out and
  // falsely report API down (CLI status is fine; it probes from outside).
  const self = selfListenPort();
  const up =
    listeners.length > 0 && (self != null && port === self ? true : httpOk(health));

  // Sole healthy listener + dead/mismatched pidfile → adopt (false "orphan" spam).
  if (up && primary && listeners.length === 1) {
    const canonicalAlive = record ? alive(record.pid) : false;
    if (!record || !canonicalAlive || !matchesCanonical(primary, record)) {
      record = softAdopt(name, port, primary, record);
    }
  }

  const canonicalAlive = record ? alive(record.pid) : false;
  const orphan =
    listeners.length > 0 &&
    (!record || !canonicalAlive || !listeners.every((p) => matchesCanonical(p, record)));
  return {
    up,
    pid: primary ?? (canonicalAlive && record ? record.pid : null),
    ageSec: record ? ageSec(record.startedAt) : null,
    orphan,
    port,
    log: record?.log ?? `${LOG_DIR}/${name}.log`,
    listeners,
  };
}

/** True when local-stack introspection is allowed (Mac/dev). */
export function localStackEnabled(): boolean {
  return process.env.NODE_ENV === "development" || process.env.LOCAL_STACK_STATUS === "1";
}

export function getLocalStackStatus(): LocalStackStatus {
  if (!localStackEnabled()) {
    return {
      enabled: false,
      api: { up: false, pid: null, ageSec: null, orphan: false, port: API_PORT, log: "" },
      vite: { up: false, pid: null, ageSec: null, orphan: false, port: VITE_PORT, log: "" },
      orphans: [],
      hint: "./scripts/dev-down.sh",
      clean: false,
    };
  }

  const apiRaw = inspect("api", API_PORT, `http://127.0.0.1:${API_PORT}/api/healthz`);
  const viteRaw = inspect("vite", VITE_PORT, `http://127.0.0.1:${VITE_PORT}/`);

  const orphans: { pid: number; port: number; cmd: string }[] = [];
  const seen = new Set<number>();
  for (const [port, listeners, record] of [
    [API_PORT, apiRaw.listeners, readPidfile(`${LOG_DIR}/api.pid.json`)] as const,
    [VITE_PORT, viteRaw.listeners, readPidfile(`${LOG_DIR}/vite.pid.json`)] as const,
  ]) {
    for (const pid of listeners) {
      if (!matchesCanonical(pid, record) || !record || !alive(record.pid)) {
        if (seen.has(pid)) continue;
        seen.add(pid);
        orphans.push({ pid, port, cmd: cmdline(pid) });
      }
    }
  }

  const api: LocalStackService = {
    up: apiRaw.up,
    pid: apiRaw.pid,
    ageSec: apiRaw.ageSec,
    orphan: orphans.some((o) => o.port === API_PORT),
    port: apiRaw.port,
    log: apiRaw.log,
  };
  const vite: LocalStackService = {
    up: viteRaw.up,
    pid: viteRaw.pid,
    ageSec: viteRaw.ageSec,
    orphan: orphans.some((o) => o.port === VITE_PORT),
    port: viteRaw.port,
    log: viteRaw.log,
  };

  return {
    enabled: true,
    api,
    vite,
    orphans,
    hint: "./scripts/dev-down.sh",
    clean: api.up && vite.up && orphans.length === 0,
  };
}
