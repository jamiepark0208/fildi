import { Sidebar } from "@/components/sidebar";
import { StockBreakdown } from "@/components/stock-breakdown";

export default function Breakdown() {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground flex">
      <Sidebar />
      <main className="flex-1 ml-[220px] flex flex-col h-[100dvh] overflow-hidden">
        <div className="shrink-0 border-b border-border bg-background px-6 py-4">
          <h1 className="text-lg font-bold tracking-tight leading-none">Stock Breakdown</h1>
          <p className="text-xs text-muted-foreground mt-0.5">Deep-dive fundamentals for any ticker</p>
        </div>
        <StockBreakdown />
      </main>
    </div>
  );
}
