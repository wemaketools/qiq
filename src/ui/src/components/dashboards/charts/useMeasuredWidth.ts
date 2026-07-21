import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Observed pixel width of the returned ref's element, so a Recharts chart can fill its card instead
 * of overflowing it at narrow viewports (the Won-vs-Lost trend spilled out of its card this way).
 * Returns `fallback` until a real measurement lands — and forever in jsdom, which performs no layout
 * (and reports 0 widths if a ResizeObserver polyfill fires) — preserving the deterministic
 * fixed-width rendering the chart-widget tests rely on (see BarChartWidget's width note).
 */
// The ref is `RefObject<T>`, not `RefObject<T | null>`: in @types/react 18 `RefObject<T>` already
// declares `current: T | null` (the extra `| null` is the React 19 typings' shape). Because
// `RefObject` is measured as covariant, `RefObject<T | null>` is rejected where a DOM `ref` prop
// wants `RefObject<T>` even though the two are structurally identical. `useRef<T>(null)` returns
// `RefObject<T>`, so this annotation now simply matches what the hook actually produces.
export function useMeasuredWidth<T extends HTMLElement>(fallback: number): { ref: React.RefObject<T>; width: number } {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const measured = entries[0]?.contentRect.width ?? 0;
      if (measured > 0) {
        setWidth(measured);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}
