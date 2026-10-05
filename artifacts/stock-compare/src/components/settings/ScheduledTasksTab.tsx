import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw, Play, Power, PowerOff, FileText } from "lucide-react";
import { cn } from "@/lib/utils";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

type TaskRunner = "api-scheduler" | "launchd" | "supervised";
type TaskStatus = "running" | "ok" | "warn" | "failed" | "idle" | "never" | "off" | "missing" | "waiting" | "degraded";
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
  logFiles: string[];
  dueToday: boolean;
  dueTimeLabel: string | null;
  dueMinutesPt: number | null;
  todayState: TodayState | null;
  verified?: boolean | null;
  verifyChecks?: { ok: boolean; label: string; fix?: string | null }[];
}

interface ScheduledTasksStatus {
  tasks: ScheduledTask[];
  today: ScheduledTask[];
  todayDate: string;
  todayLabel: string;
  generatedAt: number;
  legend?: Record<string, string>;
  summary?: { failed: number; warn: number; todayPending: number; todayDone: number };
}

interface LogsResponse {
  id: string;
  name: string;
  logs: { path: string; exists: boolean; mtime: string | null; text: string }[];
}

const STATUS_STYLE: Record<TaskStatus, string> = {
  running: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  ok: "bg-green-500/15 text-green-400 border-green-500/30",
  warn: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  failed: "bg-red-500/15 text-red-400 border-red-500/30",
  idle: "bg-yellow-500/10 text-yellow-300 border-yellow-500/25",
  never: "bg-zinc-800 text-zinc-400 border-zinc-700",
  off: "bg-zinc-800/60 text-zinc-500 border-zinc-700",
  missing: "bg-red-500/15 text-red-400 border-red-500/30",
  waiting: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  degraded: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  running: "Running",
  ok: "OK",
  warn: "Warn",
  failed: "Failed",
  idle: "Idle",
  never: "Never",
  off: "Off",
  missing: "Not loaded",
  waiting: "Waiting",
  degraded: "Degraded",
};

const TODAY_STYLE: Record<TodayState, string> = {
  pending: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  done: "bg-green-500/15 text-green-400 border-green-500/30",
  overdue: "bg-red-500/15 text-red-400 border-red-500/30",
  running: "bg-yellow-500/15 text-yellow-400 border-yellow-500/30",
  skipped: "bg-zinc-800 text-zinc-500 border-zinc-700",
  waiting: "bg-sky-500/15 text-sky-300 border-sky-500/30",
  degraded: "bg-orange-500/15 text-orange-300 border-orange-500/30",
};

const TODAY_LABEL: Record<TodayState, string> = {
  pending: "Pending",
  done: "Done",
  overdue: "Overdue",
  running: "Running",
  skipped: "Skipped",
  waiting: "Waiting",
  degraded: "Degraded",
};

function runnerLabel(runner: TaskRunner, short = false): string {
  if (runner === "launchd") return short ? "Mac" : "LaunchAgent (Mac)";
  if (runner === "supervised") return short ? "You" : "Supervised (Claude / you)";
  return short ? "API" : "API scheduler";
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

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 max-w-4xl space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Scheduled Tasks</h2>
        <div className="flex items-center gap-2">
          {data?.legend && (
            <div className="hidden sm:flex items-center gap-1">
              {(["ok", "idle", "waiting", "warn", "degraded", "failed", "never", "off"] as TaskStatus[]).map((k) => (
                <Popover key={k}>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className={cn("text-[9px] font-semibold px-1.5 py-0.5 rounded border cursor-help", STATUS_STYLE[k])}
                    >
                      {STATUS_LABEL[k]}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-52 p-2 text-[11px] bg-zinc-900 border-zinc-600/40 text-amber-100/90" side="bottom">
                    {data.legend?.[k]}
                  </PopoverContent>
                </Popover>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs text-amber-200/50 hover:text-white border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
          >
            <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
            Refresh
          </button>
        </div>
      </div>

      {actionMsg && (
        <p className="text-[11px] text-amber-200/70 border border-[#d4af37]/20 rounded px-2 py-1 bg-black/40">{actionMsg}</p>
      )}

      {isLoading ? (
        <p className="text-xs text-amber-200/40 animate-pulse">Loading…</p>
      ) : (
        <>
          <section>
            <h3 className="text-[10px] font-semibold text-amber-200/45 uppercase tracking-wider mb-1">
              Today · {data?.todayLabel ?? ""}
              {data?.summary && (
                <span className="ml-2 font-normal normal-case tracking-normal text-amber-200/35">
                  {data.summary.todayDone} done · {data.summary.todayPending} left
                </span>
              )}
            </h3>
            <div className="rounded-md border border-[#d4af37]/25 overflow-hidden">
              <div className="flex items-center gap-2 px-2.5 py-1 bg-zinc-950 border-b border-zinc-800 text-[9px] uppercase tracking-wider text-amber-200/35">
                <span className="w-[7.5rem] shrink-0">Time</span>
                <span className="flex-1 min-w-0">Task</span>
                <span className="w-10 shrink-0">Who</span>
                <span className="w-[4.5rem] shrink-0 text-center">Today</span>
                <span className="w-6 shrink-0" />
              </div>
              <div className="divide-y divide-zinc-800">
                {(data?.today ?? []).length === 0 ? (
                  <p className="text-[11px] text-amber-200/40 px-2.5 py-2">Nothing scheduled today.</p>
                ) : (
                  (data?.today ?? []).map((task) => (
                    <TodayRow key={`today-${task.id}`} task={task} onRun={() => mutate.mutate({ id: task.id, action: "run" })} busy={busyId === task.id} />
                  ))
                )}
              </div>
            </div>
          </section>

          <section>
            <h3 className="text-[10px] font-semibold text-amber-200/45 uppercase tracking-wider mb-1">
              All tasks · by frequency
            </h3>
            <TaskList
              tasks={data?.tasks ?? []}
              expanded={expanded}
              setExpanded={setExpanded}
              mutate={mutate}
              loadLogs={loadLogs}
              logsLoading={logsLoading}
              busyId={busyId}
            />
          </section>
        </>
      )}

      {logs && (
        <div className="rounded-md border border-[#d4af37]/25 bg-black/50 p-2 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-[11px] font-semibold text-[#d4af37]/80 uppercase tracking-wide">Logs — {logs.name}</h4>
            <button type="button" className="text-[10px] text-amber-200/50 hover:text-white" onClick={() => setLogs(null)}>
              Close
            </button>
          </div>
          {logs.logs.map((log) => (
            <div key={log.path}>
              <div className="text-[10px] text-amber-200/40 font-mono truncate mb-0.5">
                {log.path}
                {log.mtime ? ` · ${new Date(log.mtime).toLocaleString()}` : ""}
                {!log.exists ? " · missing" : ""}
              </div>
              <pre className="text-[10px] leading-snug text-amber-100/70 bg-zinc-950 border border-zinc-800 rounded p-2 max-h-48 overflow-auto whitespace-pre-wrap break-all">
                {log.text || "(empty)"}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TodayRow({ task, onRun, busy }: { task: ScheduledTask; onRun: () => void; busy: boolean }) {
  const state = task.todayState ?? "pending";
  const failedChecks = (task.verifyChecks ?? []).filter((c) => !c.ok);
  return (
    <div className="px-2.5 py-1.5 bg-zinc-900/70 space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-amber-200/45 w-[7.5rem] shrink-0">{task.dueTimeLabel ?? "—"}</span>
        <Popover>
          <PopoverTrigger asChild>
            <button type="button" className="flex-1 min-w-0 text-left">
              <span className="text-xs font-medium text-white underline decoration-dotted decoration-amber-200/40 underline-offset-2">
                {task.name}
              </span>
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2.5 text-[11px] bg-zinc-900 border-zinc-600/40 text-amber-100/90" align="start">
            <p>{task.purpose}</p>
            {(task.verifyChecks?.length ?? 0) > 0 && (
              <ul className="mt-2 space-y-1 border-t border-zinc-700/50 pt-2">
                {task.verifyChecks!.map((c) => (
                  <li key={c.label} className={c.ok ? "text-emerald-300/80" : "text-red-300/90"}>
                    {c.ok ? "✓" : "✗"} {c.label}
                    {!c.ok && c.fix ? <span className="block text-amber-200/50 pl-3">Fix: {c.fix}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
        <span className="text-[9px] uppercase tracking-wide text-amber-200/30 w-10 shrink-0">
          {runnerLabel(task.runner, true)}
        </span>
        <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border shrink-0", TODAY_STYLE[state])}>
          {TODAY_LABEL[state]}
        </span>
        {task.canRun && state !== "skipped" ? (
          <button
            type="button"
            disabled={busy || task.running}
            onClick={onRun}
            className="text-[10px] px-1.5 py-0.5 rounded border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 shrink-0"
            title="Run now"
          >
            <Play className="w-3 h-3" />
          </button>
        ) : (
          <span className="w-6 shrink-0" />
        )}
      </div>
      {failedChecks.length > 0 && state !== "done" && state !== "skipped" && (
        <p className="text-[10px] text-red-300/70 pl-[7.5rem]">
          {failedChecks[0].fix ?? failedChecks[0].label}
        </p>
      )}
    </div>
  );
}

function TaskList({
  tasks,
  expanded,
  setExpanded,
  mutate,
  loadLogs,
  logsLoading,
  busyId,
}: {
  tasks: ScheduledTask[];
  expanded: string | null;
  setExpanded: (id: string | null) => void;
  mutate: { mutate: (v: { id: string; action: "run" | "enable" | "disable" }) => void };
  loadLogs: (id: string) => void;
  logsLoading: boolean;
  busyId: string | null;
}) {
  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden">
      <div className="flex items-center gap-1 px-2 py-1 bg-zinc-950 border-b border-zinc-800 text-[9px] uppercase tracking-wider text-amber-200/35">
        <span className="w-6 shrink-0" />
        <span className="flex-1 min-w-0 px-1">Task</span>
        <div className="flex items-center gap-1.5 px-2 shrink-0">
          <span className="w-14 text-right">Freq</span>
          <span className="w-[3.5rem] text-center">Status</span>
          <span className="w-[4.5rem] text-right">Last run</span>
        </div>
      </div>
      <div className="divide-y divide-zinc-800">
        {tasks.map((task) => {
          const open = expanded === task.id;
          const busy = busyId === task.id;
          return (
            <div key={task.id} className="bg-zinc-900/70">
              <div className="flex items-stretch gap-1">
                <button
                  type="button"
                  className="px-1.5 text-amber-200/40 hover:text-[#d4af37] shrink-0"
                  onClick={() => setExpanded(open ? null : task.id)}
                  aria-label={open ? "Collapse" : "Expand"}
                >
                  {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                </button>

                <Popover>
                  <PopoverTrigger asChild>
                    <button type="button" className="flex-1 min-w-0 text-left px-1 py-1.5 hover:bg-amber-500/5">
                      <div className="font-medium text-white text-xs underline decoration-dotted decoration-amber-200/40 underline-offset-2 truncate">
                        {task.name}
                      </div>
                      <div className="text-[10px] text-amber-200/40 truncate">{task.summary}</div>
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-72 p-2.5 text-[11px] bg-zinc-900 border-zinc-600/40 text-amber-100/90" align="start">
                    <p>{task.purpose}</p>
                    <p className="mt-1.5 text-amber-200/45">
                      {task.frequency} · {runnerLabel(task.runner)}
                    </p>
                  </PopoverContent>
                </Popover>

                <div className="flex items-center gap-1.5 px-2 shrink-0">
                  <span className="text-[9px] uppercase tracking-wide text-amber-200/30 w-14 text-right">{task.frequency}</span>
                  <span className={cn("text-[10px] font-semibold px-1.5 py-0.5 rounded border", STATUS_STYLE[task.status])}>
                    {STATUS_LABEL[task.status]}
                  </span>
                  <span className="text-[10px] text-amber-200/40 whitespace-nowrap w-[4.5rem] text-right">
                    {task.lastRun
                      ? new Date(task.lastRun).toLocaleString([], { month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit" })
                      : "—"}
                  </span>
                </div>
              </div>

              {open && (
                <div className="px-3 pb-2.5 pt-0.5 space-y-2 border-t border-zinc-800/80 bg-black/30">
                  <p className="text-[11px] text-amber-200/70">{task.purpose}</p>
                  <p className="text-[10px] text-amber-200/40">
                    {task.schedule}
                    {" · "}
                    {runnerLabel(task.runner)}
                  </p>
                  {task.detail && (
                    <p className="text-[10px] text-amber-200/50 font-mono">{task.detail}</p>
                  )}
                  {(task.verifyChecks?.length ?? 0) > 0 && (
                    <ul className="text-[10px] space-y-1">
                      {task.verifyChecks!.map((c) => (
                        <li key={c.label} className={c.ok ? "text-emerald-300/80" : "text-red-300/90"}>
                          {c.ok ? "✓" : "✗"} {c.label}
                          {!c.ok && c.fix ? <span className="block text-amber-200/50 pl-3">Fix: {c.fix}</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {task.canRun && (
                      <button
                        type="button"
                        disabled={busy || task.running || task.status === "off"}
                        onClick={() => mutate.mutate({ id: task.id, action: "run" })}
                        className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40"
                      >
                        <Play className="w-3 h-3" /> Run now
                      </button>
                    )}
                    {task.canToggle && task.enabled && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => mutate.mutate({ id: task.id, action: "disable" })}
                        className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-zinc-600 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                      >
                        <PowerOff className="w-3 h-3" /> Disable
                      </button>
                    )}
                    {task.canToggle && !task.enabled && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => mutate.mutate({ id: task.id, action: "enable" })}
                        className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-sky-500/30 text-sky-300 hover:bg-sky-500/10 disabled:opacity-40"
                      >
                        <Power className="w-3 h-3" /> Enable
                      </button>
                    )}
                    {task.logFiles.length > 0 && (
                      <button
                        type="button"
                        disabled={logsLoading}
                        onClick={() => void loadLogs(task.id)}
                        className="inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded border border-[#d4af37]/25 text-amber-200/70 hover:bg-amber-500/10 disabled:opacity-40"
                      >
                        <FileText className="w-3 h-3" /> Logs
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
