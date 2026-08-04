import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface ScheduledTask {
  name: string;
  description: string;
  schedule: string;
  lastRun: string | null;
  running: boolean;
}
interface ScheduledTasksStatus { tasks: ScheduledTask[]; generatedAt: number }

export function ScheduledTasksTab() {
  const { data, isLoading, refetch, isFetching } = useQuery<ScheduledTasksStatus>({
    queryKey: ["admin", "scheduled-tasks"],
    queryFn: async () => {
      const res = await fetch("/api/admin/scheduled-tasks", { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load scheduled tasks");
      return res.json();
    },
    staleTime: 0,
  });

  return (
    <div className="rounded-md border border-[#d4af37]/25 overflow-hidden bg-zinc-950 shadow-lg shadow-black/60 p-3 max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-[#d4af37]/80 uppercase tracking-wide">Scheduled Tasks</h2>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs text-amber-200/50 hover:text-white border border-[#d4af37]/20 rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-amber-200/40 animate-pulse">Loading…</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-[#d4af37]/25">
          <table className="w-full text-xs">
            <thead className="bg-black text-[#d4af37]">
              <tr className="border-b border-[#d4af37]/25">
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Task</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Status</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Schedule</th>
                <th className="text-left font-semibold text-[11px] uppercase tracking-wider px-2.5 py-1">Last Run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {data?.tasks.map(task => (
                <tr key={task.name} className="bg-zinc-900/70 even:bg-zinc-800/60 hover:bg-amber-500/10 transition-colors">
                  <td className="px-2.5 py-1 font-medium text-white max-w-[220px] truncate" title={task.description}>
                    {task.name}
                  </td>
                  <td className="px-2.5 py-1">
                    {task.running ? (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-yellow-500/15 text-yellow-400 border-yellow-500/30">
                        Running
                      </span>
                    ) : task.lastRun ? (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-500/15 text-green-400 border-green-500/30">
                        Idle
                      </span>
                    ) : (
                      <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-zinc-800 text-amber-200/40 border-zinc-700">
                        Never run
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 py-1 font-mono text-amber-200/40 whitespace-nowrap">{task.schedule}</td>
                  <td className="px-2.5 py-1 text-amber-200/40 whitespace-nowrap">
                    {task.lastRun
                      ? new Date(task.lastRun).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && (
        <p className="text-[10px] text-amber-200/40 mt-2">
          Generated at {new Date(data.generatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
