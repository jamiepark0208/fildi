import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Mount children only after the sentinel enters (or nears) the viewport.
 * Keeps heavy Portfolio / research panels off the critical path.
 */
export function LazyMount({
  children,
  rootMargin = "240px 0px",
  minHeight = 120,
  fallback = null,
  onReady,
}: {
  children: ReactNode;
  rootMargin?: string;
  minHeight?: number;
  fallback?: ReactNode;
  /** Fires once when children mount (viewport near). */
  onReady?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready) return;
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setReady(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setReady(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ready, rootMargin]);

  useEffect(() => {
    if (ready) onReadyRef.current?.();
  }, [ready]);

  return (
    <div ref={ref} style={ready ? undefined : { minHeight }}>
      {ready ? children : fallback}
    </div>
  );
}
