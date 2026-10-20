import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { codexSessionRecords } from "./codex-session-records.js";

type Activity = { t: string; agent: string; event: string; session: string; kind?: string; tool?: string; detail: string; source: string };
// Observe actual desktop records. Never run hooks or expose arguments/messages/results.
export function parseCodexActivity(header: string, tail: string, repo: string, now = Date.now()): Activity[] {
  let meta;
  try { const first = JSON.parse(header.split("\n")[0]); if (first.type === "session_meta") meta = first.payload; } catch { return []; }
  // Internal approval/guardian sessions must not masquerade as user work.
  if (!meta?.id || typeof meta.cwd !== "string" || resolve(meta.cwd) !== resolve(repo) || typeof meta.source !== "string") return [];
  const session = createHash("sha256").update(String(meta.id)).digest("hex").slice(0,20);
  const events: Activity[] = [];
  for (const line of tail.split("\n")) {
    try {
      const r = JSON.parse(line), p = r.payload;
      const t = Date.parse(r.timestamp);
      if (!p || !Number.isFinite(t) || t < now - 864e5 || t > now) continue;
      let event: string | undefined, kind: string | undefined, tool: string | undefined;
      if (r.type === "event_msg") {
        if (p.type === "task_started") event = "prompt";
        else if (["task_complete", "turn_aborted"].includes(p.type)) event = "stop";
        else if (p.type === "item_completed") {
          event = p.item?.type === "CommandExecution" && typeof p.item.exit_code === "number" && p.item.exit_code !== 0 ? "fail" : "activity";
        }
      } else if (r.type === "response_item" && ["function_call", "custom_tool_call"].includes(p.type)) {
        event = "tool";
        const name = String(p.name ?? "");
        kind = /apply_patch$/.test(name) ? "code" : /^(web\.run|web__run)$/.test(name) ? "web" : "other";
        // Classify a shell read by its leading executable only; discard the command itself.
        if (/exec_command$/.test(name)) {
          try { const args = JSON.parse(p.arguments); if (/^\s*(rg|cat|sed|head|tail|ls)\b/.test(args.cmd ?? "")) kind = "reading"; } catch { /* unknown tool input */ }
        }
        tool = kind === "code" ? "Edit" : kind === "reading" ? "Read" : "Codex tool";
      }
      if (event) events.push({ t: new Date(t).toISOString(), agent: "codex", event, session,
        ...(kind ? {kind, tool} : {}), detail: event === "tool" ? `${kind} tool invoked` : event === "prompt" ? "Working on the requested task" : event === "stop" ? "Turn ended" : "Processing the requested task", source: "codex-desktop" });
    } catch { /* truncated or unknown record */ }
  }
  return events;
}
export function codexActivity(repo: string, now = Date.now(), root?: string) {
  return codexSessionRecords(now,root).flatMap(r => parseCodexActivity(r.header,r.tail,repo,now))
    .sort((a,b)=>a.t.localeCompare(b.t)).slice(-500);
}

export function mergeCodexActivity<T extends {agent:string; event:string; session?:string; t:string; sub?:string}>(native: T[], desktop: T[], now=Date.now()): T[] {
  const lastMain = new Map<string | undefined,T>();
  for (const e of native) if (e.agent === "codex" && !e.sub && !e.event.startsWith("sub-") && Date.parse(e.t)<=now) {
    const previous=lastMain.get(e.session);if(!previous || e.t>previous.t)lastMain.set(e.session,e);
  }
  const resumed = new Set<string | undefined>();
  const observed = [...desktop].sort((a,b)=>a.t.localeCompare(b.t)).filter(e=>{
    const last=lastMain.get(e.session);
    if (!last) return true;
    if (e.t<=last.t) return false; // Native history is authoritative up to its latest main event.
    if (["tool","prompt","stop"].includes(e.event)) resumed.add(e.session);
    return last.event!=="waiting" || e.event!=="activity" || resumed.has(e.session);
  });
  return [...native,...observed].sort((a,b)=>a.t.localeCompare(b.t));
}
