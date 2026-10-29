import { TopNav } from "@/components/top-nav";

// Suspense fallback for lazy-loaded routes: nav paints immediately,
// only the main content area shows pulse placeholders (enh/34 Wave B).
export function PageSkeleton() {
  return (
    <div className="h-[100dvh] overflow-hidden bg-background">
      <TopNav />
      <main className="mt-14 p-6 space-y-4">
        <div className="h-8 w-48 bg-white/10 rounded animate-pulse" />
        <div className="grid grid-cols-3 gap-4">
          <div className="h-24 bg-white/10 rounded animate-pulse" />
          <div className="h-24 bg-white/10 rounded animate-pulse" />
          <div className="h-24 bg-white/10 rounded animate-pulse" />
        </div>
        <div className="h-64 bg-white/10 rounded animate-pulse" />
      </main>
    </div>
  );
}
