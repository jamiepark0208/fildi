import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AppPage } from "@/components/app-page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { GuideMetricGrid } from "@/components/scorecard-guide/guide-metric-grid";
import { DataTransparencyBar } from "@/components/scorecard-guide/data-transparency-bar";
import { TabStatusHeader } from "@/components/scorecard-guide/tab-status-header";
import { FundamentalTreatmentPanel } from "@/components/scorecard-guide/fundamental-treatment-panel";
import { TechnicalTreatmentPanel } from "@/components/scorecard-guide/technical-treatment-panel";
import { OptionsTreatmentPanel } from "@/components/scorecard-guide/options-treatment-panel";
import { WalkthroughControls } from "@/components/scorecard-guide/score-walkthrough-shared";
import {
  TECHNICAL_GUIDE_ROWS,
  OPTIONS_STOCK_ROWS,
  OPTIONS_STRIKE_ROWS,
} from "@/lib/scorecard-guide-metadata";
import { useGuideStatus } from "@/hooks/use-guide-status";
import { useAuth } from "@/context/AuthContext";
import { useScoringPreferences } from "@/context/ScoringPreferencesContext";
import { validateScoringWeights, type ScoringWeightsConfig } from "@/lib/scoring-weights";
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
  const [walkInput, setWalkInput] = useState("HOOD");
  const [walkTicker, setWalkTicker] = useState("HOOD");

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
    <>
        {showHeader && (
          <div className="px-4 py-2 border-b border-[#d4af37]/20 sticky top-0 bg-zinc-950/95 backdrop-blur z-40">
            <div className="flex items-start gap-2">
              <BookOpen className="w-4 h-4 text-[#d4af37] shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1">
                <h1 className="text-sm font-bold leading-tight tracking-tight text-white">Scorecard Guide</h1>
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

        <div className={showHeader ? "p-4 max-w-6xl pb-8" : "max-w-6xl pb-3"}>
          <Tabs value={tab} onValueChange={setTab}>
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <TabsList>
                <TabsTrigger value="fundamental">Fundamental</TabsTrigger>
                <TabsTrigger value="technical">Technical</TabsTrigger>
                <TabsTrigger value="options">Options</TabsTrigger>
              </TabsList>

              {/* As-of sits with the layer tabs — not a lonely grey line under them */}
              {tab === "fundamental" && (
                <TabStatusHeader
                  chips={status.chipsFor?.("fundamentals")}
                  text={status.stripFor("fundamentals")}
                  warn={status.fundStale}
                  inline
                />
              )}
              {tab === "technical" && (
                <TabStatusHeader
                  chips={status.chipsFor?.("technicals")}
                  text={status.stripFor("technicals")}
                  warn={status.techStale}
                  inline
                />
              )}
              {tab === "options" && (
                <TabStatusHeader
                  chips={status.chipsFor?.("options")}
                  text={status.stripFor("options")}
                  inline
                />
              )}

              <WalkthroughControls
                input={walkInput}
                onInput={setWalkInput}
                onLoad={() => {
                  const t = walkInput.trim().toUpperCase();
                  if (t) setWalkTicker(t);
                }}
              />
            </div>

            <TabsContent value="fundamental" className="mt-0 space-y-2">
              <FundamentalTreatmentPanel ticker={walkTicker} />
            </TabsContent>

            <TabsContent value="technical" className="mt-0 space-y-2">
              <TechnicalTreatmentPanel ticker={walkTicker} />
              {isAdmin && (
                <details className="rounded-sm border border-white/10 bg-black/30">
                  <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-[#d4af37]">
                    Edit technical weights (admin)
                  </summary>
                  <div className="px-2 pb-2 pt-1">
                    <GuideMetricGrid
                      rows={TECHNICAL_GUIDE_ROWS}
                      coverageLabel={status.coverageFor("technicals").label}
                      coverageTone={status.coverageFor("technicals").tone}
                      config={draft}
                      noteSuffix={status.noteSuffix("technicals")}
                      editable
                      onConfigChange={onDraftChange}
                    />
                  </div>
                </details>
              )}
            </TabsContent>

            <TabsContent value="options" className="mt-0 space-y-2">
              <OptionsTreatmentPanel ticker={walkTicker} />
              {isAdmin && (
                <details className="rounded-sm border border-white/10 bg-black/30">
                  <summary className="cursor-pointer px-2.5 py-1.5 text-[11px] text-white hover:text-[#d4af37]">
                    Edit options weights (admin)
                  </summary>
                  <div className="px-2 pb-2 pt-1 space-y-2">
                    <GuideMetricGrid
                      rows={OPTIONS_STOCK_ROWS}
                      coverageLabel="DB daily/weekly"
                      config={draft}
                      editable
                      onConfigChange={onDraftChange}
                    />
                    <GuideMetricGrid
                      rows={OPTIONS_STRIKE_ROWS}
                      coverageLabel="On scan"
                      config={draft}
                      editable
                      onConfigChange={onDraftChange}
                    />
                  </div>
                </details>
              )}
            </TabsContent>
          </Tabs>

          {isAdmin && dirty && (
            <div className="fixed bottom-0 left-0 right-0 z-50 flex items-center gap-2 px-4 py-2 border-t border-[#d4af37]/25 bg-zinc-950/95 backdrop-blur">
              <Button size="sm" className="text-xs h-7 bg-[#d4af37] text-black hover:bg-[#d4af37]/90" disabled={isSaving} onClick={handleSave}>
                {isSaving ? "Saving…" : "Save weights"}
              </Button>
              <Button size="sm" variant="outline" className="text-xs h-7 border-[#d4af37]/25 text-white hover:bg-amber-500/10" disabled={isSaving} onClick={handleReset}>
                Reset defaults
              </Button>
              {error && <span className="text-xs text-red-400">{error}</span>}
            </div>
          )}

          <p className="text-[11px] mt-2">
            <button className="text-[#d4af37] hover:underline" onClick={() => navigate("/options-scanner")}>
              See scores on Scanner →
            </button>
          </p>
        </div>
    </>
  );
}

export default function ScorecardExplanation() {
  return (
    <AppPage className="bg-[#040c18] text-white" contentClassName="min-w-0">
      <ScorecardGuideContent />
    </AppPage>
  );
}
