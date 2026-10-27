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
 * A `fixed` panel does not travel with a scrolling parent on its own, so it is
 * RE-PLACED on every scroll — see `onScroll` below. It used to close instead,
 * which was reported: the drawer scrolls under your cursor as you reach for an
 * option and the menu vanishes. Re-placing is strictly better, as long as the
 * panel stops following an anchor that has itself scrolled out of sight.
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
  role = 'menu',
  padded = true,
  cover = false,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  width?: number;
  children: ReactNode;
  label?: string;
  /** `dialog` for a panel with inputs (a form), `menu` for a list of actions. */
  role?: 'menu' | 'dialog';
  /** The menu's own inner padding; off when the content brings its own. */
  padded?: boolean;
  /**
   * Open OVER the anchor instead of below it — a box that grows out of the
   * field it edits (Long text, UI spec §4). Still clamped into the viewport.
   */
  cover?: boolean;
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
    const top = cover ? a.top - 4 : flip ? a.top - GAP - h : below;

    const raw = cover ? a.left - 4 : align === 'right' ? a.right - w : a.left;
    /* Clamp into the viewport rather than letting it hang off an edge. */
    const left = Math.max(MARGIN, Math.min(raw, window.innerWidth - w - MARGIN));

    panel.style.top = `${Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN))}px`;
    panel.style.left = `${left}px`;
  }, [align, anchorRef, width, cover]);

  /*
   * ── RE-PLACED AFTER EVERY RENDER, DELIBERATELY WITH NO DEPS ───────────
   * Two reasons, and the first was a real bug.
   *
   * 1. React owns the `style` PROP. Anything listed there is re-applied on
   *    every re-render, so a `top`/`left` written imperatively was reset to
   *    the prop's values the moment the panel's contents changed — staging a
   *    template, a notice appearing — and the panel jumped or vanished
   *    mid-use. The prop now carries only `position` and `width`; React never
   *    sees the coordinates, so it cannot clobber them.
   *
   * 2. The panel's HEIGHT changes with its contents. A menu that grows a
   *    warning paragraph after opening near the bottom of the window has to be
   *    re-measured, or it hangs off the edge it was just flipped away from.
   *
   * No dependency array: this must run after every committed render, and
   * `place()` is cheap — two reads and three writes on one element.
   */
  useLayoutEffect(() => {
    if (!open) return;
    place();
  });

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
    /*
     * ── SCROLL FOLLOWS THE ANCHOR; IT DOES NOT CLOSE THE MENU ────────────
     * This closed the panel outright, which is what made the picker in the
     * record drawer unusable: the drawer is a scroll container, the list of
     * people is taller than the space under the trigger, and the smallest
     * wheel movement while reading the list dismissed it.
     *
     * `place()` already derives everything from `getBoundingClientRect()`,
     * which is viewport-relative — the same frame a `fixed` panel is laid out
     * in. So re-running it on scroll is all that following the anchor takes;
     * there is no offset arithmetic to get wrong.
     *
     * One case still has to close: the anchor scrolling out of view. A panel
     * clamped to the viewport edge while its trigger is gone floats over
     * unrelated content with nothing to explain it, which is the complaint
     * the old `onClose()` was avoiding. So the panel follows while any part of
     * the trigger is on screen and shuts once none of it is.
     *
     * Throttled to one placement per frame: a capture-phase scroll listener on
     * `window` fires for every nested scroller, and a wheel gesture produces
     * far more events than frames.
     */
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const a = anchorRef.current?.getBoundingClientRect();
        if (!a) return;
        const offScreen = a.bottom <= 0 || a.top >= window.innerHeight;
        if (offScreen) onClose();
        else place();
      });
    };

    /*
     * Escape is taken in the CAPTURE phase. The record drawer closes on
     * Escape with its own listener on `document`, registered earlier, so a
     * bubble-phase listener here ran second and `stopPropagation()` was too
     * late: Escape in a field's @ box closed the whole drawer. Capturing
     * runs first and stops the event before the drawer ever sees it.
     */
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
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
      role={role}
      aria-label={label}
      /*
       * Only what React may own. `top`, `left` and `visibility` are written by
       * `place()` and deliberately absent here — see the effect above. No
       * initial hiding is needed because `useLayoutEffect` runs before paint,
       * so the first frame the browser draws is already positioned.
       */
      style={{ position: 'fixed', width }}
      className={`z-[200] max-h-[min(70vh,520px)] overflow-y-auto rounded-xl border border-line bg-white shadow-[0_16px_40px_-12px_rgba(8,32,47,.32)] ${padded ? 'p-1.5' : ''}`}
    >
      {children}
    </div>,
    document.body,
  );
}
