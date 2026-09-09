'use client';

/**
 * PROTOTYPE — mount/unmount transitions.
 *
 * React removes a component from the tree the instant its condition goes
 * false, which means an exit animation never gets to run. `usePresence` keeps
 * the element mounted for exactly as long as its exit animation lasts, then
 * drops it.
 *
 * It reads `prefers-reduced-motion` and collapses the delay to zero when set,
 * so a user who has asked the operating system for less movement gets an
 * instant unmount rather than a slower one.
 */
import { useEffect, useRef, useState } from 'react';

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * @param open      whether the element should be visible
 * @param exitMs    how long the exit animation takes
 * @returns `mounted` — render nothing when false
 *          `state`   — 'in' | 'out', pick the animation class from it
 */
export function usePresence(open: boolean, exitMs = 140): {
  mounted: boolean;
  state: 'in' | 'out';
} {
  const [mounted, setMounted] = useState(open);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Opening must be synchronous, or the element misses its own entrance.
  if (open && !mounted) setMounted(true);

  useEffect(() => {
    if (open) {
      clearTimeout(timer.current);
      return;
    }
    if (!mounted) return;
    const wait = prefersReducedMotion() ? 0 : exitMs;
    timer.current = setTimeout(() => setMounted(false), wait);
    return () => clearTimeout(timer.current);
  }, [open, mounted, exitMs]);

  return { mounted, state: open ? 'in' : 'out' };
}

/** Pick one of two class names by presence state. Keeps JSX readable. */
export function anim(state: 'in' | 'out', inClass: string, outClass: string): string {
  return state === 'in' ? inClass : outClass;
}
