'use client';

/**
 * A menu panel that cannot be clipped by whatever it sits inside.
 *
 * ── THE BUG THIS EXISTS FOR ──────────────────────────────────────────────
 * Every card in this product is `overflow-hidden rounded-xl`, because that is
 * what makes a table's first and last rows respect the rounded corner. A menu
 * rendered `absolute` inside one is therefore cut off at the card's edge — the
 * row menu on Admin → Users lost the right half of "Sign in as this user" and
 * the whole permission-template control under it.
 *
 * Raising the z-index does not help and is the usual wrong fix: `overflow`
 * clips descendants regardless of stacking. The panel has to leave the
 * container altogether, which means a portal.
 *
 * ── WHY `fixed` AND NOT `absolute` IN THE PORTAL ─────────────────────────
 * Once the panel is a child of `<body>`, an absolute position would be
 * measured against the page, so any scrolling ancestor between the trigger and
 * the body would offset it. `fixed` is measured against the viewport, which is
 * the same frame `getBoundingClientRect()` reports the trigger in — so the two
 * agree by construction rather than by arithmetic.
 *
 * The consequence is that the panel does not travel with a scrolling parent,
 * so it closes on scroll instead. A menu that follows its row halfway down the
 * page and then detaches is worse than one that shuts.
 *
 * ── IT FLIPS AND CLAMPS ──────────────────────────────────────────────────
 * Near the bottom of the window it opens upward; near the right edge it slides
 * back into view. Both are measured from the real panel after it mounts, not
 * guessed from an assumed height, because the panel's height depends on what
 * the caller put in it.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Distance between the trigger and the panel, and from the viewport edge. */
const GAP = 6;
const MARGIN = 8;

export function MenuSurface({
  open,
  onClose,
  /** The element the panel is positioned against. */
  anchorRef,
  /** Which edge of the trigger the panel lines up with. */
  align = 'right',
  width = 280,
  children,
  label,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  width?: number;
  children: ReactNode;
  label?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  /*
   * ── THE POSITION IS WRITTEN, NOT STORED ─────────────────────────────────
   * Measuring the panel and then setting state with the result renders twice
   * for every open, and React flags it: "Calling setState synchronously within
   * an effect can trigger cascading renders."
   *
   * A position is not application state — nothing else reads it and it is
   * recomputed from scratch on every open, scroll and resize. So it is applied
   * straight to the node. The effect measures and writes in the same pass,
   * which is also the only way to avoid a frame at the wrong coordinates.
   */
  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const a = anchor.getBoundingClientRect();
    const h = panel.offsetHeight;
    const w = panel.offsetWidth || width;

    /* Below by default; above when there is no room and more room up there. */
    const below = a.bottom + GAP;
    const flip = window.innerHeight - below < h && a.top - GAP - h > MARGIN;
    const top = flip ? a.top - GAP - h : below;

    const raw = align === 'right' ? a.right - w : a.left;
    /* Clamp into the viewport rather than letting it hang off an edge. */
    const left = Math.max(MARGIN, Math.min(raw, window.innerWidth - w - MARGIN));

    panel.style.top = `${Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))}px`;
    panel.style.left = `${left}px`;
    panel.style.visibility = 'visible';
  }, [align, anchorRef, width]);

  /*
   * `useLayoutEffect`, so the measurement and the write happen before paint —
   * with `useEffect` the panel is visible at 0,0 for a frame and then snaps,
   * which reads as a bug even though the final position is right.
   */
  useLayoutEffect(() => {
    if (!open) return;
    place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      /* The trigger handles its own toggle; closing here as well would make a
         click on it open and immediately shut the panel. */
      if (anchorRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    /* Capture, so a scroll inside any container reaches this. */
    const onScroll = () => onClose();

    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open, onClose, place, anchorRef]);

  /*
   * Focus the panel when it opens so the keyboard goes with it, and return it
   * to the trigger on close. Without the first half, Tab from an opened menu
   * walks the page behind it; without the second, closing strands the focus
   * ring on `<body>`.
   */
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus();
    return () => anchor?.focus?.();
  }, [open, anchorRef]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      aria-label={label}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width,
        /* Hidden until `place()` has measured it, which happens before paint. */
        visibility: 'hidden',
      }}
      className="z-[200] max-h-[min(70vh,520px)] overflow-y-auto rounded-xl border border-line bg-white p-1.5 shadow-[0_16px_40px_-12px_rgba(8,32,47,.32)]"
    >
      {children}
    </div>,
    document.body,
  );
}
