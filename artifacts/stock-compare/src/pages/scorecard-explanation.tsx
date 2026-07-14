import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { TopNav } from "@/components/top-nav";
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
import { validateScoringWeights, SCORING_PRESETS, type ScoringWeightsConfig } from "@/lib/scoring-weights";
import { BookOpen } from "lucide-react";

export function ScorecardGuideContent({ showHeader = true }: { showHeader?: boolean }) {
  const status = useGuideStatus();
  const { isAdmin } = useAuth();
  const [, navigate] = useLocation();
  const { weights, saveConfig, resetDefaults, isSaving } = useScoringPreferences();
  const initialTab = new URLSearchParams(window.location.search).get("tab") ?? "fundamental";
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState<ScoringWeightsConfig>(weights);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(weights);
  }, [weights, dirty]);

  // Keep ?tab= in the URL in sync so the current tab is shareable, and scroll
  // to a #metric-<key> anchor (e.g. deep-linked from a score badge) once the
  // tab content has painted.
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("tab", tab);
    window.history.replaceState(null, "", url.toString().replace(window.location.origin, ""));
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const t = setTimeout(() => {
      document.getElementById(hash)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 50);
    return () => clearTimeout(t);
  }, [tab]);

  const applyPreset = (key: string) => {
    const p = SCORING_PRESETS[key];
    if (!p) return;
    const err = validateScoringWeights(p.config);
    if (err) { setError(err); return; }
    setPreset(key);
    setDraft(p.config);
    setDirty(true);
    setError(null);
  };

  const fundCov = status.coverageFor("fundamentals");
  const techCov = status.coverageFor("technicals");
  const fundNoteSuffix = status.noteSuffix("fundamentals");
  const techNoteSuffix = status.noteSuffix("technicals");

  const onDraftChange = (next: ScoringWeightsConfig) => {
    setDraft(next);
    setDirty(true);
    setError(null);
    setPreset(null);
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
    setPreset(null);
  };

  return (
    <>
        {showHeader && (
          <div className="px-6 py-4 border-b border-border/50 sticky top-14 bg-background/95 backdrop-blur z-40">
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
        )}

        <div className="p-6 max-w-6xl pb-24">
          <p className="text-sm text-foreground/90 mb-5 leading-relaxed">
            Scores are peer-relative within your watchlist. Each metric is normalized, weighted, and combined into a 0–100 score.
          </p>

          {isAdmin && (
            <div className="flex items-center gap-2 mb-5">
              <span className="text-xs text-muted-foreground mr-1">Presets:</span>
              {Object.entries(SCORING_PRESETS).map(([key, p]) => (
                <Button
                  key={key}
                  size="sm"
                  variant={preset === key ? "default" : "outline"}
                  className="text-xs h-7"
                  onClick={() => applyPreset(key)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          )}

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
            <div className="fixed bottom-0 left-0 right-0 z-50 flex items-center gap-3 px-6 py-3 border-t border-border bg-background/95 backdrop-blur">
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
          <p className="text-xs mt-2">
            <button className="text-primary hover:underline" onClick={() => navigate("/options-scanner")}>
              See scores on Scanner →
            </button>
          </p>
        </div>
    </>
  );
}

export default function ScorecardExplanation() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <TopNav />
      <main className="pt-14 min-w-0">
        <ScorecardGuideContent />
      </main>
    </div>
  );
}
