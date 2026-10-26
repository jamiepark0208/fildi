import { AppPage } from "@/components/app-page";
import { AgentsTab } from "@/components/settings/AgentsTab";
import { useAuth } from "@/context/AuthContext";
import { Redirect } from "wouter";

/** Top-nav AI — admin Agents desk (was Settings › Agents). */
export default function AgentsPage() {
  const { isAdmin, isLoading } = useAuth();
  if (isLoading) {
    return (
      <AppPage contentClassName="px-6 pb-6">
        <p className="text-xs text-amber-200/40 animate-pulse">Loading…</p>
      </AppPage>
    );
  }
  if (!isAdmin) return <Redirect to="/live" />;

  return (
    <AppPage contentClassName="px-3 pb-4">
      <div className="max-w-[1600px] mx-auto min-w-0">
        <AgentsTab />
      </div>
    </AppPage>
  );
}
