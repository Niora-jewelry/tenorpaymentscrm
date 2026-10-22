'use client';

/**
 * Landing on a mention: scroll the item into view and flash it for a moment.
 * One hook, used by the update thread, the case card and the field cell, so
 * every way into a mention looks the same when it arrives.
 */
import { useEffect, useState } from 'react';

export const FLASH_MS = 4_000;

/** DOM ids the deep link scrolls to. */
export const targetId = {
  update: (id: string) => `update-${id}`,
  case: (id: string) => `case-${id}`,
  reply: (id: string) => `reply-${id}`,
  field: (key: string) => `field-${key}`,
};

/** True while the element should be highlighted; scrolls it into view once. */
export function useFlashTarget(elementId: string, active: boolean): boolean {
  const [flashing, setFlashing] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    // After paint, and after a collapsed parent has had a frame to open.
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      document.getElementById(elementId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setFlashing(true);
    });
    const t = setTimeout(() => {
      if (!cancelled) setFlashing(false);
    }, FLASH_MS);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      clearTimeout(t);
    };
  }, [elementId, active]);
  return flashing;
}

/** The ring that says "this is the one". */
export const FLASH_CLASS = 'ring-2 ring-accent ring-offset-2 ring-offset-white';
