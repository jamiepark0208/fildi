#!/usr/bin/env node
/**
 * Local Mac stack status / teardown (API :8080 + Vite :8081).
 *
 *   node scripts/local-stack.mjs status [--json]
 *   node scripts/local-stack.mjs down
 *
 * Pidfiles: /tmp/fildi-logs/{api,vite}.pid.json (written by dev-spawn.mjs)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const LOG_DIR = "/tmp/fildi-logs";
const API_PORT = Number(process.env.API_PORT || 8080);
const VITE_PORT = Number(process.env.VITE_PORT || 8081);

const SERVICES = [
  { name: "api", port: API_PORT, pidfile: `${LOG_DIR}/api.pid.json`, health: `http://127.0.0.1:${API_PORT}/api/healthz` },
  { name: "vite", port: VITE_PORT, pidfile: `${LOG_DIR}/vite.pid.json`, health: `http://127.0.0.1:${VITE_PORT}/` },
];

function readPidfile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function listenerPids(port) {
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

function cmdline(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function ageSec(startedAt) {
  if (!startedAt) return null;
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
}

function httpOk(url) {
  try {
    execFileSync("/usr/bin/curl", ["-sf", "-o", "/dev/null", "--max-time", "2", url], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Is listenerPid in the spawn tree of the pidfile leader? */
function matchesCanonical(listenerPid, record) {
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
    // Can't introspect (sandbox) — don't false-positive orphans when pidfile is alive
    return true;
  }
}

function inspectService(svc) {
  const record = readPidfile(svc.pidfile);
  const listeners = listenerPids(svc.port);
  const primary = listeners[0] ?? null;
  const canonicalAlive = record ? alive(record.pid) : false;
  const orphan =
    listeners.length > 0 &&
    (!record || !canonicalAlive || !listeners.every((p) => matchesCanonical(p, record)));
  // Also: pidfile dead but something on port, or multiple listeners
  const up = listeners.length > 0 && httpOk(svc.health);
  const pid = primary ?? (canonicalAlive ? record.pid : null);

  return {
    name: svc.name,
    port: svc.port,
    up,
    pid,
    ageSec: record ? ageSec(record.startedAt) : null,
    startedAt: record?.startedAt ?? null,
    log: record?.log ?? `${LOG_DIR}/${svc.name}.log`,
    pidfile: svc.pidfile,
    pidfileAlive: canonicalAlive,
    orphan,
    listeners,
    cmd: primary ? cmdline(primary) : record?.cmd ?? null,
  };
}

function collectOrphans(services) {
  const orphans = [];
  for (const s of services) {
    const record = readPidfile(s.pidfile);
    for (const pid of s.listeners) {
      if (!matchesCanonical(pid, record) || !record || !alive(record.pid)) {
        orphans.push({ pid, port: s.port, cmd: cmdline(pid) });
      }
    }
    // Extra listeners beyond the first when mismatched
  }
  // Dedupe by pid
  const seen = new Set();
  return orphans.filter((o) => {
    if (seen.has(o.pid)) return false;
    seen.add(o.pid);
    return true;
  });
}

export function getStatus() {
  const api = inspectService(SERVICES[0]);
  const vite = inspectService(SERVICES[1]);
  const orphans = collectOrphans([api, vite].map((s, i) => ({ ...SERVICES[i], listeners: s.listeners })));
  // Mark service.orphan if any orphan on its port
  const orphanPorts = new Set(orphans.map((o) => o.port));
  if (orphanPorts.has(api.port)) api.orphan = true;
  if (orphanPorts.has(vite.port)) vite.orphan = true;

  const clean = api.up && vite.up && orphans.length === 0 && !api.orphan && !vite.orphan;
  return {
    enabled: true,
    api: {
      up: api.up,
      pid: api.pid,
      ageSec: api.ageSec,
      orphan: Boolean(api.orphan),
      port: api.port,
      log: api.log,
    },
    vite: {
      up: vite.up,
      pid: vite.pid,
      ageSec: vite.ageSec,
      orphan: Boolean(vite.orphan),
      port: vite.port,
      log: vite.log,
    },
    orphans,
    hint: "./scripts/dev-down.sh",
    clean,
  };
}

function killPidTree(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

function killHard(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* */
    }
  }
}

export function bringDown() {
  const killed = [];
  for (const svc of SERVICES) {
    const record = readPidfile(svc.pidfile);
    if (record?.pid) {
      console.log(`Stopping ${svc.name} (pidfile pid=${record.pid} pgid=${record.pgid})...`);
      killPidTree(record.pgid || record.pid);
      killed.push(record.pid);
    }
    for (const pid of listenerPids(svc.port)) {
      console.log(`Stopping listener on :${svc.port} (pid=${pid})...`);
      killPidTree(pid);
      killed.push(pid);
    }
  }
  try {
    execFileSync("/bin/sleep", ["1"], { stdio: "ignore" });
  } catch {
    /* */
  }
  for (const svc of SERVICES) {
    for (const pid of listenerPids(svc.port)) {
      console.log(`Force-killing :${svc.port} pid=${pid}`);
      killHard(pid);
    }
    if (existsSync(svc.pidfile)) {
      try {
        unlinkSync(svc.pidfile);
      } catch {
        /* */
      }
    }
  }
  return { killed: [...new Set(killed)] };
}

function isFildiCmd(cmd) {
  return /\/fildi\/|Cursor\/fildi|artifacts\/(api-server|stock-compare)/.test(cmd || "");
}

function writePidfile(path, record) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(record, null, 2) + "\n");
}

function pgidOf(pid) {
  try {
    return Number(
      execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    return pid;
  }
}

/**
 * Heal without unnecessary restart:
 * - If port healthy but pidfile stale/mismatched → adopt listener into pidfile
 * - Kill extra fildi listeners / stale pidfile trees that aren't the live listener
 * - Return { needsRestart: true } only when a required service is down
 */
export function heal() {
  const actions = [];
  let needsRestart = false;

  for (const svc of SERVICES) {
    const listeners = listenerPids(svc.port);
    const healthy = listeners.length > 0 && httpOk(svc.health);
    const record = readPidfile(svc.pidfile);
    const primary = listeners[0] ?? null;

    if (!healthy) {
      console.log(`${svc.name}: DOWN on :${svc.port} — restart required`);
      actions.push(`${svc.name}_down`);
      needsRestart = true;
      continue;
    }

    // Kill extra listeners on the port (keep primary)
    for (const pid of listeners.slice(1)) {
      const cmd = cmdline(pid);
      if (isFildiCmd(cmd) || true) {
        console.log(`${svc.name}: killing extra listener pid=${pid}`);
        killPidTree(pid);
        actions.push(`${svc.name}_kill_extra_${pid}`);
      }
    }

    // Stale pidfile tree different from live listener → kill old tree only
    if (record?.pid && alive(record.pid) && primary && !matchesCanonical(primary, record)) {
      console.log(`${svc.name}: killing stale pidfile tree pid=${record.pid} (live=${primary})`);
      killPidTree(record.pgid || record.pid);
      actions.push(`${svc.name}_kill_stale_${record.pid}`);
      try {
        execFileSync("/bin/sleep", ["0.5"], { stdio: "ignore" });
      } catch {
        /* */
      }
    }

    // Adopt: rewrite pidfile to current listener
    const live = listenerPids(svc.port)[0] ?? primary;
    if (live) {
      const pgid = pgidOf(live);
      const next = {
        pid: live,
        pgid,
        port: svc.port,
        cmd: cmdline(live) || record?.cmd || "",
        cwd: record?.cwd || "",
        log: record?.log || `${LOG_DIR}/${svc.name}.log`,
        startedAt: record?.startedAt && matchesCanonical(live, record) ? record.startedAt : new Date().toISOString(),
        adoptedAt: new Date().toISOString(),
      };
      writePidfile(svc.pidfile, next);
      console.log(`${svc.name}: adopted pidfile → pid=${live} pgid=${pgid}`);
      actions.push(`${svc.name}_adopt_${live}`);
    }
  }

  // Sweep other fildi node processes listening on our ports only (already handled).
  // Broader sweep: fildi tsx/vite not attached to either port — leave alone (could be tests).

  const status = getStatus();
  return { actions, needsRestart, status };
}

function formatAge(sec) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${Math.floor((sec % 3600) / 60)}m`;
}

function printStatus(st) {
  const line = (label, s) => {
    const state = s.up ? "UP  " : "DOWN";
    const orphan = s.orphan ? " ORPHAN" : "";
    console.log(
      `${label.padEnd(5)} ${state}${orphan}  :${s.port}  pid=${s.pid ?? "—"}  age=${formatAge(s.ageSec)}  log=${s.log}`,
    );
  };
  line("API", st.api);
  line("Vite", st.vite);
  if (st.orphans.length) {
    console.log(`orphans: ${st.orphans.length}`);
    for (const o of st.orphans) {
      console.log(`  pid=${o.pid} port=${o.port}  ${o.cmd.slice(0, 100)}`);
    }
    console.log(`hint: ${st.hint}`);
  } else {
    console.log("orphans: 0");
  }
  console.log(st.clean ? "stack: clean" : "stack: needs attention");
}

const action = process.argv[2] || "status";
const asJson = process.argv.includes("--json");

if (action === "status") {
  const st = getStatus();
  if (asJson) console.log(JSON.stringify(st, null, 2));
  else printStatus(st);
  process.exit(st.clean ? 0 : 1);
} else if (action === "down") {
  const r = bringDown();
  console.log(`down complete (signaled ${r.killed.length} pids)`);
  const st = getStatus();
  if (asJson) console.log(JSON.stringify(st, null, 2));
  process.exit(st.api.up || st.vite.up ? 1 : 0);
} else if (action === "heal") {
  const r = heal();
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`heal actions: ${r.actions.join(", ") || "(none)"}`);
    printStatus(r.status);
    if (r.needsRestart) console.log("needsRestart: true — run ./scripts/dev-restart.sh");
  }
  process.exit(r.needsRestart || !r.status.clean ? 1 : 0);
} else {
  console.error("usage: node scripts/local-stack.mjs status|down|heal [--json]");
  process.exit(2);
}
