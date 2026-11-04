import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOCK, LOG_DIR, PLAN_REVIEW_STAMP, ROOT } from "./constants.mjs";

function maybePlanReviews() {
  try { if (Date.now() - statSync(PLAN_REVIEW_STAMP).mtimeMs < 6 * 3600_000) return; } catch { /* never ran */ }
  try {
    writeFileSync(PLAN_REVIEW_STAMP, new Date().toISOString());
    const out = openSync(join(LOG_DIR, "plan-review.log"), "a");
    spawn("python3", [join(ROOT, "scripts/plan-review-queue.py")], { cwd: ROOT, detached: true, stdio: ["ignore", out, out] }).unref();
  } catch (e) { console.warn("[maintain] plan reviews not started:", e.message); }
}
function portOpen(port) {
  return spawnSync("/usr/bin/nc", ["-z", "-w", "2", "127.0.0.1", String(port)]).status === 0;
}

/** Workspace writes the live API proxy port here; often 9001 when 9000 is taken (lseg-data reads the same file). */
function lsegDesktopUp() {
  const home = process.env.HOME || "";
  const candidates = [
    join(home, "Library/Application Support/Data API Proxy/.portInUse"),
    join(home, "Library/Application Support/Eikon API proxy/.portInUse"),
    join(home, "Library/Application Support/Eikon Scripting Proxy/.portInUse"),
  ];
  const ports = [];
  for (const f of candidates) {
    try {
      const n = Number(String(readFileSync(f, "utf8")).trim().split(/\s+/)[0]);
      if (Number.isInteger(n) && n > 0 && n < 65536) ports.push(n);
    } catch { /* missing */ }
  }
  for (const p of [9000, 9001, 9060]) if (!ports.includes(p)) ports.push(p);
  return ports.some(portOpen);
}

function etDay(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function etHour(d = new Date()) {
  return Number(d.toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }));
}
function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}
/** Exclusive lock; a lock left by a dead process is taken over. Released on exit. */
function takeLock() {
  try {
    const pid = Number(readFileSync(LOCK, "utf8"));
    // Alive AND still a maintain run (lock lives in /tmp across reboots; a reused PID must not block the day).
    if (pid && pid !== process.pid && /maintain\.mjs/.test(sh(`ps -p ${pid} -o command=`))) return false;
  } catch { /* no lock */ }
  writeFileSync(LOCK, String(process.pid));
  process.on("exit", () => { try { if (Number(readFileSync(LOCK, "utf8")) === process.pid) unlinkSync(LOCK); } catch {} });
  return true;
}
/** Model List counts as done for the day only if daily.py built/skipped for a final reason — not "market not open yet". */
function modelListDoneToday(r) {
  if (!r || r.status !== 0) return false;
  const out = r.stdoutTail || "";
  if (/market closed/.test(out)) return etHour() >= 16;   // before the open → retry next slot; after the close → done
  return true;
}
/** Full 7 AM enrich pass — heal-only midday runs must not erase this. */
function isPtSunday(d = new Date()) {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(d);
  return wd === "Sun";
}

function isPtMonday(d = new Date()) {
  const wd = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(d);
  return wd === "Mon";
}
function notifyMac(title, body) {
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 200);
  try {
    execSync(
      `osascript -e 'display notification "${esc(body)}" with title "${esc(title)}"'`,
      { stdio: "ignore", timeout: 5000 },
    );
  } catch {
    /* headless / denied — ignore */
  }
}

function readPriorReport(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function samePtDay(isoA, isoB) {
  if (!isoA || !isoB) return false;
  const fmt = (iso) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  try {
    return fmt(isoA) === fmt(isoB);
  } catch {
    return false;
  }
}
function sh(cmd) {
  try {
    const pgBin = `${process.env.HOME}/Applications/Postgres.app/Contents/Versions/16/bin`;
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${pgBin}:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ""}`,
      },
    }).trim();
  } catch {
    return "";
  }
}

function listenerPid(port) {
  const out = sh(`/usr/sbin/lsof -tiTCP:${port} -sTCP:LISTEN`);
  if (!out) return null;
  return Number(out.split("\n")[0]) || null;
}

function procStartEpoch(pid) {
  if (!pid) return null;
  // macOS: ps -o lstart=
  const lstart = sh(`ps -p ${pid} -o lstart=`);
  if (!lstart) return null;
  const t = Date.parse(lstart);
  return Number.isFinite(t) ? t : null;
}

export {
  maybePlanReviews, portOpen, lsegDesktopUp, etDay, etHour, readJson, takeLock,
  modelListDoneToday, isPtSunday, isPtMonday, notifyMac, readPriorReport, samePtDay,
  sh, listenerPid, procStartEpoch,
};
