import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Play,
  Power,
  PowerOff,
  FileText,
  HelpCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { OpsNucleus, nucleusPulse, shortSummary, type NucleusPayload } from "./OpsNucleus";

type TaskRunner = "api-scheduler" | "launchd" | "supervised";
type TaskStatus =
  | "running"
  | "ok"
  | "warn"
  | "failed"
  | "idle"
  | "never"
  | "off"
  | "missing"
  | "waiting"
  | "degraded";
type TodayState = "pending" | "done" | "overdue" | "running" | "skipped" | "waiting" | "degraded";

interface ScheduledTask {
  id: string;
  name: string;
  summary: string;
  purpose: string;
  schedule: string;
  frequencyRank: number;
  frequency: string;
  lastRun: string | null;
  running: boolean;
  runner: TaskRunner;
  status: TaskStatus;
  canRun: boolean;
  canToggle: boolean;
  enabled: boolean;
  detail?: string | null;
  outcome?: string | null;
  logFiles: string[];
  dueToday: boolean;
  dueTimeLabel: string | null;
  dueMinutesPt: number | null;
  todayState: TodayState | null;
  verified?: boolean | null;
  verifyChecks?: { ok: boolean; label: string; fix?: string | null }[];
}

type OpsAlertSeverity = "critical" | "warn" | "info";

interface OpsAlert {
  id: string;
  severity: OpsAlertSeverity;
  title: string;
  detail: string;
  taskIds: string[];
  fix?: string | null;
}

interface InventoryRow {
  taskId: string;
  name: string;
  runner: TaskRunner;
  owner: string;
  writes: string[];
  mutex: string | null;
  cadence: string;
  enabled: boolean;
  status: TaskStatus;
  primary: boolean;
}

interface ScheduledTasksStatus {
  tasks: ScheduledTask[];
  today: ScheduledTask[];
  todayDate: string;
  todayLabel: string;
  generatedAt: number;
  legend?: Record<string, string>;
  summary?: {
    failed: number;
    warn: number;
    todayPending: number;
    todayDone: number;
    alertsCritical?: number;
    alertsWarn?: number;
  };
  inventory?: InventoryRow[];
  alerts?: OpsAlert[];
  nucleus?: NucleusPayload;
  enrichmentDisabled?: boolean;
  remediateLast?: {
    at: string;
    trigger: string;
    taskIds: string[];
    alertsBefore: number;
    alertsAfter: number | null;
    alertDelta: number | null;
    value: string;
    ok: boolean;
    actions: string[];
    note?: string;
  } | null;
  optionsChainSource?: {
    schwab: number;
    yahoo: number;
    total: number;
    schwabSharePct: number | null;
    schwabZeroBid?: number;
    yahooZeroBid?: number;
  };
  /** Weekly Mac resource snapshot (scripts/resource-audit.py, Jamie 10-16). */
  macResources?: {
    ts: string | null;
    diskFreeGb: number | null;
    fildiGb: number | null;
    growthMbPerWeek: number | null;
    ramFreePct: number | null;
    swapGb: number | null;
    findings: string[];
  } | null;
}

interface LogsResponse {
  id: string;
  name: string;
  logs: { path: string; exists: boolean; mtime: string | null; text: string }[];
}

const STATUS_DOT: Record<TaskStatus, string> = {
  running: "bg-amber-300 animate-pulse",
  ok: "bg-emerald-400",
  warn: "bg-amber-400",
  failed: "bg-red-400",
  idle: "bg-zinc-300",
  never: "bg-zinc-500",
  off: "bg-zinc-500",
  missing: "bg-red-400",
  waiting: "bg-sky-400",
  degraded: "bg-orange-400",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "Run",
  ok: "OK",
  warn: "Warn",
  failed: "Fail",
  idle: "Idle",
  never: "—",
  off: "Off",
  missing: "Miss",
  waiting: "Wait",
  degraded: "Weak",
};

const TODAY_DOT: Record<TodayState, string> = {
  pending: "bg-sky-400",
  done: "bg-emerald-400",
  overdue: "bg-red-400",
  running: "bg-amber-300 animate-pulse",
  skipped: "bg-zinc-500",
  waiting: "bg-sky-400",
  degraded: "bg-orange-400",
};

const TODAY_LABEL: Record<TodayState, string> = {
  pending: "Due",
  done: "Done",
  overdue: "Late",
  running: "Run",
  skipped: "Skip",
  waiting: "Wait",
  degraded: "Weak",
};

function shortName(name: string): string {
  return name
    .replace(/^Session regime(?:\s*·\s*.+)?$/i, "Regime")
    .replace(/^Session Regime$/i, "Regime")
    .replace(/^Mac Maintain · heal$/i, "Heal")
    .replace(/^Mac Maintain · full$/i, "Maintain")
    .replace(/^Mac Maintain$/i, "Maintain")
    .replace(/^Event Bullets$/i, "Bullets")
    .replace(/^Earnings History Backfill$/i, "Earnings")
    .replace(/^FMP Analyst Feed$/i, "FMP tape")
    .replace(/^Desk Commentary Ingest$/i, "Desk")
    .replace(/^Schwab Auth Health$/i, "Schwab")
    .replace(/^Research Ops Health$/i, "Research")
    .replace(/^LSEG Daily Sync$/i, "LSEG daily")
    .replace(/^LSEG Weekly Sync$/i, "LSEG weekly")
    .replace(/^WRDS Monthly IBES$/i, "WRDS IBES")
    .replace(/^WRDS Quarterly CRSP$/i, "WRDS CRSP")
    .replace(/^RH Portfolio Export$/i, "RH export")
    .replace(/^RH Portfolio Ingest$/i, "RH ingest")
    .replace(/^Option Score Snapshots$/i, "Opt scores")
    .replace(/^Model Snapshot$/i, "Model snap")
    .replace(/^Model Grade \+ Expiry$/i, "Model grade")
    .replace(/^Weekly Ops Digest$/i, "Ops digest")
    .replace(/^In-process Enrichment$/i, "API enrich")
    .replace(/ Snapshots?/i, "")
    .replace(/ Health$/i, "")
    .replace(/^In-process /i, "");
}

function shortLast(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function postAction(id: string, action: "run" | "enable" | "disable") {
  const res = await fetch(`/api/admin/scheduled-tasks/${id}/${action}`, {
    method: "POST",
    credentials: "include",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `${action} failed`);
  return body;
}

export function ScheduledTasksTab() {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogsResponse | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showInventory, setShowInventory] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery<ScheduledTasksStatus>({
    queryKey: ["admin", "scheduled-tasks"],
    queryFn: async () => {
      const res = await fetch("/api/admin/scheduled-tasks", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load scheduled tasks");
      return res.json();
    },
    staleTime: 0,
    refetchInterval: (q) => (q.state.data?.tasks.some((t) => t.running) ? 3000 : false),
  });

  const mutate = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "run" | "enable" | "disable" }) =>
      postAction(id, action),
    onSuccess: (_d, vars) => {
      setActionMsg(vars.action === "run" ? `Started ${vars.id}` : vars.action === "enable" ? `Enabled ${vars.id}` : `Disabled ${vars.id}`);
      void qc.invalidateQueries({ queryKey: ["admin", "scheduled-tasks"] });
      setTimeout(() => setActionMsg(null), 4000);
    },
    onError: (err: Error) => {
      setActionMsg(err.message);
      setTimeout(() => setActionMsg(null), 6000);
    },
  });

  const remediate = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/admin/ops/remediate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trigger: "manual-nucleus" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Remediate failed");
      return body as { ok: boolean; report: ScheduledTasksStatus["remediateLast"] };
    },
    onSuccess: (body) => {
      const r = body.report;
      const msg = r
        ? `Remediate ${r.value}${r.alertDelta != null ? ` · alerts Δ ${r.alertDelta}` : ""}`
        : "Remediate started";
      setActionMsg(msg);
      void qc.invalidateQueries({ queryKey: ["admin", "scheduled-tasks"] });
      setTimeout(() => setActionMsg(null), 6000);
    },
    onError: (err: Error) => {
      setActionMsg(err.message);
      setTimeout(() => setActionMsg(null), 6000);
    },
  });

  async function loadLogs(id: string) {
    setLogsLoading(true);
    try {
      const res = await fetch(`/api/admin/scheduled-tasks/${id}/logs`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load logs");
      setLogs(await res.json());
    } catch (e) {
      setActionMsg(e instanceof Error ? e.message : "log load failed");
    } finally {
      setLogsLoading(false);
    }
  }

  const busyId = mutate.isPending ? String((mutate.variables as { id?: string } | undefined)?.id ?? "") : null;
  const alertIssues = (data?.alerts ?? []).filter((a) => a.severity === "critical" || a.severity === "warn");
  const pulse = data?.nucleus ? nucleusPulse(data.nucleus) : null;

  return (
    <div className="max-w-3xl space-y-2 text-zinc-100">
      {/* Ops · NOMINAL · all clear · date · refresh — one line */}
      <div className="flex items-center gap-2 h-7 min-w-0">
        <h2 className="text-sm font-semibold text-white shrink-0">Ops</h2>
        {pulse && (
          <>
            <span className={cn("text-sm font-semibold shrink-0", pulse.className)}>{pulse.label}</span>
            <span className="text-[11px] text-zinc-200 shrink-0">{pulse.note}</span>
          </>
        )}
        {data?.todayLabel && <span className="text-[11px] text-zinc-300 truncate">· {data.todayLabel}</span>}
        {data?.enrichmentDisabled === false && (
          <span className="text-[10px] font-semibold text-amber-300 shrink-0">enrich ON</span>
        )}
        <div className="flex items-center gap-1 ml-auto shrink-0">
          {data?.legend && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="h-6 w-6 inline-flex items-center justify-center rounded border border-zinc-600 text-zinc-200 hover:text-white cursor-pointer"
                  aria-label="Legend"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-60 p-2 text-xs bg-zinc-900 border-zinc-600 text-zinc-100 space-y-1" align="end">
                {(Object.keys(STATUS_LABEL) as TaskStatus[]).map((k) =>
                  data.legend?.[k] ? (
                    <div key={k} className="flex gap-1.5">
                      <span className={cn("mt-1 w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[k])} />
                      <span>
                        <b className="text-white">{STATUS_LABEL[k]}</b> {shortSummary(data.legend[k], 40)}
                      </span>
                    </div>
                  ) : null,
                )}
              </PopoverContent>
            </Popover>
          )}
          <button
            type="button"
            onClick={() => remediate.mutate()}
            disabled={remediate.isPending || mutate.isPending}
            className="h-6 inline-flex items-center gap-1 text-[11px] font-medium text-zinc-950 bg-[#d4af37] rounded px-2 hover:bg-[#e0c04a] disabled:opacity-50 cursor-pointer"
            title="Safe whitelist only: Maintain / stack heal / regime"
          >
            <Play className="w-3 h-3" />
            Remediate
          </button>
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-6 inline-flex items-center gap-1 text-[11px] font-medium text-white border border-zinc-600 rounded px-2 hover:border-[#d4af37] hover:text-[#d4af37] disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
            Sync
          </button>
        </div>
      </div>

      {actionMsg && (
        <p className="text-[11px] text-white border border-zinc-600 rounded px-2 py-1 bg-zinc-900">{actionMsg}</p>
      )}

      {isLoading ? (
        <p className="text-xs text-zinc-300 animate-pulse">Loading…</p>
      ) : (
        <>
          {data?.nucleus && (
            <OpsNucleus
              hidePulse
              nucleus={data.nucleus}
              onRun={(id) => mutate.mutate({ id, action: "run" })}
              onLogs={(id) => {
                setExpanded(id);
                setShowCatalog(true);
                void loadLogs(id);
              }}
              busyId={busyId}
            />
          )}

          {data?.macResources && (
            <div className="flex items-center gap-1.5 text-[11px] text-zinc-200">
              <span>
                Mac: disk {data.macResources.diskFreeGb != null ? `${Math.round(data.macResources.diskFreeGb)} GB free` : "—"}
                {" · "}fildi {data.macResources.fildiGb ?? "—"} GB
                {data.macResources.growthMbPerWeek != null ? ` (+${data.macResources.growthMbPerWeek} MB/wk)` : ""}
                {" · "}RAM free {data.macResources.ramFreePct ?? "—"}%
              </span>
              <Popover>
                <PopoverTrigger asChild>
                  <button type="button" aria-label="Mac resource findings" className="text-zinc-400 hover:text-zinc-100">
                    <HelpCircle className="h-3 w-3" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-96 p-2 text-xs bg-zinc-900 border-zinc-600 text-zinc-100 space-y-1" align="start">
                  <p className="text-zinc-300">
                    Weekly audit (Maintain, Sunday; scripts/resource-audit.py) · fildi = repo + DB · swap {data.macResources.swapGb ?? "—"} GB
                    {data.macResources.ts ? ` · as of ${data.macResources.ts.slice(0, 10)}` : ""}
                  </p>
                  {data.macResources.findings.map((f, i) => (
                    <p key={i}>• {f}</p>
                  ))}
                </PopoverContent>
              </Popover>
            </div>
          )}

          {data?.remediateLast && (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded border border-zinc-600 px-2 py-1 text-[11px]">
              <span className="font-semibold text-white shrink-0">Last remediate</span>
              <span
                className={cn(
                  "font-semibold shrink-0",
                  data.remediateLast.value === "IMPROVED"
                    ? "text-emerald-400"
                    : data.remediateLast.value === "FAILED" || data.remediateLast.value === "NEEDS_YOU"
                      ? "text-amber-300"
                      : "text-zinc-200",
                )}
              >
                {data.remediateLast.value}
              </span>
              <span className="text-zinc-300 truncate">
                {data.remediateLast.trigger}
                {data.remediateLast.taskIds?.length
                  ? ` · ${data.remediateLast.taskIds.join(", ")}`
                  : ""}
                {data.remediateLast.alertsBefore >= 0 && data.remediateLast.alertsAfter != null
                  ? ` · alerts ${data.remediateLast.alertsBefore}→${data.remediateLast.alertsAfter}`
                  : ""}
                {data.remediateLast.actions?.length
                  ? ` · ${shortSummary(data.remediateLast.actions.slice(0, 3).join(", "), 48)}`
                  : ""}
              </span>
              <span className="text-zinc-400 font-mono ml-auto shrink-0">
                {new Date(data.remediateLast.at).toLocaleString([], {
                  month: "numeric",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </span>
            </div>
          )}

          {alertIssues.length > 0 && (
            <div className="rounded border border-zinc-600 overflow-hidden divide-y divide-zinc-700">
              {alertIssues.slice(0, 4).map((a) => (
                <div
                  key={a.id}
                  className={cn(
                    "flex items-baseline gap-2 px-2 py-1 border-l-2",
                    a.severity === "critical" ? "border-l-red-400" : "border-l-amber-400",
                  )}
                >
                  <span className="text-[10px] font-bold uppercase text-white shrink-0">{a.severity}</span>
                  <span className="text-[11px] text-white truncate flex-1" title={a.detail}>
                    {a.title}
                    {a.fix ? ` — ${shortSummary(a.fix, 36)}` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Today */}
          <section className="rounded border border-zinc-600 bg-zinc-950 overflow-hidden">
            <div className="flex items-center gap-2 h-7 px-2 border-b border-zinc-700">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-white">Today</span>
              {data?.summary && (
                <span className="text-[11px] text-zinc-200 tabular-nums">
                  {data.summary.todayDone}/{data.summary.todayDone + data.summary.todayPending}
                </span>
              )}
            </div>
            <div className="divide-y divide-zinc-800">
              {(data?.today ?? []).length === 0 ? (
                <p className="text-[11px] text-zinc-200 px-2 py-1.5">Nothing due.</p>
              ) : (
                (data?.today ?? []).map((task) => (
                  <TodayRow
                    key={`today-${task.id}`}
                    task={task}
                    onRun={() => mutate.mutate({ id: task.id, action: "run" })}
                    busy={busyId === task.id}
                  />
                ))
              )}
            </div>
          </section>

          <section className="rounded border border-zinc-600 bg-zinc-950 overflow-hidden">
            <button
              type="button"
              onClick={() => setShowCatalog((v) => !v)}
              className="w-full flex items-center gap-1.5 h-7 px-2 text-left hover:bg-zinc-900 cursor-pointer"
            >
              {showCatalog ? <ChevronDown className="w-3.5 h-3.5 text-zinc-300" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-300" />}
              <span className="text-[11px] font-semibold uppercase tracking-wide text-white">Tasks</span>
              <span className="text-[11px] text-zinc-200 ml-auto tabular-nums">{data?.tasks?.length ?? 0}</span>
            </button>
            {showCatalog && (
              <TaskList
                tasks={data?.tasks ?? []}
                inventory={data?.inventory ?? []}
                expanded={expanded}
                setExpanded={setExpanded}
                mutate={mutate}
                loadLogs={loadLogs}
                logsLoading={logsLoading}
                busyId={busyId}
              />
            )}
          </section>

          {(data?.inventory?.length ?? 0) > 0 && (
            <section className="rounded border border-zinc-600 bg-zinc-950 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowInventory((v) => !v)}
                className="w-full flex items-center gap-1.5 h-7 px-2 text-left hover:bg-zinc-900 cursor-pointer"
              >
                {showInventory ? <ChevronDown className="w-3.5 h-3.5 text-zinc-300" /> : <ChevronRight className="w-3.5 h-3.5 text-zinc-300" />}
                <span className="text-[11px] font-semibold uppercase tracking-wide text-white">Writers</span>
                <span className="text-[11px] text-zinc-200 ml-auto tabular-nums">{data!.inventory!.length}</span>
              </button>
              {showInventory && (
                <div className="divide-y divide-zinc-800 max-h-48 overflow-auto border-t border-zinc-700">
                  {data!.inventory!.map((r) => (
                    <div key={r.taskId} className="flex items-center gap-2 h-7 px-2 text-[11px]">
                      <span className="text-white font-medium w-28 shrink-0 truncate">{shortName(r.name)}</span>
                      <span className="text-zinc-200 truncate flex-1" title={r.writes.join(" · ")}>
                        {shortSummary(r.writes.join(" · "), 52)}
                      </span>
                      <span className="inline-flex items-center gap-1 text-zinc-100 shrink-0">
                        <span className={cn("w-1.5 h-1.5 rounded-full", STATUS_DOT[r.status])} />
                        {STATUS_LABEL[r.status]}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </>
      )}

      {logs && (
        <div className="rounded border border-zinc-600 bg-zinc-950 p-2 space-y-1.5">
          <div className="flex items-center gap-2 h-6">
            <span className="text-[11px] font-semibold text-white truncate">Logs · {logs.name}</span>
            <button type="button" className="ml-auto text-[11px] text-zinc-200 hover:text-white cursor-pointer" onClick={() => setLogs(null)}>
              Close
            </button>
          </div>
          {logs.logs.map((log) => (
            <pre
              key={log.path}
              className="text-[11px] leading-snug text-zinc-100 bg-black border border-zinc-700 rounded p-1.5 max-h-36 overflow-auto whitespace-pre-wrap break-all"
            >
              {log.text || "(empty)"}
            </pre>
          ))}
        </div>
      )}
    </div>
  );
}

function TodayRow({ task, onRun, busy }: { task: ScheduledTask; onRun: () => void; busy: boolean }) {
  const state = task.todayState ?? "pending";
  // Prefer lean/outcome (e.g. Bull 72% / 0%) over verify fix essays.
  const hint = task.outcome
    ? shortSummary(task.outcome, 40)
    : state !== "done" && state !== "skipped" && (task.verifyChecks ?? []).some((c) => !c.ok)
      ? shortSummary(
          (task.verifyChecks ?? []).find((c) => !c.ok)?.label ?? "",
          40,
        ) || null
      : null;

  return (
    <div className="flex items-center gap-2 h-7 px-2 hover:bg-zinc-900">
      <span className="font-mono text-[11px] text-zinc-200 w-[3.75rem] shrink-0 tabular-nums">
        {(task.dueTimeLabel ?? "—").replace(/\s*PT$/i, "").replace(":00 ", "").replace(" ", "")}
      </span>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="min-w-0 flex-1 text-left cursor-pointer truncate">
            <span className="text-[11px] font-medium text-white hover:text-[#d4af37]">
              {shortName(task.name)}
              {hint ? <span className="text-zinc-200 font-normal"> · {hint}</span> : null}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-2 text-xs bg-zinc-900 border-zinc-600 text-zinc-100" align="start">
          <p>{shortSummary(task.purpose, 180)}</p>
        </PopoverContent>
      </Popover>
      <span className="inline-flex items-center gap-1 text-[11px] text-zinc-100 w-12 shrink-0">
        <span className={cn("w-1.5 h-1.5 rounded-full", TODAY_DOT[state])} />
        {TODAY_LABEL[state]}
      </span>
      {task.canRun && state !== "skipped" ? (
        <button
          type="button"
          disabled={busy || task.running}
          onClick={onRun}
          className="h-5 w-5 inline-flex items-center justify-center rounded bg-[#d4af37]/20 text-[#d4af37] disabled:opacity-40 cursor-pointer shrink-0"
          title="Run"
        >
          <Play className="w-3 h-3" />
        </button>
      ) : (
        <span className="w-5 shrink-0" />
      )}
    </div>
  );
}

function TaskList({
  tasks,
  inventory,
  expanded,
  setExpanded,
  mutate,
  loadLogs,
  logsLoading,
  busyId,
}: {
  tasks: ScheduledTask[];
  inventory: InventoryRow[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  mutate: { mutate: (v: { id: string; action: "run" | "enable" | "disable" }) => void };
  loadLogs: (id: string) => void;
  logsLoading: boolean;
  busyId: string | null;
}) {
  const invById = new Map(inventory.map((r) => [r.taskId, r]));
  return (
    <div className="divide-y divide-zinc-800 border-t border-zinc-700">
      {tasks.map((task) => {
        const open = expanded === task.id;
        const busy = busyId === task.id;
        const inv = invById.get(task.id);
        const line =
          task.outcome && (task.status === "ok" || task.todayState === "done")
            ? shortSummary(task.outcome, 36)
            : shortSummary(task.summary, 36);
        return (
          <div key={task.id}>
            <div className="flex items-center gap-1.5 h-7 px-1.5 hover:bg-zinc-900">
              <button
                type="button"
                className="text-zinc-300 hover:text-white cursor-pointer shrink-0"
                onClick={() => setExpanded(open ? null : task.id)}
              >
                {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              </button>
              <button
                type="button"
                className="min-w-0 flex-1 text-left cursor-pointer truncate"
                onClick={() => setExpanded(open ? null : task.id)}
              >
                <span className="text-[11px] font-medium text-white">{shortName(task.name)}</span>
                <span className="text-[11px] text-zinc-200"> · {line}</span>
              </button>
              <span className="text-[10px] uppercase text-zinc-200 w-8 text-right shrink-0">{task.frequency}</span>
              <span className="inline-flex items-center gap-1 text-[11px] text-zinc-100 w-10 shrink-0">
                <span className={cn("w-1.5 h-1.5 rounded-full", STATUS_DOT[task.status])} />
                {STATUS_LABEL[task.status]}
              </span>
              <span className="text-[10px] font-mono text-zinc-200 w-[4.5rem] text-right shrink-0">{shortLast(task.lastRun)}</span>
              {task.canRun ? (
                <button
                  type="button"
                  disabled={busy || task.running || task.status === "off"}
                  onClick={() => mutate.mutate({ id: task.id, action: "run" })}
                  className="text-[#d4af37] disabled:opacity-40 cursor-pointer shrink-0"
                >
                  <Play className="w-3 h-3" />
                </button>
              ) : (
                <span className="w-3 shrink-0" />
              )}
            </div>
            {open && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-2 py-1.5 ml-5 border-t border-zinc-800 bg-zinc-900/60 text-[11px]">
                <span className="text-zinc-100">{shortSummary(task.purpose, 100)}</span>
                {inv && <span className="text-zinc-200">writes {shortSummary(inv.writes.join(", "), 40)}</span>}
                {(task.verifyChecks ?? []).slice(0, 3).map((c) => (
                  <span key={c.label} className={c.ok ? "text-emerald-400" : "text-red-400"}>
                    {c.ok ? "✓" : "✗"} {shortSummary(c.label, 28)}
                  </span>
                ))}
                <span className="flex gap-1 ml-auto">
                  {task.canToggle && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => mutate.mutate({ id: task.id, action: task.enabled ? "disable" : "enable" })}
                      className="inline-flex items-center gap-0.5 h-6 px-1.5 rounded border border-zinc-500 text-zinc-100 cursor-pointer"
                    >
                      {task.enabled ? <PowerOff className="w-3 h-3" /> : <Power className="w-3 h-3" />}
                      {task.enabled ? "Off" : "On"}
                    </button>
                  )}
                  {task.logFiles.length > 0 && (
                    <button
                      type="button"
                      disabled={logsLoading}
                      onClick={() => void loadLogs(task.id)}
                      className="inline-flex items-center gap-0.5 h-6 px-1.5 rounded border border-zinc-500 text-zinc-100 cursor-pointer"
                    >
                      <FileText className="w-3 h-3" /> Logs
                    </button>
                  )}
                </span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
