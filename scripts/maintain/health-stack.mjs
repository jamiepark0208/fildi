import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./constants.mjs";
import { sh } from "./utils.mjs";

function runHealth() {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/health-check.mjs"), "--json"], {
    encoding: "utf8",
    cwd: ROOT,
    env: process.env,
  });
  try {
    return JSON.parse(r.stdout || "{}");
  } catch {
    return { ok: false, parseError: true, stderr: (r.stderr || "").slice(0, 400) };
  }
}

function restartStack(reason, { ifDown = false } = {}) {
  // Synchronous: setTimeout-based relaunch never ran — maintain exits before the timer fires.
  // Prefer --if-down when only one process is missing so we don't kill a healthy API.
  const script = join(ROOT, "scripts/dev-restart.sh");
  const args = ifDown ? [script, "--if-down"] : [script];
  const r = spawnSync("bash", args, {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 120_000,
    env: process.env,
  });
  return {
    reason: ifDown ? `${reason}_if_down` : reason,
    status: r.status,
    stdoutTail: (r.stdout || "").slice(-500),
    stderrTail: (r.stderr || "").slice(-400),
  };
}

function processFlags(health) {
  const results = health?.results || [];
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  const PROCESS = new Set(["api_healthz", "vite", "postgres"]);
  return {
    processOk: typeof health?.processOk === "boolean"
      ? health.processOk
      : !failed.some((n) => PROCESS.has(n)),
    apiFail: failed.includes("api_healthz"),
    viteFail: failed.includes("vite"),
    pgFail: failed.includes("postgres"),
    processFailed: failed.filter((n) => PROCESS.has(n)),
    vendorFailed: failed.filter((n) => !PROCESS.has(n)),
  };
}

/** Heal local stack: prefer surgical --if-down, retry once, re-check process. */
function healLocalStack(health, actions) {
  const flags = processFlags(health);
  if (flags.processOk) return { health, restart: null, processOk: true };

  let restart = null;
  const bothDown = flags.apiFail && flags.viteFail;
  // Full sweep only when both web processes are down; otherwise keep the healthy one.
  restart = restartStack(
    bothDown ? "unhealthy_both" : flags.apiFail ? "unhealthy_api" : "unhealthy_vite",
    { ifDown: !bothDown },
  );
  actions.push(`restarted_stack_${restart.reason}_exit_${restart.status}`);

  let post = runHealth();
  let postFlags = processFlags(post);
  if (!postFlags.processOk) {
    const retry = restartStack("retry_if_down", { ifDown: true });
    actions.push(`restarted_stack_${retry.reason}_exit_${retry.status}`);
    restart = retry;
    // brief settle — vite sometimes needs a beat after spawn
    spawnSync("sleep", ["2"]);
    post = runHealth();
    postFlags = processFlags(post);
  }
  if (postFlags.processOk) {
    actions.push("process_healed");
  } else {
    actions.push(`process_still_down:${postFlags.processFailed.join("|") || "?"}`);
  }
  return { health: post, restart, processOk: postFlags.processOk };
}

/** @deprecated use restartStack — kept name for action log clarity */
function restartApi() {
  return restartStack("api_or_stack");
}

export { runHealth, restartStack, processFlags, healLocalStack, restartApi };
