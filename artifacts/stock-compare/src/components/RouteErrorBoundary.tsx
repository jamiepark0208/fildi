import { Component, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { AlertTriangle } from "lucide-react";
import { reportUiCrash } from "@/lib/report-ui-crash";

interface Props {
  children: ReactNode;
  onReset?: () => void;
}

interface State {
  error: Error | null;
}

export class RouteErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: { componentStack: string }) {
    Sentry.captureException(error, { extra: { componentStack: info.componentStack } });
    reportUiCrash({
      message: error?.message ?? "RouteErrorBoundary",
      source: "RouteErrorBoundary",
      stack: `${error?.stack ?? ""}\n${info.componentStack ?? ""}`.slice(0, 1500),
    });
    // Stale Vite lazy chunk after HMR — one silent reload instead of a scary card.
    const msg = error?.message ?? "";
    if (/Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk/i.test(msg)) {
      try {
        if (sessionStorage.getItem("fildi_chunk_reload") !== "1") {
          sessionStorage.setItem("fildi_chunk_reload", "1");
          window.location.reload();
          return;
        }
        sessionStorage.removeItem("fildi_chunk_reload");
      } catch { /* */ }
    }
  }

  private handleRetry = () => {
    this.props.onReset?.();
    this.setState({ error: null });
  };

  override render() {
    if (this.state.error) {
      return (
        <div className="min-h-[60vh] w-full flex items-center justify-center p-4">
          <Card className="w-full max-w-md">
            <CardContent className="pt-6 flex flex-col items-center text-center gap-3">
              <AlertTriangle className="h-8 w-8 text-destructive" />
              <h1 className="text-lg font-semibold">Something went wrong on this page</h1>
              <p className="text-sm text-muted-foreground">
                {this.state.error.message || "An unexpected error occurred."}
              </p>
              <div className="flex gap-2 mt-2">
                <Button variant="outline" onClick={this.handleRetry}>Retry</Button>
                <Button asChild>
                  <Link href="/">Home</Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      );
    }
    return this.props.children;
  }
}
