import { useQuery } from "@tanstack/react-query";
import type { ProvenanceData } from "@/components/settings/stockdb/stock-db-types";
import { indexProvenance } from "@/lib/provenance-display";

export function useFundamentalsProvenance(ticker: string | null | undefined) {
  const q = useQuery<ProvenanceData>({
    queryKey: ["provenance", ticker],
    queryFn: async ({ signal }) => {
      const r = await fetch(`/api/fundamentals/provenance/${encodeURIComponent(ticker!)}`, {
        credentials: "include",
        signal,
      });
      if (!r.ok) throw new Error(`provenance ${r.status}`);
      return r.json();
    },
    enabled: !!ticker,
    staleTime: 10 * 60 * 1000,
    gcTime: 15 * 60 * 1000,
    retry: 1,
  });

  return {
    ...q,
    byField: indexProvenance(q.data?.fields),
  };
}
