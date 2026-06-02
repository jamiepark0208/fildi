import { useState, useEffect, useCallback } from "react";
import {
  RefreshCw, Sparkles, TrendingUp, TrendingDown, Minus, AlertCircle,
  Clock, Settings, X, Check, ChevronDown, ChevronUp, History,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface MarketDataPoint {
  symbol: string;
  label: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
}

interface BriefContext {
  version: number;
  strategy: string;
  portfolios: string;
  macroFocus: string[];
  watchSignals: string[];
  riskRules: string[];
  userNotes: string;
  lastUpdated: string;
}

interface DailyBriefData {
  date: string;
  marketData: MarketDataPoint[];
  content: string;
  generatedAt: string;
  tickers: string[];
  fromCache: boolean;
  noData?: boolean;
}

// ── Market chip ───────────────────────────────────────────────────────────────

function MarketChip({ point }: { point: MarketDataPoint }) {
  const isVix   = point.symbol === "^VIX";
  const hasData = point.price !== null;
  const up      = (point.changePct ?? 0) > 0;
  const down    = (point.changePct ?? 0) < 0;

  const chipColor = !hasData ? "text-muted-foreground"
    : isVix
      ? up ? "text-red-400" : down ? "text-green-400" : "text-foreground"
      : up ? "text-green-400" : down ? "text-red-400"  : "text-foreground";

  const Icon = !hasData ? Minus : up ? TrendingUp : TrendingDown;

  const pctStr = point.changePct !== null
    ? `${point.changePct > 0 ? "+" : ""}${point.changePct.toFixed(2)}%`
    : "";

  const priceStr = point.price !== null
    ? point.symbol === "^TNX"
      ? `${point.price.toFixed(2)}%`
      : point.price >= 1000 ? point.price.toFixed(0) : point.price.toFixed(2)
    : "—";

  return (
    <div className="flex flex-col items-center gap-0.5 px-3 py-2 rounded-lg bg-secondary/30 border border-border/40 min-w-[72px]">
      <span className="text-[10px] text-muted-foreground font-medium tracking-wide">{point.label}</span>
      <span className={cn("text-sm font-bold font-mono tabular-nums leading-none", chipColor)}>{priceStr}</span>
      {pctStr && (
        <span className={cn("text-[10px] font-mono flex items-center gap-0.5", chipColor)}>
          <Icon className="w-2.5 h-2.5" />{pctStr}
        </span>
      )}
    </div>
  );
}

// ── Inline markdown helper ─────────────────────────────────────────────────────

function inlineMd(s: string) {
  return s
    .replace(/\*\*(.+?)\*\*/g, `<strong class="text-foreground font-semibold">$1</strong>`)
    .replace(/\*(.+?)\*/g, `<em>$1</em>`);
}

// ── Markdown renderer ─────────────────────────────────────────────────────────

function BriefContent({ text }: { text: string }) {
  const lines    = text.split("\n");
  const elements: React.ReactNode[] = [];
  let bullets:    string[] = [];

  const flush = (key: string) => {
    if (!bullets.length) return;
    elements.push(
      <ul key={key} className="space-y-1.5 mb-3">
        {bullets.map((b, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground leading-relaxed">
            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-primary/60 shrink-0" />
            <span dangerouslySetInnerHTML={{ __html: inlineMd(b) }} />
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };

  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) { flush(`f${idx}`); return; }
    if (line.startsWith("## ") || line.startsWith("# ")) {
      flush(`f${idx}`);
      elements.push(
        <h3 key={idx} className="text-sm font-bold text-foreground mt-4 mb-2 first:mt-0">
          {line.replace(/^#{1,2}\s/, "")}
        </h3>
      );
    } else if (line.startsWith("- ") || line.startsWith("* ")) {
      bullets.push(line.slice(2));
    } else {
      flush(`f${idx}`);
      elements.push(
        <p key={idx} className="text-sm text-muted-foreground mb-2 leading-relaxed"
          dangerouslySetInnerHTML={{ __html: inlineMd(line) }} />
      );
    }
  });
  flush("end");
  return <div>{elements}</div>;
}

// ── Key bullet extractor (Portfolio Implications → first bullet) ───────────────

function extractKeyBullet(content: string): string {
  const lines = content.split("\n");
  let inSection = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.includes("Portfolio Implications")) { inSection = true; continue; }
    if (inSection && (trimmed.startsWith("- ") || trimmed.startsWith("* "))) return trimmed.slice(2);
    if (inSection && trimmed.startsWith("## ")) break;
  }
  // Fallback: first bullet anywhere
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ") || trimmed.startsWith("* ")) return trimmed.slice(2);
  }
  return "";
}

// ── Context editor ────────────────────────────────────────────────────────────

function ContextEditor({ onClose }: { onClose: () => void }) {
  const [ctx,    setCtx]    = useState<BriefContext | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  useEffect(() => {
    fetch("/api/daily-brief/context").then(r => r.json()).then(setCtx).catch(() => {});
  }, []);

  const save = async () => {
    if (!ctx) return;
    setSaving(true);
    try {
      await fetch("/api/daily-brief/context", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ctx),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally { setSaving(false); }
  };

  const updateList = (field: keyof BriefContext, idx: number, val: string) => {
    if (!ctx) return;
    const arr = [...(ctx[field] as string[])];
    arr[idx] = val;
    setCtx({ ...ctx, [field]: arr });
  };
  const addItem    = (field: keyof BriefContext) => {
    if (!ctx) return;
    setCtx({ ...ctx, [field]: [...(ctx[field] as string[]), ""] });
  };
  const removeItem = (field: keyof BriefContext, idx: number) => {
    if (!ctx) return;
    setCtx({ ...ctx, [field]: (ctx[field] as string[]).filter((_, i) => i !== idx) });
  };

  const textareaClass = "w-full bg-background border border-border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary resize-none";
  const inputClass    = "flex-1 bg-background border border-border rounded-md px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-primary";

  if (!ctx) return <div className="p-6 text-center text-sm text-muted-foreground">Loading context…</div>;

  const listSection = (label: string, field: "macroFocus" | "watchSignals" | "riskRules", placeholder: string) => (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{label}</label>
        <button onClick={() => addItem(field)} className="text-xs text-primary hover:underline">+ Add</button>
      </div>
      <div className="space-y-1.5">
        {(ctx[field] as string[]).map((item, i) => (
          <div key={i} className="flex items-center gap-2">
            <input className={inputClass} value={item} placeholder={placeholder}
              onChange={e => updateList(field, i, e.target.value)} />
            <button onClick={() => removeItem(field, i)} className="text-muted-foreground hover:text-red-400 transition-colors">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
        {ctx[field].length === 0 && <p className="text-xs text-muted-foreground italic">No items — click + Add</p>}
      </div>
    </div>
  );

  return (
    <div className="border-t border-border/40 p-4 bg-secondary/5 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-bold">AI Context — Persistent Learning</p>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            This file is sent to Claude on every brief generation. Customize it to continuously improve relevance.
            <br />Stored in <code className="text-primary">brief-context.json</code> on the server — survives restarts.
          </p>
        </div>
        <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Strategy Summary</label>
          <textarea className={textareaClass} rows={3} value={ctx.strategy}
            onChange={e => setCtx({ ...ctx, strategy: e.target.value })}
            placeholder="Describe your options strategy in 1-2 sentences…" />
        </div>
        <div>
          <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Portfolio Notes</label>
          <textarea className={textareaClass} rows={3} value={ctx.portfolios}
            onChange={e => setCtx({ ...ctx, portfolios: e.target.value })}
            placeholder="IRA = conservative, FILDI = core strategy…" />
        </div>
      </div>

      {listSection("Macro Focus Areas",    "macroFocus",   "e.g. Fed rate expectations — watch CME FedWatch…")}
      {listSection("Ticker Watch Signals", "watchSignals", "e.g. NVDA: product cycles, export restrictions…")}
      {listSection("Risk Rules",           "riskRules",    "e.g. Avoid new puts < 2 weeks before earnings…")}

      <div>
        <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Free-form Notes</label>
        <textarea className={textareaClass} rows={2} value={ctx.userNotes}
          onChange={e => setCtx({ ...ctx, userNotes: e.target.value })}
          placeholder="Anything else Claude should know: recent decisions, upcoming events, thesis changes…" />
      </div>

      <div className="flex items-center gap-3 pt-1">
        <button onClick={save} disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50 transition-colors">
          {saved ? <><Check className="w-3.5 h-3.5" /> Saved!</> : saving ? "Saving…" : "Save Context"}
        </button>
        <p className="text-[11px] text-muted-foreground">Saved context is used on the next brief generation.</p>
      </div>
    </div>
  );
}

// ── History view ──────────────────────────────────────────────────────────────

function HistoryView({ history, loading }: { history: DailyBriefData[]; loading: boolean }) {
  const [openDate, setOpenDate] = useState<string | null>(null);

  if (loading) {
    return <div className="p-8 text-center text-sm text-muted-foreground">Loading past briefs…</div>;
  }
  if (!history.length) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground space-y-1">
        <History className="w-8 h-8 mx-auto mb-3 opacity-30" />
        <p>No past briefs yet.</p>
        <p className="text-xs opacity-60">Generate your first brief on the Today tab.</p>
      </div>
    );
  }

  return (
    <div className="divide-y divide-border/20 max-h-[520px] overflow-y-auto">
      {history.map(brief => {
        const isOpen = openDate === brief.date;
        const genTime = brief.generatedAt
          ? new Date(brief.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
          : null;
        return (
          <div key={brief.date}>
            <button
              onClick={() => setOpenDate(isOpen ? null : brief.date)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-secondary/20 transition-colors text-left"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">{brief.date}</span>
                {genTime && (
                  <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                    <Clock className="w-3 h-3" />{genTime}
                  </span>
                )}
              </div>
              {isOpen ? <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />}
            </button>
            {isOpen && (
              <div className="px-4 pb-5 bg-secondary/5">
                {brief.marketData.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 py-3">
                    {brief.marketData.map(pt => <MarketChip key={pt.symbol} point={pt} />)}
                  </div>
                )}
                <div className="border-t border-border/20 pt-3">
                  <BriefContent text={brief.content} />
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function DailyBrief({ tickers }: { tickers: string[] }) {
  const [tab,          setTab]          = useState<"today" | "history">("today");
  const [brief,        setBrief]        = useState<DailyBriefData | null>(null);
  const [noData,       setNoData]       = useState(false);
  const [marketData,   setMarketData]   = useState<MarketDataPoint[]>([]);
  const [generating,   setGenerating]   = useState(false);
  const [checking,     setChecking]     = useState(true);
  const [error,        setError]        = useState<string | null>(null);
  const [expanded,     setExpanded]     = useState(true);
  const [showContext,  setShowContext]   = useState(false);
  const [history,      setHistory]      = useState<DailyBriefData[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const today = new Date().toLocaleDateString("en-US", { month: "numeric", day: "numeric", year: "numeric" });

  // Fetch live market prices on every mount (cheap — no AI)
  useEffect(() => {
    fetch("/api/daily-brief/market")
      .then(r => r.json())
      .then(d => setMarketData(d.marketData ?? []))
      .catch(() => {});
  }, []);

  // Check if today's brief exists in history (no AI call)
  useEffect(() => {
    const params = new URLSearchParams();
    if (tickers.length > 0) params.set("tickers", tickers.join(","));
    setChecking(true);
    fetch(`/api/daily-brief?${params}`)
      .then(r => r.json())
      .then((d: DailyBriefData & { noData?: boolean }) => {
        if (d.noData) { setNoData(true); setBrief(null); }
        else          { setNoData(false); setBrief(d); }
      })
      .catch(() => setNoData(true))
      .finally(() => setChecking(false));
  }, []); // intentionally no tickers dep — check is best-effort on mount

  const generate = useCallback(async () => {
    setGenerating(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (tickers.length > 0) params.set("tickers", tickers.join(","));
      params.set("refresh", "true");
      const res = await fetch(`/api/daily-brief?${params}`);
      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();
      setBrief(data);
      setNoData(false);
    } catch (e: any) {
      setError(e.message ?? "Failed to generate brief");
    } finally {
      setGenerating(false);
    }
  }, [tickers.join(",")]);

  const loadHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res  = await fetch("/api/daily-brief/history");
      const data = await res.json();
      setHistory(Array.isArray(data) ? data : []);
    } catch {}
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    if (tab === "history") loadHistory();
  }, [tab]);

  const genTime = brief?.generatedAt
    ? new Date(brief.generatedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

  const keyBullet = brief?.content ? extractKeyBullet(brief.content) : "";

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">

      {/* ── Header ── */}
      <div className="px-4 py-3 flex items-center justify-between border-b border-border/40 bg-gradient-to-r from-primary/5 to-transparent">
        <div className="flex items-center gap-1">
          {/* Tabs */}
          <button
            onClick={() => setTab("today")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
              tab === "today" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"
            )}
          >
            <Sparkles className="w-3.5 h-3.5" />
            Highlights
          </button>
          <button
            onClick={() => setTab("history")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors",
              tab === "history" ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground hover:bg-secondary/40"
            )}
          >
            <History className="w-3.5 h-3.5" />
            Past Briefs
          </button>
        </div>

        {tab === "today" && (
          <div className="flex items-center gap-1.5">
            {brief?.fromCache && genTime && (
              <span className="text-[10px] text-muted-foreground flex items-center gap-1 mr-1">
                <Clock className="w-3 h-3" />cached {genTime}
              </span>
            )}
            <button
              onClick={() => setShowContext(v => !v)}
              title="Edit AI context / learning preferences"
              className={cn("p-1.5 rounded transition-colors",
                showContext ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-secondary/40")}
            >
              <Settings className="w-3.5 h-3.5" />
            </button>
            {brief && (
              <button
                onClick={generate}
                disabled={generating}
                title="Regenerate brief with fresh data"
                className="flex items-center gap-1 px-2 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors disabled:opacity-40"
              >
                <RefreshCw className={cn("w-3.5 h-3.5", generating && "animate-spin")} />
                {generating ? "Generating…" : "Refresh"}
              </button>
            )}
            <button
              onClick={() => setExpanded(v => !v)}
              className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
              title={expanded ? "Minimize" : "Expand"}
            >
              {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        )}
      </div>

      {/* ── Today tab ── */}
      {tab === "today" && (
        <div>
          {/* Market chips — always visible */}
          {marketData.length > 0 && (
            <div className="px-4 pt-3 pb-2 flex flex-wrap gap-2">
              {marketData.map(pt => <MarketChip key={pt.symbol} point={pt} />)}
            </div>
          )}

          {/* Checking state */}
          {checking && (
            <div className="px-4 py-2 text-xs text-muted-foreground/60 flex items-center gap-1.5">
              <RefreshCw className="w-3 h-3 animate-spin" />
              Checking for today's brief…
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="m-4 flex items-start gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-sm text-red-400">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">Could not generate brief</p>
                <p className="text-xs mt-0.5 text-red-400/80">{error}</p>
              </div>
            </div>
          )}

          {/* No data — generate CTA */}
          {!checking && noData && !generating && (
            <div className="px-4 py-6 flex flex-col items-center gap-3 text-center border-t border-border/20">
              <p className="text-sm text-muted-foreground">No brief generated for today yet.</p>
              <button
                onClick={generate}
                className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-primary text-primary-foreground text-sm font-semibold hover:bg-primary/90 transition-colors"
              >
                <Sparkles className="w-4 h-4" />
                Generate Today's Brief
              </button>
              <p className="text-[11px] text-muted-foreground/60">~15 seconds · live market data · saved for future sessions</p>
            </div>
          )}

          {/* Generating spinner */}
          {generating && !brief && (
            <div className="px-4 py-8 flex flex-col items-center gap-3 text-center border-t border-border/20">
              <RefreshCw className="w-6 h-6 animate-spin text-primary" />
              <div>
                <p className="text-sm font-medium">Generating market brief…</p>
                <p className="text-xs text-muted-foreground mt-0.5">Fetching live data · Analyzing news · Personalizing to your context</p>
              </div>
            </div>
          )}

          {/* Collapsed: key takeaway only */}
          {brief && !expanded && (
            <div className="px-4 py-3 border-t border-border/20">
              {keyBullet ? (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  <span className="font-semibold text-foreground/80">Key takeaway: </span>
                  <span dangerouslySetInnerHTML={{ __html: inlineMd(keyBullet) }} />
                </p>
              ) : null}
              <button
                onClick={() => setExpanded(true)}
                className="text-xs text-primary hover:underline mt-2 flex items-center gap-1"
              >
                Read full brief <ChevronDown className="w-3 h-3" />
              </button>
            </div>
          )}

          {/* Expanded: full brief */}
          {brief && expanded && (
            <div className="px-4 py-4 border-t border-border/20">
              <BriefContent text={brief.content} />
              <p className="text-[10px] text-muted-foreground/50 mt-4 border-t border-border/20 pt-2 flex items-center gap-2">
                <span>AI-generated · claude-haiku · live market data · saved to history</span>
                <span>·</span>
                <button onClick={() => setShowContext(true)} className="hover:text-primary transition-colors">
                  customize context →
                </button>
              </p>
            </div>
          )}

          {/* Context editor */}
          {showContext && <ContextEditor onClose={() => setShowContext(false)} />}
        </div>
      )}

      {/* ── History tab ── */}
      {tab === "history" && (
        <HistoryView history={history} loading={historyLoading} />
      )}
    </div>
  );
}
