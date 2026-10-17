import { useEffect } from "react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

/**
 * Real 404s are rare in-app. During Vite HMR, a stale lazy chunk can briefly
 * land here ("Did you forget…") — auto-recover once instead of flashing logout UI.
 */
export default function NotFound() {
  useEffect(() => {
    let timer: number | undefined;
    try {
      if (sessionStorage.getItem("fildi_notfound_reload") === "1") {
        sessionStorage.removeItem("fildi_notfound_reload");
      } else {
        sessionStorage.setItem("fildi_notfound_reload", "1");
        timer = window.setTimeout(() => window.location.reload(), 150);
      }
    } catch { /* storage blocked */ }
    return () => {
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-zinc-900">
      <Card className="w-full max-w-md mx-4 border-[#d4af37]/25 bg-zinc-950">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2 items-center">
            <AlertCircle className="h-6 w-6 text-amber-400" />
            <h1 className="text-lg font-bold text-white">Page not found</h1>
          </div>
          <p className="text-sm text-white">
            Reloading… If this sticks, go back to{" "}
            <Link href="/watchlist" className="text-[#d4af37] underline">Watchlist</Link>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
