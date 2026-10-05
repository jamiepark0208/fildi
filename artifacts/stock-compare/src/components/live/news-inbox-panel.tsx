/**
 * Live → News: session inbox with deterministic categorize/noise for troubleshooting.
 */
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

interface SessionItem {
  id: number;
  source: string;
  kind: string;
  category: string | null;
  noiseScore: number | null;
  fromDomain: string | null;
  subject: string;
  receivedAt: string;
  synopsis: string | null;
  tickersMentioned: string[];
  includeInBrief: boolean;
  noiseReasons: string[];
  contentLinkCount: number;
}

interface SessionResponse {
  sessionStartPt: string;
  sessionLabel: string;
  dateKey: string;
  isWeekendPack: boolean;
  count: number;
  includedCount: number;
  items: SessionItem[];
}

const TH = "font-semibold text-[9px] uppercase tracking-wider px-1.5 py-0.5 text-left";
const TD = "px-1.5 py-0.5 text-[11px] font-mono";

async function fetchSession(): Promise<SessionResponse> {
  const r = await fetch("/api/desk-commentaries/session", { credentials: "include" });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

export function NewsInboxPanel() {
  const [filter, setFilter] = useState<"all" | "in" | "out">("all");
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ["desk-session"],
    queryFn: fetchSession,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const items = useMemo(() => {
    const list = data?.items ?? [];
    if (filter === "in") return list.filter((i) => i.includeInBrief);
    if (filter === "out") return list.filter((i) => !i.includeInBrief);
    return list;
  }, [data, filter]);

  const byCat = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of data?.items ?? []) {
      const k = i.category ?? i.kind ?? "?";
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-zinc-400">
        <span className="text-[#d4af37]/80">{data?.sessionLabel ?? "session…"}</span>
        {data && (
          <span>
            {data.includedCount}/{data.count} in brief
            {data.isWeekendPack ? " · weekend pack" : ""}
          </span>
        )}
        <div className="inline-flex rounded border border-[#d4af37]/20 overflow-hidden ml-auto">
          {([
            ["all", "All"],
            ["in", "In brief"],
            ["out", "Filtered"],
          ] as const).map(([v, label]) => (
            <button
              key={v}
              type="button"
              onClick={() => setFilter(v)}
              className={cn(
                "px-2 py-0.5 transition-colors",
                filter === v ? "bg-[#d4af37] text-black" : "bg-zinc-950 text-amber-200/50 hover:text-[#d4af37]",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {byCat.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {byCat.map(([cat, n]) => (
            <span
              key={cat}
              className="rounded border border-zinc-700/80 bg-zinc-950 px-1.5 py-0.5 text-[9px] font-mono text-zinc-400"
            >
              {cat} · {n}
            </span>
          ))}
        </div>
      )}

      {isLoading && <p className="text-[11px] text-zinc-500">Loading session inbox…</p>}
      {error && <p className="text-[11px] text-red-400">{(error as Error).message}</p>}

      <div className="rounded-md border border-[#d4af37]/20 overflow-hidden bg-zinc-950">
        <table className="w-full">
          <thead className="bg-black text-[#d4af37]">
            <tr className="border-b border-[#d4af37]/20">
              <th className={cn(TH, "w-8")}>In</th>
              <th className={cn(TH, "text-right w-10")}>N</th>
              <th className={TH}>Cat</th>
              <th className={TH}>Source</th>
              <th className={cn(TH, "text-right")}>When</th>
              <th className={TH}>Subject</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/80">
            {items.map((r) => {
              const open = expandedId === r.id;
              const when = new Date(r.receivedAt).toLocaleString("en-US", {
                month: "numeric",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              });
              return (
                <Fragment key={r.id}>
                  <tr
                    className={cn(
                      "cursor-pointer hover:bg-amber-500/5",
                      r.includeInBrief ? "bg-zinc-900/50" : "bg-zinc-950/80 opacity-70",
                    )}
                    onClick={() => setExpandedId(open ? null : r.id)}
                  >
                    <td className={cn(TD, r.includeInBrief ? "text-emerald-400" : "text-zinc-600")}>
                      {r.includeInBrief ? "●" : "○"}
                    </td>
                    <td
                      className={cn(
                        TD, "text-right",
                        (r.noiseScore ?? 0) >= 70 ? "text-red-400" : (r.noiseScore ?? 0) >= 40 ? "text-amber-300" : "text-sky-300/70",
                      )}
                    >
                      {r.noiseScore ?? "—"}
                    </td>
                    <td className={cn(TD, "text-zinc-300")}>{r.category ?? r.kind}</td>
                    <td className={cn(TD, "text-amber-200/70 truncate max-w-[7rem]")} title={r.fromDomain ?? r.source}>
                      {r.source.replace(/^newsletter:/, "")}
                    </td>
                    <td className={cn(TD, "text-right text-zinc-500 whitespace-nowrap")}>{when}</td>
                    <td className={cn(TD, "text-white/90 font-sans text-[11px] truncate max-w-[20rem]")}>
                      {r.subject}
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-black/40">
                      <td colSpan={6} className="px-2 py-1.5 text-[11px] text-zinc-400 space-y-1">
                        <p className="text-amber-50/80 leading-snug">{r.synopsis || "(no synopsis)"}</p>
                        <p className="font-mono text-[10px] text-zinc-500">
                          noise: {(r.noiseReasons ?? []).join(", ") || "—"}
                          {" · "}links: {r.contentLinkCount}
                          {Array.isArray(r.tickersMentioned) && r.tickersMentioned.length > 0 && (
                            <> · tickers: {r.tickersMentioned.slice(0, 10).join(", ")}</>
                          )}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {!isLoading && items.length === 0 && (
              <tr>
                <td colSpan={6} className="px-2 py-3 text-[11px] text-zinc-500 text-center">
                  No emails in this session yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
