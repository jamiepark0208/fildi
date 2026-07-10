import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Loader2, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { staticCopy, guideTabFor, type ScoreType } from "@/lib/score-summary-copy";
import { useScoreExplanation } from "@/hooks/useScoreExplanation";

interface ExplainableScoreProps {
  ticker: string;
  scoreType: ScoreType;
  signal?: string;                       // for scoreType="signal"
  // Payload builders — only required for fund/tech (the two AI-capable types)
  buildPayload?: () => Record<string, unknown>;
  // Visual
  children: React.ReactNode;             // the score chip / badge to wrap
  side?: "top" | "bottom" | "left" | "right";
  className?: string;
}

// Shared hook instance so all ExplainableScore instances share the same cache
// within a session (module-level singleton pattern via the hook's memCache).

export function ExplainableScore({
  ticker,
  scoreType,
  signal,
  buildPayload,
  children,
  side = "top",
  className,
}: ExplainableScoreProps) {
  const [open, setOpen] = useState(false);
  const { explain, getState } = useScoreExplanation();
  const state = getState(ticker, scoreType);

  const canExplain = (scoreType === "fundamental" || scoreType === "technical") && !!buildPayload;
  const guideTab = guideTabFor(scoreType);
  const copy = staticCopy(scoreType, signal);

  function parseBullets(text: string): string[] {
    return text
      .split(/\n|(?<=[.!?])\s{1,2}(?=[A-Z•\-])/)
      .map(s => s.replace(/^[-•*]\s*/, "").trim())
      .filter(s => s.length > 8);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild onClick={e => e.stopPropagation()}>
        <span className={cn("cursor-pointer", className)}>{children}</span>
      </PopoverTrigger>

      <PopoverContent
        side={side}
        collisionPadding={12}
        className="w-72 text-xs space-y-2"
        onClick={e => e.stopPropagation()}
      >
        {/* Static one-liner — always visible immediately */}
        <p className="text-muted-foreground leading-snug">{copy}</p>

        {/* AI explanation */}
        {state.status === "done" && state.text && (
          <div className="space-y-1 border-t border-border pt-2">
            {parseBullets(state.text).map((bullet, i) => (
              <p key={i} className="leading-snug text-foreground/90">• {bullet}</p>
            ))}
            <p className="text-muted-foreground/60 text-[10px] pt-0.5">
              AI narrative — not a trade recommendation.
            </p>
          </div>
        )}

        {state.status === "error" && (
          <p className="text-destructive/80 text-[11px]">
            Could not generate explanation. Try again later.
          </p>
        )}

        {/* Footer actions */}
        <div className="flex items-center justify-between border-t border-border pt-2">
          {canExplain && state.status !== "done" ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[11px]"
              disabled={state.status === "loading"}
              onClick={() => explain(ticker, scoreType as "fundamental" | "technical", buildPayload!())}
            >
              {state.status === "loading"
                ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" />Explaining…</>
                : "Explain more"}
            </Button>
          ) : (
            <span />
          )}

          <a
            href={`/scorecard?tab=${guideTab}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
            onClick={e => e.stopPropagation()}
          >
            <BookOpen className="w-3 h-3" />
            Scoring Reference
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
}
