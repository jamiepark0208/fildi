/**
 * A209 P0 — turn summaries from hook events → ~/.fildi/agent-turns.jsonl
 * One turn = events from prompt → next prompt (or stop) within (agent, session).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";

export type LearnLiveEv = {
  t: string;
  agent: string;
  event: string;
  kind?: string;
  tool?: string;
  session?: string;
  detail?: string;
  sub?: string;
  sig?: string;
};

export type AgentTurn = {
  id: string;
  agent: string;
  session: string;
  t0: string;
  t1: string;
  wall_s: number;
  prompt: string;
  ask_id: string | null;
  in_tok: number | null;
  out_tok: number | null;
  cache_read: number | null;
  tools: number;
  reads: number;
  writes: number;
  bash: number;
  mcp: number;
  edits: number;
  oj_asks: number;
  unique_files: number;
  reread_same: number;
  loop_hits: number;
  fails: number;
  ship_checks: number;
  ship_ok: boolean | null;
  commits: number;
  outcome: "ok" | "fail" | "review" | "unknown";
};

const TURNS_PATH = () => join(homedir(), ".fildi/agent-turns.jsonl");
const RETAIN_MS = 14 * 864e5;

export function parseAskId(text: string): string | null {
  const m = text.match(/\bRefs?:\s*(A\d+)\b/i) || text.match(/\b(A\d{2,})\b/i);
  if (!m?.[1]) return null;
  const n = m[1].toUpperCase().replace(/^A/, "");
  return `A${n}`;
}

/** Pure: group live events into completed turns (prompt…stop / next prompt). */
export function buildTurnsFromEvents(events: LearnLiveEv[]): AgentTurn[] {
  const by = new Map<string, LearnLiveEv[]>();
  for (const e of events) {
    if (e.event === "session-start" || e.event === "session-end") continue;
    const key = `${e.agent}|${e.session ?? "_"}`;
    (by.get(key) ?? (by.set(key, []), by.get(key)!)).push(e);
  }
  const turns: AgentTurn[] = [];
  for (const [, raw] of by) {
    const evs = [...raw].sort((a, b) => a.t.localeCompare(b.t));
    let bucket: LearnLiveEv[] = [];
    const flush = (closed: boolean) => {
      if (!bucket.length) return;
      const prompt = bucket.find((e) => e.event === "prompt" && !e.sub);
      if (!prompt && !closed) { bucket = []; return; }
      const tools = bucket.filter((e) => e.event === "tool" || e.event === "edit" || e.event === "fail");
      const reads = tools.filter((e) => e.kind === "reading" || /^(Read|Grep|Glob|LS)$/i.test(e.tool ?? "")).length;
      const writes = tools.filter((e) => e.event === "edit" || e.kind === "code").length;
      const bash = tools.filter((e) => /bash|Shell|Terminal/i.test(e.tool ?? "")).length;
      const mcp = tools.filter((e) => /^mcp__/i.test(e.tool ?? "") || e.kind === "api").length;
      const edits = bucket.filter((e) => e.event === "edit").length;
      const fails = bucket.filter((e) => e.event === "fail").length;
      const oj = tools.filter((e) => /oj\.py|openjev/i.test(`${e.tool ?? ""} ${e.detail ?? ""}`)).length;
      const sigs = new Map<string, number>();
      for (const e of bucket) if (e.sig) sigs.set(e.sig, (sigs.get(e.sig) ?? 0) + 1);
      let loopHits = 0;
      for (const n of sigs.values()) if (n >= 5) loopHits += n;
      const fileHits = new Map<string, number>();
      for (const e of bucket) {
        const d = e.detail ?? "";
        const fm = d.match(/(?:^|[\s'"])((?:\/[\w./-]+|\.\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|mjs|py|md|json)))/);
        if (fm) fileHits.set(fm[1]!, (fileHits.get(fm[1]!) ?? 0) + 1);
      }
      let reread = 0;
      for (const n of fileHits.values()) if (n > 1) reread += n - 1;
      const promptText = (prompt?.detail ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const t0 = bucket[0]!.t;
      const t1 = bucket[bucket.length - 1]!.t;
      const wall = Math.max(0, (Date.parse(t1) - Date.parse(t0)) / 1000);
      const shipMentions = bucket.filter((e) => /ship-check|agent-ship-check/i.test(`${e.tool ?? ""} ${e.detail ?? ""}`));
      const shipFail = shipMentions.some((e) => e.event === "fail");
      const outcome: AgentTurn["outcome"] = fails > 0 ? "fail" : closed ? "ok" : "unknown";
      turns.push({
        id: `${bucket[0]!.agent}-${t0}`,
        agent: bucket[0]!.agent,
        session: bucket[0]!.session ?? "_",
        t0, t1, wall_s: Math.round(wall),
        prompt: promptText,
        ask_id: parseAskId(promptText),
        in_tok: null, out_tok: null, cache_read: null,
        tools: tools.length,
        reads, writes, bash, mcp, edits, oj_asks: oj,
        unique_files: fileHits.size,
        reread_same: reread,
        loop_hits: loopHits,
        fails,
        ship_checks: shipMentions.length,
        ship_ok: shipMentions.length ? !shipFail : null,
        commits: 0,
        outcome,
      });
      bucket = [];
    };
    for (const e of evs) {
      if (e.event === "prompt" && !e.sub) {
        flush(true);
        bucket = [e];
      } else {
        if (!bucket.length) bucket = [e];
        else bucket.push(e);
        if (e.event === "stop" || e.event === "waiting") flush(true);
      }
    }
    // open turn without stop — keep as unknown only if it had a prompt
    if (bucket.some((e) => e.event === "prompt")) flush(false);
  }
  return turns.sort((a, b) => b.t1.localeCompare(a.t1));
}

export function readTurns(sinceIso?: string, agent?: string): AgentTurn[] {
  const path = TURNS_PATH();
  if (!existsSync(path)) return [];
  const since = sinceIso ?? new Date(Date.now() - RETAIN_MS).toISOString();
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as AgentTurn]; } catch { return []; }
    }).filter((t) => t.t1 >= since && (!agent || t.agent === agent));
  } catch {
    return [];
  }
}

/** Upsert turns by id; trim >14d. */
export function persistTurns(turns: AgentTurn[]): number {
  if (!turns.length) return 0;
  const path = TURNS_PATH();
  mkdirSync(dirname(path), { recursive: true });
  const existing = new Map(readTurns().map((t) => [t.id, t]));
  let added = 0;
  for (const t of turns) {
    if (!existing.has(t.id)) added++;
    existing.set(t.id, t);
  }
  const cutoff = new Date(Date.now() - RETAIN_MS).toISOString();
  const kept = [...existing.values()].filter((t) => t.t1 >= cutoff).sort((a, b) => a.t1.localeCompare(b.t1));
  writeFileSync(path, kept.map((t) => JSON.stringify(t)).join("\n") + (kept.length ? "\n" : ""));
  return added;
}

export function flushTurnsFromLive(events: LearnLiveEv[]): { written: number; turns: AgentTurn[] } {
  const turns = buildTurnsFromEvents(events).filter((t) => t.tools >= 0 && t.prompt);
  const written = persistTurns(turns);
  return { written, turns };
}

export type LearnRollup = {
  agent: string;
  n: number;
  tok: number | null;
  acts_per_commit: number | null;
  loop_pct: number;
  fail_pct: number;
  oj_asks: number;
  ship_ok_rate: number | null;
};

export function rollups24h(turns: AgentTurn[]): LearnRollup[] {
  const day = new Date(Date.now() - 864e5).toISOString();
  const by = new Map<string, AgentTurn[]>();
  for (const t of turns.filter((x) => x.t1 >= day)) {
    (by.get(t.agent) ?? (by.set(t.agent, []), by.get(t.agent)!)).push(t);
  }
  return [...by.entries()].map(([agent, ts]) => {
    const n = ts.length;
    const fails = ts.filter((t) => t.fails > 0 || t.outcome === "fail").length;
    const loops = ts.filter((t) => t.loop_hits > 0).length;
    const ships = ts.filter((t) => t.ship_ok != null);
    const shipOk = ships.filter((t) => t.ship_ok).length;
    const commits = ts.reduce((a, t) => a + t.commits, 0);
    const acts = ts.reduce((a, t) => a + t.tools, 0);
    const tokVals = ts.map((t) => (t.in_tok ?? 0) + (t.out_tok ?? 0)).filter((x) => x > 0);
    return {
      agent, n,
      tok: tokVals.length ? tokVals.reduce((a, b) => a + b, 0) : null,
      acts_per_commit: commits > 0 ? Math.round((acts / commits) * 10) / 10 : null,
      loop_pct: n ? Math.round((loops / n) * 1000) / 10 : 0,
      fail_pct: n ? Math.round((fails / n) * 1000) / 10 : 0,
      oj_asks: ts.reduce((a, t) => a + t.oj_asks, 0),
      ship_ok_rate: ships.length ? Math.round((shipOk / ships.length) * 1000) / 10 : null,
    };
  });
}

export function wasteTop(turns: AgentTurn[], limit = 10): AgentTurn[] {
  return [...turns]
    .filter((t) => t.commits === 0 || t.ship_ok === false)
    .sort((a, b) => (b.tools + (b.out_tok ?? 0)) - (a.tools + (a.out_tok ?? 0)))
    .slice(0, limit);
}

/** Test helper — append one line (unused in prod). */
export function appendTurnForTest(turn: AgentTurn, path = TURNS_PATH()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(turn) + "\n");
}
