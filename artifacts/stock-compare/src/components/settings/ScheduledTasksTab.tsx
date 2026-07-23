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
    <div className="bg-card border border-border rounded-xl p-6 shadow-sm max-w-3xl">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold">Scheduled Tasks</h2>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground border border-border rounded-md px-2.5 py-1.5 transition-colors disabled:opacity-50"
        >
          <RefreshCw className={cn("w-3 h-3", isFetching && "animate-spin")} />
          Refresh
        </button>
      </div>

      {isLoading ? (
        <p className="text-xs text-muted-foreground animate-pulse">Loading…</p>
      ) : (
        <div className="divide-y divide-border/40">
          {data?.tasks.map(task => (
            <div key={task.name} className="py-3 space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground">{task.name}</span>
                {task.running ? (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-yellow-500/15 text-yellow-400 border-yellow-500/30">
                    Running
                  </span>
                ) : task.lastRun ? (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-green-500/15 text-green-400 border-green-500/30">
                    Idle
                  </span>
                ) : (
                  <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded border bg-secondary text-muted-foreground border-border">
                    Never run
                  </span>
                )}
                <span className="ml-auto text-[10px] text-muted-foreground font-mono">{task.schedule}</span>
              </div>
              <p className="text-[11px] text-muted-foreground">{task.description}</p>
              <p className="text-[10px] text-muted-foreground/70">
                Last run:{" "}
                {task.lastRun
                  ? new Date(task.lastRun).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
                  : "—"}
              </p>
            </div>
          ))}
        </div>
      )}

      {data && (
        <p className="text-[10px] text-muted-foreground mt-3">
          Generated at {new Date(data.generatedAt).toLocaleTimeString()}
        </p>
      )}
    </div>
  );
}
