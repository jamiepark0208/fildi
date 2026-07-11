import { Sidebar } from "@/components/sidebar";

// Suspense fallback for lazy-loaded routes: sidebar paints immediately,
// only the main content area shows pulse placeholders (enh/34 Wave B).
export function PageSkeleton() {
  return (
    <div className="flex h-[100dvh] bg-background">
      <Sidebar />
      <main
        className="flex-1 min-w-0 p-6 space-y-4"
        style={{ marginLeft: "var(--sidebar-w, 220px)", transition: "margin-left 200ms ease" }}
      >
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
