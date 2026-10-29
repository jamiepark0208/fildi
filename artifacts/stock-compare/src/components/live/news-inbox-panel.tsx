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

/** Compact when: m/d h:mm (no comma). */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const m = d.getMonth() + 1;
  const day = d.getDate();
  let h = d.getHours();
  const min = String(d.getMinutes()).padStart(2, "0");
  const am = h < 12;
  h = h % 12 || 12;
  return `${m}/${day} ${h}:${min}${am ? "a" : "p"}`;
}

function catTag(cat: string): { label: string; compact: boolean } {
  if (cat === "newsletter_digest" || cat.startsWith("newsletter")) {
    return { label: "nl", compact: true };
  }
  return { label: cat.replace(/^newsletter:/, ""), compact: false };
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
      <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono text-white/80">
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
        <div className="flex flex-wrap gap-1 items-center">
          {byCat.map(([cat, n]) => {
            const t = catTag(cat);
            return (
              <span
                key={cat}
                title={cat}
                className={cn(
                  "inline-flex items-center font-mono text-zinc-300 border border-zinc-700/80 bg-zinc-950",
                  t.compact ? "px-1 py-0 text-[8px] leading-4 rounded-sm" : "px-1.5 py-0.5 text-[9px] rounded",
                )}
              >
                {t.label}
                <span className="text-amber-100/80 ml-0.5">{n}</span>
              </span>
            );
          })}
        </div>
      )}

      {isLoading && <p className="text-[11px] text-amber-100/80">Loading session inbox…</p>}
      {error && <p className="text-[11px] text-red-400">{(error as Error).message}</p>}

      <div className="rounded-md border border-[#d4af37]/20 overflow-hidden bg-zinc-950">
        <table className="w-full">
          <thead className="bg-black text-[#d4af37]">
            <tr className="border-b border-[#d4af37]/20">
              <th className={TH}>Cat</th>
              <th className={TH}>Source</th>
              <th className={cn(TH, "text-right")}>When</th>
              <th className={TH}>Subject</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/80">
            {items.map((r) => {
              const open = expandedId === r.id;
              const when = formatWhen(r.receivedAt);
              const cat = r.category ?? r.kind ?? "?";
              const tag = catTag(cat);
              return (
                <Fragment key={r.id}>
                  <tr
                    className={cn(
                      "cursor-pointer hover:bg-amber-500/5",
                      r.includeInBrief ? "bg-zinc-900/50" : "bg-zinc-950/80 opacity-55",
                    )}
                    onClick={() => setExpandedId(open ? null : r.id)}
                    title={r.includeInBrief ? "in brief" : `filtered · noise ${r.noiseScore ?? "—"}`}
                  >
                    <td className={cn(TD, "text-zinc-300")}>
                      <span
                        title={cat}
                        className={cn(
                          "inline-block font-mono",
                          tag.compact ? "text-[8px] text-amber-100 uppercase" : "text-[10px]",
                        )}
                      >
                        {tag.label}
                      </span>
                    </td>
                    <td className={cn(TD, "text-amber-200/70 truncate max-w-[7rem]")} title={r.fromDomain ?? r.source}>
                      {r.source.replace(/^newsletter:/, "")}
                    </td>
                    <td className={cn(TD, "text-right text-amber-100 whitespace-nowrap text-[10px]")}>
                      {when}
                    </td>
                    <td className={cn(TD, "text-white/90 font-sans text-[11px] truncate max-w-[20rem]")}>
                      {r.subject}
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-black/40">
                      <td colSpan={4} className="px-2 py-1.5 text-[11px] text-amber-100 space-y-1">
                        <p className="text-amber-50/80 leading-snug">{r.synopsis || "(no synopsis)"}</p>
                        <p className="font-mono text-[10px] text-amber-100/80">
                          {r.includeInBrief ? "in brief" : "filtered"}
                          {" · "}noise: {(r.noiseReasons ?? []).join(", ") || "—"}
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
                <td colSpan={4} className="px-2 py-3 text-[11px] text-amber-100/80 text-center">
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
