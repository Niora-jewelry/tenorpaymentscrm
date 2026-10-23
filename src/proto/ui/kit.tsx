'use client';

/**
 * PROTOTYPE — the shared component kit.
 *
 * The pill catalogue from the Module 2 plan §9.1, built once. Every pill in the
 * product comes from here so they stay consistent: rounded-full, 11.5px,
 * weight 600, .04em tracking. Never more than two pill colours in one table row.
 *
 * Popovers and dialogs animate in AND out — see `motion.tsx` for why that needs
 * more than a CSS class.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Swatch, User } from '../schema';
import { SWATCHES, NEUTRAL } from './tokens';
import { PersonAvatar, resolvePerson, usePeopleById } from './people';
import { Icon, type IconName } from './icons';
import { anim, usePresence } from './motion';

/* -------------------------------------------------------------------------- */
/* Status pill                                                                 */
/* -------------------------------------------------------------------------- */

export function StatusPill({
  label,
  swatch,
  dot = true,
  size = 'sm',
}: {
  label: string;
  swatch?: Swatch;
  dot?: boolean;
  size?: 'sm' | 'md';
}) {
  const s = swatch ? SWATCHES[swatch] : NEUTRAL;
  return (
    <span
      className={`inline-flex max-w-full items-center gap-1.5 rounded-full border font-semibold tracking-[.03em] shadow-[inset_0_1px_0_rgba(255,255,255,.6)] ${
        size === 'md' ? 'px-2.5 py-1 text-[12px]' : 'px-2 py-[2.5px] text-[11.5px]'
      }`}
      style={{ background: s.bg, color: s.text, borderColor: s.border }}
    >
      {dot ? (
        <span
          aria-hidden
          className="size-[6px] shrink-0 rounded-full ring-1 ring-inset ring-black/5"
          style={{ background: s.dot }}
        />
      ) : null}
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Neutral outline chip — archived records, system markers, tags. */
export function OutlineChip({
  children,
  tone = 'neutral',
  icon,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'brand' | 'warn' | 'danger';
  icon?: IconName;
}) {
  const tones = {
    neutral: 'border-line text-ink-500 bg-white',
    brand: 'border-brand-100 bg-brand-50 text-brand-700',
    warn: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]',
    // Same three values as the `danger` Button variant, so a destructive or
    // retired state reads identically whether it is a chip or a control.
    danger: 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]',
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2.5px] text-[11.5px] font-semibold tracking-[.03em] shadow-[inset_0_1px_0_rgba(255,255,255,.6)] ${tones[tone]}`}
    >
      {icon ? <Icon name={icon} size={11} strokeWidth={2} /> : null}
      {children}
    </span>
  );
}

/**
 * "New" — a lime dot next to anything introduced in the LATEST changelog
 * entry (`src/proto/changelog.ts`). No dismiss state: it stops applying
 * automatically the moment a newer entry lands above the current one, so
 * there is nothing to mark as read and nothing that can get stuck showing
 * "new" forever.
 */
export function NewBadge({ compact }: { compact?: boolean }) {
  return (
    <span
      title="Introduced in the latest change — see “What’s changed” on the overview page"
      className={`inline-flex items-center gap-1 rounded-full bg-accent font-bold uppercase tracking-[.04em] text-accent-ink ${
        compact ? 'px-1 py-0 text-[8.5px]' : 'px-1.5 py-[1px] text-[9.5px]'
      }`}
    >
      New
    </span>
  );
}

/** Tab strip counts. Neutral — a quantity, never a state. */
export function CountPill({ n, active }: { n: number; active?: boolean }) {
  return (
    <span
      className={`ml-1.5 inline-flex min-w-[18px] justify-center rounded-full px-1.5 py-px text-[11px] font-semibold tabular transition-colors ${
        active ? 'bg-brand-100 text-brand-700' : 'bg-canvas text-ink-400'
      }`}
    >
      {n}
    </span>
  );
}

/** Completeness — "3 of 5". Semantic colour by ratio, never brand colour. */
export function CompletenessBadge({ have, need }: { have: number; need: number }) {
  const ratio = need === 0 ? 1 : have / need;
  const tone =
    ratio >= 1
      ? { bg: '#e0f5f1', text: '#0b7466', border: '#c2e9e1' }
      : ratio >= 0.5
        ? { bg: '#fdf1d8', text: '#8a5a09', border: '#f7e0af' }
        : { bg: '#fce9ea', text: '#b02a30', border: '#f7cfd1' };
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border px-2 py-[2.5px] text-[11.5px] font-semibold tabular tracking-[.03em] shadow-[inset_0_1px_0_rgba(255,255,255,.6)]"
      style={{ background: tone.bg, color: tone.text, borderColor: tone.border }}
    >
      {ratio >= 1 ? <Icon name="check" size={11} strokeWidth={2.5} /> : null}
      {have} of {need}
    </span>
  );
}

export function CaseStatePill({ state }: { state: 'open' | 'closed' }) {
  return state === 'open' ? (
    <StatusPill label="Open" swatch="amber" />
  ) : (
    <StatusPill label="Closed" swatch="teal" dot={false} />
  );
}

/* -------------------------------------------------------------------------- */
/* People                                                                      */
/* -------------------------------------------------------------------------- */

export function Avatar({ user, size = 22 }: { user: User; size?: number }) {
  return (
    <span
      title={`${user.name} · ${user.role}`}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `hsl(${user.hue} 52% 42%)`,
      }}
    >
      {user.initials}
    </span>
  );
}

/**
 * The team-member field, drawn.
 *
 * Resolves through `usePeopleById()` (`people.tsx`), which falls back to the
 * prototype's own `USERS` fixture when nothing provides a real roster — so this
 * renders the same on `/prototype/*` as it always did, and renders real
 * colleagues under `(app)/layout.tsx`'s `PeopleProvider`.
 *
 * An id it cannot resolve is DRAWN, as a grey "?", not filtered away. This used
 * to `.filter(Boolean)`, which meant a member whose profile was later
 * soft-deleted silently disappeared from the one field that decides who can see
 * the record — no error, nothing to notice.
 */
export function AvatarStack({ ids, max = 3 }: { ids: string[]; max?: number }) {
  const byId = usePeopleById();
  const list = Array.isArray(ids) ? ids : [];
  if (!list.length) return <span className="text-ink-400">—</span>;
  const people = list.map((id) => resolvePerson(id, byId));
  const shown = people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span className="inline-flex items-center">
      <span className="flex -space-x-1.5">
        {shown.map((p) => (
          <PersonAvatar key={p.id} person={p} />
        ))}
      </span>
      {extra > 0 ? <span className="ml-1.5 text-[12px] text-ink-400">+{extra}</span> : null}
      {shown.length === 1 && extra === 0 ? (
        <span className="ml-2 truncate text-[13px] text-ink-700">{shown[0]!.name}</span>
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The one spinner in the app.
 *
 * `currentColor` so it inherits whatever it sits inside — a primary button, a
 * ghost button, a line of body text — instead of needing a variant per
 * context. Sized in `em` for the same reason: it scales with the type around
 * it and never has to be re-tuned per call site.
 *
 * `aria-hidden` because a spinner is decoration: the accessible signal is the
 * button's own `aria-busy` and its label changing to "Saving…", which a screen
 * reader announces. A labelled spinner on top of that is duplicate noise.
 */
export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={`size-[1em] animate-spin ${className}`}
      fill="none"
    >
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeOpacity=".25" strokeWidth="2" />
      <path
        d="M14.25 8A6.25 6.25 0 0 0 8 1.75"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

type BtnProps = {
  children?: ReactNode;
  onClick?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  disabled?: boolean;
  title?: string;
  icon?: IconName;
  iconRight?: IconName;
  type?: 'button' | 'submit';
  /**
   * Work is in flight. Swaps the leading icon for a spinner and disables the
   * button, so a slow action cannot be fired twice by an impatient second
   * click — which on a create form means two records, and on a destructive
   * confirm means the action running twice.
   *
   * Deliberately separate from `disabled`: "busy" and "not allowed" look the
   * same to CSS but mean different things to a screen reader, so this sets
   * `aria-busy` as well.
   */
  loading?: boolean;
  /** Replaces the label while `loading`. Say what is happening — "Creating…"
   *  beats a bare spinner, which never says whether anything is happening at
   *  all or the click was simply lost. */
  loadingLabel?: ReactNode;
};

export function Button({
  children,
  onClick,
  variant = 'secondary',
  size = 'md',
  disabled,
  title,
  icon,
  iconRight,
  type = 'button',
  loading = false,
  loadingLabel,
}: BtnProps) {
  // `cursor-pointer` is explicit because Tailwind v4's preflight sets buttons
  // to `cursor: default` — without it the only control on a confirm dialog
  // gives no pointer at all, while the plain links beside it do. The
  // `disabled:` pair below already assumed a pointer was there to override.
  const base =
    'inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-lg font-semibold transition-[background-color,border-color,color,box-shadow,transform] duration-150 active:scale-[.98] disabled:cursor-not-allowed disabled:opacity-45 disabled:active:scale-100';
  const sizes = { sm: 'px-2.5 py-1.5 text-[12.5px]', md: 'px-3.5 py-2 text-[13.5px]' };
  const variants = {
    // The single lime action per screen. Lime is a FILL with dark text.
    primary: 'bg-accent text-accent-ink hover:bg-accent-dim shadow-[0_1px_2px_rgba(8,32,47,.08)]',
    secondary: 'border border-line bg-white text-ink-700 hover:bg-canvas hover:border-ink-400',
    ghost: 'text-ink-500 hover:bg-canvas hover:text-ink-900',
    danger: 'border border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30] hover:bg-[#f9dcde]',
  };
  return (
    <button
      type={type}
      title={title}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      onClick={onClick}
      className={`${base} ${sizes[size]} ${variants[variant]}`}
    >
      {/* The spinner takes the leading icon's slot rather than being appended,
          so the button's width does not jump the moment it is clicked. */}
      {loading ? <Spinner /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {loading && loadingLabel !== undefined ? loadingLabel : children}
      {iconRight && !loading ? <Icon name={iconRight} size={size === 'sm' ? 13 : 15} /> : null}
    </button>
  );
}

/** Square icon-only button. Always carries a title, since it has no label. */
export function IconButton({
  icon,
  title,
  onClick,
  tone = 'ghost',
  size = 30,
}: {
  icon: IconName;
  title: string;
  onClick?: () => void;
  tone?: 'ghost' | 'danger';
  size?: number;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      style={{ width: size, height: size }}
      className={`grid place-items-center rounded-lg transition-colors duration-150 active:scale-95 ${
        tone === 'danger'
          ? 'text-ink-400 hover:bg-[#fce9ea] hover:text-[#b02a30]'
          : 'text-ink-400 hover:bg-canvas hover:text-ink-900'
      }`}
    >
      <Icon name={icon} size={Math.round(size * 0.53)} />
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Number input — the ONE numeric control in the product                       */
/* -------------------------------------------------------------------------- */

/**
 * Nothing this CRM stores can be negative: monthly volume, average ticket,
 * every fee, every percentage, MID, MCC, EIN, equipment count. A bare
 * `<input type="number">` happily accepts `-1` by typing, by pasting, and by
 * holding the down-spinner past zero — and then the value reaches the database
 * and every total downstream is wrong.
 *
 * So there is exactly one numeric input in the product and it refuses negatives
 * on all four paths:
 *
 *   typing   — the minus, plus and exponent keys are swallowed
 *   spinner  — `min` stops the browser stepping below the floor
 *   pasting  — the sign is stripped out of the pasted text
 *   anything — the value is clamped again before it leaves the component
 *
 * If a genuinely signed field ever appears (a residual clawback is the only
 * plausible one), give it `min={undefined}` at that call site rather than
 * loosening this default.
 */
export function NumberInput({
  value,
  defaultValue,
  onCommit,
  onLiveChange,
  min = 0,
  max,
  step = 'any',
  placeholder,
  className = '',
  align = 'left',
  inputRef,
  disabled,
  readOnly,
  onEscape,
}: {
  /** Controlled value. Omit for an uncontrolled input. */
  value?: number | string;
  defaultValue?: number | string;
  /** Fires on blur — for click-to-edit fields. */
  onCommit?: (n: number | null) => void;
  /** Fires on every keystroke — for filters and live controls. */
  onLiveChange?: (n: number | null) => void;
  min?: number;
  max?: number;
  step?: number | 'any';
  placeholder?: string;
  className?: string;
  align?: 'left' | 'right';
  inputRef?: React.Ref<HTMLInputElement>;
  disabled?: boolean;
  readOnly?: boolean;
  /** Escape pressed — for a caller that opened this in place and wants out. */
  onEscape?: () => void;
}) {
  const clamp = (raw: string): number | null => {
    if (raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n)) return null;
    let out = n;
    if (min != null) out = Math.max(min, out);
    if (max != null) out = Math.min(max, out);
    return out;
  };

  return (
    <input
      ref={inputRef}
      type="number"
      inputMode="decimal"
      min={min}
      max={max}
      step={step}
      value={value}
      defaultValue={defaultValue}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      onKeyDown={(e) => {
        // A minus or plus would sign the value; `e` is scientific notation.
        // None of the three means anything for a volume, a fee or an MCC code.
        if (['-', '+', 'e', 'E'].includes(e.key)) e.preventDefault();
        // Enter commits. `blur()` rather than calling `onCommit` directly, so
        // the clamp-and-rewrite in `onBlur` still runs — pressing Enter on an
        // out-of-range number must land the same value that tabbing away does.
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { e.preventDefault(); onEscape?.(); }
      }}
      onPaste={(e) => {
        const text = e.clipboardData.getData('text');
        if (!/[-+eE]/.test(text)) return;
        e.preventDefault();
        const cleaned = text.replace(/[^0-9.]/g, '');
        const el = e.currentTarget;
        /*
         * `type="number"` inputs report selectionStart as null, so the pasted
         * text replaces the field rather than being spliced at the cursor.
         * Setting `.value` directly skips React's synthetic onChange, so the
         * native setter is used and an input event dispatched by hand.
         */
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        setter?.call(el, cleaned);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }}
      onChange={(e) => onLiveChange?.(clamp(e.currentTarget.value))}
      onBlur={(e) => {
        const n = clamp(e.currentTarget.value);
        // Rewrite the box if the clamp changed anything, so the user never sees
        // a value the record does not hold.
        if (n !== null && String(n) !== e.currentTarget.value) e.currentTarget.value = String(n);
        onCommit?.(n);
      }}
      className={`tabular ${align === 'right' ? 'text-right' : ''} ${className}`}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Popover                                                                     */
/* -------------------------------------------------------------------------- */

export function Popover({
  trigger,
  children,
  align = 'left',
  side = 'bottom',
  width = 260,
}: {
  trigger: (open: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  /**
   * `bottom` drops below the trigger. `right` opens beside it, anchored to its
   * bottom edge — for triggers that already sit at the bottom of the viewport,
   * where dropping down would put the panel off-screen. `top` opens above the
   * trigger for the same reason (the floating bulk bar's Move picker).
   */
  side?: 'bottom' | 'right' | 'top';
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const { mounted, state } = usePresence(open, 110);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="block text-left">
        {trigger(open)}
      </button>
      {mounted ? (
        <div
          style={{ width }}
          className={`absolute z-50 rounded-xl border border-line bg-white p-2 shadow-[0_12px_32px_-8px_rgba(8,32,47,.22)] ${
            side === 'right'
              ? 'bottom-0 left-[calc(100%+10px)] origin-bottom-left'
              : side === 'top'
                ? `bottom-[calc(100%+6px)] origin-bottom ${align === 'right' ? 'right-0' : 'left-0'}`
                : `top-[calc(100%+6px)] origin-top ${align === 'right' ? 'right-0' : 'left-0'}`
          } ${anim(state, 'animate-pop-in', 'animate-pop-out')}`}
        >
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Dialog — Archive is neutral, Delete is danger. Distinct on purpose          */
/* -------------------------------------------------------------------------- */

export function Dialog({
  title,
  tone = 'neutral',
  children,
  confirmLabel,
  confirmIcon,
  onConfirm,
  onClose,
  width = 460,
}: {
  title: string;
  tone?: 'neutral' | 'danger';
  children: ReactNode;
  /** Omit for a dialog whose actions live in its BODY rather than its footer —
   * the offboarding flow, where step 1 and step 2 are separate writes and a
   * single footer confirm could only mean one of them. Without it the footer is
   * one Close button, and there is no primary action to mislabel. */
  confirmLabel?: string;
  confirmIcon?: IconName;
  onConfirm?: () => void;
  onClose: () => void;
  width?: number;
}) {
  /*
   * The dialog owns an `open` flag of its own so that closing plays the exit
   * animation before the parent unmounts it. `close()` flips the flag, then
   * tells the parent once the animation has finished.
   */
  const [open, setOpen] = useState(true);
  const { mounted, state } = usePresence(open, 130);

  const dismiss = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dismiss();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismiss]);

  useEffect(() => {
    if (!mounted) onClose();
  }, [mounted, onClose]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div
        className={`absolute inset-0 bg-brand-950/35 ${anim(state, 'animate-fade-in', 'animate-fade-out')}`}
        onClick={dismiss}
      />
      <div
        role="dialog"
        aria-modal="true"
        style={{ maxWidth: width }}
        className={`relative w-full rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)] ${anim(state, 'animate-dialog-in', 'animate-dialog-out')}`}
      >
        <div className="flex items-start gap-3">
          {tone === 'danger' ? (
            <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-[#fce9ea] text-[#b02a30]">
              <Icon name="alert-triangle" size={16} strokeWidth={2} />
            </span>
          ) : null}
          <h2
            className={`text-[16px] font-semibold ${tone === 'danger' ? 'text-[#b02a30]' : 'text-ink-900'}`}
          >
            {title}
          </h2>
        </div>
        <div className="mt-2 space-y-2 text-[13.5px] leading-relaxed text-ink-500">{children}</div>
        <div className="mt-5 flex justify-end gap-2">
          {confirmLabel === undefined ? (
            <Button variant="secondary" onClick={dismiss}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={dismiss}>
                Cancel
              </Button>
              <Button
                variant={tone === 'danger' ? 'danger' : 'primary'}
                icon={confirmIcon}
                onClick={() => {
                  onConfirm?.();
                  setOpen(false);
                }}
              >
                {confirmLabel}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Floating bar — one component, used by bulk actions and by result reports    */
/* -------------------------------------------------------------------------- */

export function FloatingBar({
  open,
  lead,
  children,
  onClose,
  align = 'center',
}: {
  open: boolean;
  /** The left-hand content: a selection count, a result summary. */
  lead: ReactNode;
  children?: ReactNode;
  onClose?: () => void;
  align?: 'center' | 'stack';
}) {
  const { mounted, state } = usePresence(open, 130);
  if (!mounted) return null;

  return (
    <div
      className={`pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4 ${
        align === 'stack' ? 'bottom-[5.5rem]' : 'bottom-6'
      }`}
    >
      <div
        className={`pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-1 rounded-2xl border border-line/80 bg-white/95 py-1.5 pl-3 pr-1.5 shadow-[0_2px_6px_rgba(8,32,47,.06),0_18px_44px_-12px_rgba(8,32,47,.38)] backdrop-blur-md ${anim(
          state,
          'animate-rise-in',
          'animate-rise-out',
        )}`}
      >
        {lead}
        {children ? (
          <>
            <span aria-hidden className="mx-1 h-5 w-px bg-line" />
            {children}
          </>
        ) : null}
        {onClose ? (
          <>
            <span aria-hidden className="mx-0.5 h-5 w-px bg-line" />
            <IconButton icon="x" title="Clear selection" onClick={onClose} size={28} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** One action inside a FloatingBar. */
export function BarAction({
  icon,
  label,
  onClick,
  tone = 'default',
  disabled,
  title,
  trailing,
}: {
  icon: IconName;
  label: string;
  onClick?: () => void;
  tone?: 'default' | 'danger';
  disabled?: boolean;
  title?: string;
  trailing?: IconName;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-2.5 py-1.5 text-[13px] font-semibold transition-colors duration-150 active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${
        tone === 'danger'
          ? 'text-[#b02a30] hover:bg-[#fce9ea]'
          : 'text-ink-700 hover:bg-canvas hover:text-ink-900'
      }`}
    >
      <Icon name={icon} size={14} />
      {label}
      {trailing ? <Icon name={trailing} size={12} className="opacity-60" /> : null}
    </button>
  );
}

/** The count badge that leads the bulk bar. */
export function BarCount({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap pr-1">
      <span className="grid min-w-[22px] place-items-center rounded-full bg-brand-950 px-1.5 py-0.5 text-[12px] font-bold text-accent tabular">
        {n}
      </span>
      <span className="text-[13px] font-medium text-ink-700">{label}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty / coming-soon states                                                  */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: IconName;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line bg-white/60 px-6 py-12 text-center">
      {icon ? (
        <span className="mb-3 grid size-10 place-items-center rounded-full bg-canvas text-ink-400">
          <Icon name={icon} size={19} />
        </span>
      ) : null}
      <p className="text-[14px] font-semibold text-ink-700">{title}</p>
      {body ? <p className="mt-1 max-w-[46ch] text-[13px] text-ink-400">{body}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ComingSoon({ what, icon }: { what: string; icon?: IconName }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-line bg-canvas px-6 py-14 text-center">
      {icon ? (
        <span className="mb-3 grid size-11 place-items-center rounded-full bg-white text-ink-400 shadow-[0_1px_2px_rgba(8,32,47,.06)]">
          <Icon name={icon} size={20} />
        </span>
      ) : null}
      <OutlineChip tone="warn" icon="clock">
        Coming soon
      </OutlineChip>
      <p className="mt-3 text-[13.5px] font-semibold text-ink-700">{what}</p>
      <p className="mt-1 max-w-[52ch] text-[12.5px] leading-relaxed text-ink-400">
        The data model and the matching rules are locked. The integration itself is deliberately not
        wired in this build.
      </p>
    </div>
  );
}

/** Explains a piece of architecture in place, rather than in a document. */
export function SpecNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2 text-[12.5px] leading-relaxed text-brand-700">
      <Icon name="info" size={14} className="mt-0.5 shrink-0 opacity-70" />
      <span>{children}</span>
    </p>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-[11.5px] font-semibold uppercase tracking-[.08em] text-ink-400">
      {children}
    </h3>
  );
}

export { Icon };
