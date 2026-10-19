/**
 * A127 — headline P&L / count accent (framer-motion). Honors prefers-reduced-motion.
 * Never use inside dense tables.
 */
import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

export function AnimatedNumber({
  value,
  format,
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(reduce ? value : 0);
  const fmt = format ?? ((n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 }));

  useEffect(() => {
    if (reduce) {
      setShown(value);
      return;
    }
    const start = shown;
    const delta = value - start;
    if (Math.abs(delta) < 1e-9) return;
    const t0 = performance.now();
    const dur = 450;
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / dur);
      const ease = 1 - (1 - p) ** 3;
      setShown(start + delta * ease);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // intentionally only re-run when value changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, reduce]);

  return (
    <motion.span
      className={className}
      key={reduce ? "static" : "anim"}
      initial={reduce ? false : { opacity: 0.7 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      {fmt(shown)}
    </motion.span>
  );
}
