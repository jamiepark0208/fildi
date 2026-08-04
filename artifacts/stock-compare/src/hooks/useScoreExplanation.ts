import { useState, useCallback } from "react";

export type ExplainStatus = "idle" | "loading" | "done" | "error";

interface ExplainState {
  text: string;
  status: ExplainStatus;
}

// Shared in-memory map so explanations survive component remounts within the same session.
// The server's explain_cache table provides cross-session / cross-reload persistence.
const memCache = new Map<string, string>();

function cacheKey(ticker: string, scoreType: string): string {
  return `${scoreType}:${ticker}`;
}

export function useScoreExplanation() {
  const [states, setStates] = useState<Record<string, ExplainState>>({});

  const explain = useCallback(async (
    ticker: string,
    scoreType: "fundamental" | "technical",
    payload: Record<string, unknown>,
    // Extra cache discriminator for the same scoreType (e.g. technical put vs call lens).
    // Only affects local cache keys — the server still receives scoreType unchanged.
    cacheScope?: string,
  ) => {
    const key = cacheKey(ticker, cacheScope ?? scoreType);

    // In-memory hit (same session, already fetched)
    const cached = memCache.get(key);
    if (cached) {
      setStates(prev => ({ ...prev, [key]: { text: cached, status: "done" } }));
      return;
    }

    setStates(prev => ({ ...prev, [key]: { text: "", status: "loading" } }));

    try {
      const res = await fetch("/api/explain/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, scoreType, ...payload }),
      });
      const data = await res.json() as { explanation?: string };
      const text = data.explanation ?? "Unable to generate explanation at this time.";
      memCache.set(key, text);
      setStates(prev => ({ ...prev, [key]: { text, status: "done" } }));
    } catch {
      const text = "Unable to generate explanation at this time.";
      setStates(prev => ({ ...prev, [key]: { text, status: "error" } }));
    }
  }, []);

  const getState = useCallback((ticker: string, scoreType: string, cacheScope?: string): ExplainState => {
    const key = cacheKey(ticker, cacheScope ?? scoreType);
    // Seed from mem cache if state not yet set (e.g. component remounted)
    const cached = memCache.get(key);
    if (cached && !states[key]) return { text: cached, status: "done" };
    return states[key] ?? { text: "", status: "idle" };
  }, [states]);

  return { explain, getState };
}
