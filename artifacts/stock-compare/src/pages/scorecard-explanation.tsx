import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { GuideMetricGrid } from "@/components/scorecard-guide/guide-metric-grid";
import { DataTransparencyBar } from "@/components/scorecard-guide/data-transparency-bar";
import { TabStatusHeader } from "@/components/scorecard-guide/tab-status-header";
import {
  FUNDAMENTAL_GUIDE_ROWS, FUNDAMENTAL_FAMILY_GUIDE_ROWS,
  TECHNICAL_GUIDE_ROWS, OPTIONS_STOCK_ROWS, OPTIONS_STRIKE_ROWS,
} from "@/lib/scorecard-guide-metadata";
import { useGuideStatus } from "@/hooks/use-guide-status";
import { useAuth } from "@/context/AuthContext";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { validateScoringWeights, type ScoringWeightsConfig } from "@/lib/scoring-weights";
import { BookOpen } from "lucide-react";

export default function ScorecardExplanation() {
  const status = useGuideStatus();
  const { isAdmin } = useAuth();
  const { weights, saveConfig, resetDefaults, isSaving } = useScoringPreferences();
  const [tab, setTab] = useState("fundamental");
  const [draft, setDraft] = useState<ScoringWeightsConfig>(weights);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(weights);
  }, [weights, dirty]);

  const fundCov = status.coverageFor("fundamentals");
  const techCov = status.coverageFor("technicals");
  const fundNoteSuffix = status.noteSuffix("fundamentals");
  const techNoteSuffix = status.noteSuffix("technicals");

  const onDraftChange = (next: ScoringWeightsConfig) => {
    setDraft(next);
    setDirty(true);
    setError(null);
  };

  const handleSave = async () => {
    const err = validateScoringWeights(draft);
    if (err) { setError(err); return; }
    const saveErr = await saveConfig(draft);
    if (saveErr) { setError(saveErr); return; }
    setDirty(false);
    setError(null);
  };

  const handleReset = async () => {
    const saveErr = await resetDefaults();
    if (saveErr) { setError(saveErr); return; }
    setDirty(false);
    setError(null);
  };

  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex">
      <Sidebar />
      <main className="flex-1 min-w-0" style={{ marginLeft: "var(--sidebar-w, 220px)", transition: "margin-left 200ms ease" }}>
        <div className="px-6 py-4 border-b border-border/50 sticky top-0 bg-background/95 backdrop-blur z-40">
          <div className="flex items-start gap-3">
            <BookOpen className="w-6 h-6 text-primary shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-bold leading-tight tracking-tight">Scorecard Guide</h1>
              <DataTransparencyBar
                chips={status.headerChips?.()}
                factset={status.sources.factset}
                fmp={status.sources.fmp}
                fmpRemaining={status.fmpRemaining}
              />
            </div>
          </div>
        </div>

        <div className="p-6 max-w-6xl pb-24">
          <p className="text-sm text-foreground/90 mb-5 leading-relaxed">
            Scores are peer-relative within your watchlist. Each metric is normalized, weighted, and combined into a 0–100 score.
          </p>

          <Tabs value={tab} onValueChange={setTab}>
            <TabsList className="h-10 mb-4">
              <TabsTrigger value="fundamental" className="text-sm px-4">Fundamental</TabsTrigger>
              <TabsTrigger value="technical" className="text-sm px-4">Technical</TabsTrigger>
              <TabsTrigger value="options" className="text-sm px-4">Options</TabsTrigger>
            </TabsList>

            <TabsContent value="fundamental" className="mt-0">
              <TabStatusHeader
                chips={status.chipsFor?.("fundamentals")}
                text={status.stripFor("fundamentals")}
                warn={status.fundStale}
              />
              <p className="text-sm font-semibold text-foreground mb-2">Family blend weights</p>
              <GuideMetricGrid
                rows={FUNDAMENTAL_FAMILY_GUIDE_ROWS}
                coverageLabel={fundCov.label}
                coverageTone={fundCov.tone}
                config={draft}
                noteSuffix={fundNoteSuffix}
                editable={isAdmin}
                onConfigChange={onDraftChange}
              />
              <p className="text-sm font-semibold text-foreground mb-2">Metric intra-family weights</p>
              <GuideMetricGrid
                rows={FUNDAMENTAL_GUIDE_ROWS}
                coverageLabel={fundCov.label}
                coverageTone={fundCov.tone}
                showFamily
                config={draft}
                noteSuffix={fundNoteSuffix}
                editable={isAdmin}
                onConfigChange={onDraftChange}
              />
            </TabsContent>

            <TabsContent value="technical" className="mt-0">
              <TabStatusHeader
                chips={status.chipsFor?.("technicals")}
                text={status.stripFor("technicals")}
                warn={status.techStale}
              />
              <GuideMetricGrid
                rows={TECHNICAL_GUIDE_ROWS}
                coverageLabel={techCov.label}
                coverageTone={techCov.tone}
                config={draft}
                noteSuffix={techNoteSuffix}
                editable={isAdmin}
                onConfigChange={onDraftChange}
              />
            </TabsContent>

            <TabsContent value="options" className="mt-0 space-y-3">
              <TabStatusHeader
                chips={status.chipsFor?.("options")}
                text={status.stripFor("options")}
              />
              <p className="text-sm text-foreground/90">Rank stocks → score strikes → liquidity gate + macro regime</p>
              <p className="text-sm font-semibold text-foreground">Stock rank layer</p>
              <GuideMetricGrid
                rows={OPTIONS_STOCK_ROWS}
                coverageLabel="DB daily/weekly"
                config={draft}
                editable={isAdmin}
                onConfigChange={onDraftChange}
              />
              <p className="text-sm font-semibold text-foreground pt-1">Strike pick layer (BEST)</p>
              <GuideMetricGrid
                rows={OPTIONS_STRIKE_ROWS}
                coverageLabel="On scan"
                config={draft}
                editable={isAdmin}
                onConfigChange={onDraftChange}
              />
            </TabsContent>
          </Tabs>

          {isAdmin && dirty && (
            <div className="fixed bottom-0 left-0 right-0 md:left-[var(--sidebar-w,220px)] z-50 flex items-center gap-3 px-6 py-3 border-t border-border bg-background/95 backdrop-blur">
              <Button size="sm" className="text-sm" disabled={isSaving} onClick={handleSave}>
                {isSaving ? "Saving…" : "Save weights"}
              </Button>
              <Button size="sm" variant="outline" className="text-sm" disabled={isSaving} onClick={handleReset}>
                Reset defaults
              </Button>
              {error && <span className="text-sm text-red-400">{error}</span>}
            </div>
          )}

          <p className="text-xs text-muted-foreground mt-4">
            Relative to watchlist. Missing data → 0.
          </p>
        </div>
      </main>
    </div>
  );
}
