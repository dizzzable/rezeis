import { useEffect, useRef, useState } from 'react';
import { useAppearanceStore } from '@/lib/theme/appearance-store';

interface CountUpProps {
  /** Target numeric value. */
  value: number;
  /** Animation duration in ms (default 700). */
  duration?: number;
  /** Number of decimals to render (default 0). */
  decimals?: number;
  className?: string;
  prefix?: string;
  suffix?: string;
}

/**
 * Animated numeric counter using requestAnimationFrame.
 *
 * Honours the `animationsEnabled` toggle from `AppearanceStore` and the
 * user's `prefers-reduced-motion`. When animations are off, the value
 * jumps to its final state in one frame.
 *
 * Re-runs whenever `value` changes, easing from the previous render
 * value so realtime cache updates (Phase 1) feel smooth.
 */
export function CountUp({
  value,
  duration = 700,
  decimals = 0,
  className,
  prefix,
  suffix,
}: CountUpProps) {
  const animationsEnabled = useAppearanceStore((s) => s.animationsEnabled);
  const reducedMotion = useReducedMotion();
  const previousValue = useRef<number>(value);
  const [display, setDisplay] = useState<number>(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const start = previousValue.current;
    const end = value;
    const startTime = performance.now();
    if (!animationsEnabled || reducedMotion) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- TODO: refactor to derive state
      setDisplay(end);
      previousValue.current = end;
      return;
    }
    if (start === end) return;

    function tick(now: number): void {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(progress);
      const current = start + (end - start) * eased;
      setDisplay(current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        previousValue.current = end;
      }
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [value, duration, animationsEnabled, reducedMotion]);

  const rendered = decimals > 0 ? display.toFixed(decimals) : Math.round(display).toString();
  return (
    <span className={className}>
      {prefix}
      {rendered}
      {suffix}
    </span>
  );
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  return reduced;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}
