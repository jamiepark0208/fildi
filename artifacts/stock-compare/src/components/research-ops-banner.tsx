/**
 * Soft ops hint for Street panels — local cache / LSEG desktop status.
 * Never blocks rendering; scores do not need live vendors.
 */
import { useQuery } from "@tanstack/react-query";

type OpsReport = {
  wrds: { overall: string };
  lseg: { overall: string; desktopProxy: { reachable: boolean } };
  fixHints: string[];
};

export function ResearchOpsBanner({ lane }: { lane: "wrds" | "lseg" }) {
  const { data } = useQuery({
    queryKey: ["research-ops"],
    queryFn: async (): Promise<OpsReport> => {
      const res = await fetch("/api/research/ops");
      if (!res.ok) throw new Error(`research ops ${res.status}`);
      return res.json();
    },
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  if (!data) return null;

  if (lane === "lseg" && !data.lseg.desktopProxy.reachable) {
    return (
      <p className="text-[9px] text-amber-200/50 italic leading-snug">
        LSEG Workspace unreachable (desktop closed or account not entitled) — showing last local
        cache only. Fund/tech/options scores and Yahoo/Schwab/WRDS keep working; refresh signals
        after Workspace access is restored.
      </p>
    );
  }

  const overall = lane === "wrds" ? data.wrds.overall : data.lseg.overall;
  if (overall === "ok") return null;

  const hint =
    lane === "wrds"
      ? data.fixHints.find((h) => h.includes("WRDS")) ??
        "WRDS research cache needs a manual sync when vendor is up."
      : data.fixHints.find((h) => h.includes("LSEG")) ??
        "LSEG research cache stale — sync when Workspace is up.";

  return <p className="text-[9px] text-amber-200/40 italic leading-snug">{hint}</p>;
}
