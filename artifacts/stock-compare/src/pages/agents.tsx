import { TopNav } from "@/components/top-nav";
import { AgentsTab } from "@/components/settings/AgentsTab";
import { useAuth } from "@/context/AuthContext";
import { Redirect } from "wouter";

/** Top-nav AI — admin Agents desk (was Settings › Agents). */
export default function AgentsPage() {
  const { isAdmin, isLoading } = useAuth();
  if (isLoading) {
    return (
      <div className="min-h-[100dvh] bg-zinc-900">
        <TopNav />
        <main className="pt-14 p-6">
          <p className="text-xs text-amber-200/40 animate-pulse">Loading…</p>
        </main>
      </div>
    );
  }
  if (!isAdmin) return <Redirect to="/live" />;

  return (
    <div className="min-h-[100dvh] bg-zinc-900">
      <TopNav />
      <main className="pt-14 p-4 max-w-6xl mx-auto">
        <AgentsTab />
      </main>
    </div>
  );
}
