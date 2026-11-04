import { AppPage } from "@/components/app-page";
import { BacktestLabPanel } from "@/components/backtest/backtest-lab-panel";
import { useAuth } from "@/context/AuthContext";
import { Redirect } from "wouter";

/** A331 — interactive backtest (also linked from Settings › Inbox › Research). */
export default function BacktestLabPage() {
  const { isAdmin, isLoading } = useAuth();
  if (isLoading) {
    return (
      <AppPage contentClassName="px-4 pb-4">
        <p className="text-xs text-amber-200/40 animate-pulse">Loading…</p>
      </AppPage>
    );
  }
  if (!isAdmin) return <Redirect to="/live" />;

  return (
    <AppPage contentClassName="px-3 pb-4">
      <div className="max-w-[1600px] mx-auto min-w-0">
        <BacktestLabPanel />
      </div>
    </AppPage>
  );
}
