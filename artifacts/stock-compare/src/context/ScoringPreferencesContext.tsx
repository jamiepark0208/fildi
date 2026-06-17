import { createContext, useCallback, useContext, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  buildDefaultScoringWeights,
  mergeScoringWeights,
  validateScoringWeights,
  type ScoringWeightsConfig,
} from "@/lib/scoring-weights";

type Ctx = {
  weights: ScoringWeightsConfig;
  isLoading: boolean;
  isSaving: boolean;
  saveConfig: (config: ScoringWeightsConfig) => Promise<string | null>;
  resetDefaults: () => Promise<string | null>;
};

const ScoringPreferencesContext = createContext<Ctx | null>(null);

async function fetchConfig(): Promise<Partial<ScoringWeightsConfig> | null> {
  const res = await fetch("/api/scoring-config");
  if (!res.ok) throw new Error("Failed to load scoring config");
  const data = await res.json() as { weights: Partial<ScoringWeightsConfig> | null };
  return data.weights;
}

export function ScoringPreferencesProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const { data: stored, isLoading } = useQuery({
    queryKey: ["scoring-config"],
    queryFn: fetchConfig,
    staleTime: 60_000,
  });

  const weights = useMemo(() => mergeScoringWeights(stored), [stored]);

  const saveMut = useMutation({
    mutationFn: async (config: ScoringWeightsConfig) => {
      const err = validateScoringWeights(config);
      if (err) throw new Error(err);
      const res = await fetch("/api/scoring-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights: config }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Save failed");
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scoring-config"] }),
  });

  const resetMut = useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/scoring-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weights: null }),
      });
      if (!res.ok) throw new Error("Reset failed");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scoring-config"] }),
  });

  const saveConfig = useCallback(async (config: ScoringWeightsConfig) => {
    try {
      await saveMut.mutateAsync(config);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Save failed";
    }
  }, [saveMut]);

  const resetDefaults = useCallback(async () => {
    try {
      await resetMut.mutateAsync();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "Reset failed";
    }
  }, [resetMut]);

  const value = useMemo(() => ({
    weights,
    isLoading,
    isSaving: saveMut.isPending || resetMut.isPending,
    saveConfig,
    resetDefaults,
  }), [weights, isLoading, saveMut.isPending, resetMut.isPending, saveConfig, resetDefaults]);

  return (
    <ScoringPreferencesContext.Provider value={value}>
      {children}
    </ScoringPreferencesContext.Provider>
  );
}

export function useScoringPreferences(): Ctx {
  const ctx = useContext(ScoringPreferencesContext);
  if (!ctx) {
    return {
      weights: buildDefaultScoringWeights(),
      isLoading: false,
      isSaving: false,
      saveConfig: async () => "Scoring preferences not loaded",
      resetDefaults: async () => "Scoring preferences not loaded",
    };
  }
  return ctx;
}
