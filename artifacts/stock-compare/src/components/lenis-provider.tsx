/**
 * A127 — Lenis smooth scroll. Honors prefers-reduced-motion.
 * Charts/tables: add data-lenis-prevent (wheel hijack breaks zoom / inner scroll).
 * Top-level tabs: use AppPage (viewport scroll pane + data-lenis-prevent) — never
 * bare `pt-14` document scroll or overflow-x tables eat the wheel.
 */
import { useEffect, type ReactNode } from "react";
import Lenis from "lenis";
import "lenis/dist/lenis.css";

export function LenisProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const lenis = new Lenis({
      // Skip charts / tables / canvases — wheel zoom + pan must not become page scroll.
      prevent: (node: HTMLElement) => {
        if (node.closest("[data-lenis-prevent]")) return true;
        if (node.closest(".tv-lightweight-charts")) return true;
        if (node.tagName === "CANVAS") return true;
        return false;
      },
    });

    let raf = 0;
    const loop = (time: number) => {
      lenis.raf(time);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      lenis.destroy();
    };
  }, []);

  return <>{children}</>;
}
