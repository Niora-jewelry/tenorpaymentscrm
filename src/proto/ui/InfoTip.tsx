'use client';

/**
 * The (i) beside a field label that holds its helper text.
 *
 * UI spec 7.1 (approved): helper text moves out from under the field and into
 * a tooltip, because text printed under some fields and not others is what
 * made the boxes in one row different heights.
 *
 * Portalled to the body and positioned against the icon, so a card's own
 * overflow or a neighbouring card cannot clip or cover it. Opens on hover and
 * on keyboard focus, and toggles on tap, which is the only way to reach it on
 * a touch screen. The text is also the button's accessible description, so a
 * screen reader hears it without opening anything.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';

const GAP = 6;
const MARGIN = 8;
const WIDTH = 260;

export function InfoTip({ text, label }: { text: string; label?: string }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const id = useId();

  /* Written straight to the node, measured in the same pass — no frame at the
     wrong place, no second render (same idiom as MenuSurface). */
  useLayoutEffect(() => {
    if (!open || !btn.current || !tip.current) return;
    const a = btn.current.getBoundingClientRect();
    const t = tip.current;
    const w = Math.min(WIDTH, window.innerWidth - MARGIN * 2);
    t.style.width = `${w}px`;
    const left = Math.max(MARGIN, Math.min(a.left + a.width / 2 - w / 2, window.innerWidth - w - MARGIN));
    const h = t.offsetHeight;
    const above = a.top - GAP - h >= MARGIN;
    t.style.left = `${left}px`;
    t.style.top = `${above ? a.top - GAP - h : a.bottom + GAP}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    const onDown = (e: PointerEvent) => {
      if (!btn.current?.contains(e.target as Node)) close();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label ? `About ${label}` : 'More information'}
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.preventDefault();
          setOpen((o) => !o);
        }}
        className="inline-grid size-4 shrink-0 place-items-center rounded-full text-ink-300 transition-colors hover:text-ink-600 focus-visible:text-ink-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-600/30"
      >
        <Icon name="info" size={12} />
      </button>
      {/* Always in the DOM (visually hidden when closed) so aria-describedby
          resolves; portalled only while open. */}
      <span id={id} className="sr-only">{text}</span>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={tip}
              role="tooltip"
              className="pointer-events-none fixed z-[200] rounded-lg bg-ink-900 px-2.5 py-2 text-[12px] font-normal normal-case leading-snug tracking-normal text-white shadow-[0_8px_24px_-6px_rgba(8,32,47,.35)] animate-pop-in"
            >
              {text}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
