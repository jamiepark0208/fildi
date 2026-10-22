/**
 * App-wide stock sheet: click a ticker → full breakdown over the current page → Back.
 * Source page stays mounted (Rankings/Structures state preserved). Browser Back closes the sheet.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { StockBreakdown } from "@/components/stock-breakdown";
import { prefetchBreakdown } from "@/lib/breakdown-query";

type StockNav = {
  ticker: string | null;
  returnLabel: string;
  open: (ticker: string, opts?: { returnLabel?: string }) => void;
  close: () => void;
  prefetch: (ticker: string) => void;
};

const Ctx = createContext<StockNav | null>(null);

const STOCK_PARAM = "stock";

function readStockParam(): string | null {
  if (typeof window === "undefined") return null;
  const t = new URLSearchParams(window.location.search).get(STOCK_PARAM);
  return t ? t.trim().toUpperCase() : null;
}

function writeStockParam(ticker: string | null, mode: "push" | "replace") {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (ticker) url.searchParams.set(STOCK_PARAM, ticker);
  else url.searchParams.delete(STOCK_PARAM);
  const href = url.pathname + url.search + url.hash;
  if (mode === "push") window.history.pushState({ fildiStock: ticker }, "", href);
  else window.history.replaceState({ fildiStock: ticker }, "", href);
}

export function StockNavProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [ticker, setTicker] = useState<string | null>(() => readStockParam());
  const [returnLabel, setReturnLabel] = useState("Back");
  const pushedRef = useRef(false);

  const prefetch = useCallback(
    (t: string) => prefetchBreakdown(qc, t),
    [qc],
  );

  const open = useCallback((raw: string, opts?: { returnLabel?: string }) => {
    const t = raw.trim().toUpperCase();
    if (!t) return;
    setReturnLabel(opts?.returnLabel?.trim() || "Back");
    setTicker(t);
    prefetchBreakdown(qc, t);
    writeStockParam(t, "push");
    pushedRef.current = true;
  }, [qc]);

  const close = useCallback(() => {
    if (pushedRef.current && typeof window !== "undefined") {
      // Let popstate clear ticker from the restored URL (keeps Back stack honest).
      pushedRef.current = false;
      window.history.back();
      return;
    }
    setTicker(null);
    writeStockParam(null, "replace");
  }, []);

  // Sync browser Back / Forward with the sheet.
  useEffect(() => {
    const onPop = () => {
      const t = readStockParam();
      setTicker(t);
      pushedRef.current = false;
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Esc closes.
  useEffect(() => {
    if (!ticker) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [ticker, close]);

  // Lock body scroll while sheet is open (source page stays in DOM underneath).
  useEffect(() => {
    if (!ticker) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [ticker]);

  const value = useMemo(
    () => ({ ticker, returnLabel, open, close, prefetch }),
    [ticker, returnLabel, open, close, prefetch],
  );

  return (
    <Ctx.Provider value={value}>
      {children}
      {ticker ? (
        <div
          className="fixed inset-0 z-[90] flex flex-col bg-background"
          role="dialog"
          aria-modal="true"
          aria-label={`${ticker} breakdown`}
        >
          <div className="shrink-0 h-11 border-b border-[#d4af37]/25 bg-zinc-950 flex items-center gap-2 px-3">
            <button
              type="button"
              onClick={close}
              className="inline-flex items-center gap-1.5 h-8 px-2 rounded border border-[#d4af37]/30 text-[#d4af37] text-[12px] font-semibold hover:bg-[#d4af37]/10 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              {returnLabel}
            </button>
            <span className="font-mono font-bold text-white text-sm">{ticker}</span>
            <span className="text-[10px] text-amber-100/50 ml-auto">Esc</span>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <StockBreakdown ticker={ticker} />
          </div>
        </div>
      ) : null}
    </Ctx.Provider>
  );
}

export function useStockNav(): StockNav {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useStockNav requires StockNavProvider");
  return ctx;
}

/** Safe for optional use outside provider (returns null). */
export function useStockNavOptional(): StockNav | null {
  return useContext(Ctx);
}
