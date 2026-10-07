import { useMemo } from "react";
import { useModelList, modelAvoidTickers } from "@/hooks/use-model-list";
import { useTopOptions } from "@/hooks/use-top-options";
import {
  detectRecConflicts,
  conflictsForTicker,
  type RecConflict,
  type ModelSideIdea,
} from "@/lib/rec-conflicts";

/** Build Live ↔ Model List conflict map for chip display. */
export function useRecConflicts(liveDip: string[], liveRally: string[]) {
  const { data: model } = useModelList();
  const { rows: topPuts } = useTopOptions("put", 15);
  const { rows: topCalls } = useTopOptions("call", 15);

  const conflicts = useMemo(() => {
    const modelIdeas: ModelSideIdea[] = [];
    for (const folder of model?.folders ?? []) {
      for (const item of folder.items) {
        const t = item.contract?.type?.toLowerCase();
        if (t === "put" || t === "call") {
          modelIdeas.push({ ticker: item.ticker, side: t });
        }
      }
    }
    return detectRecConflicts({
      modelIdeas,
      liveDip,
      liveRally,
      liveTopPuts: topPuts.map(r => r.ticker),
      liveTopCalls: topCalls.map(r => r.ticker),
      modelAvoid: modelAvoidTickers(model),
    });
  }, [model, liveDip, liveRally, topPuts, topCalls]);

  const byTicker = useMemo(() => {
    const m = new Map<string, RecConflict[]>();
    for (const c of conflicts) {
      const list = m.get(c.ticker) ?? [];
      list.push(c);
      m.set(c.ticker, list);
    }
    return m;
  }, [conflicts]);

  return { conflicts, byTicker, forTicker: (t: string) => conflictsForTicker(conflicts, t) };
}
