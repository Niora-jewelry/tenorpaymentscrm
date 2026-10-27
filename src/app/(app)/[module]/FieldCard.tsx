'use client';

/**
 * The drawer's one field layout (UI spec §3), shared by every data tab and by
 * the Vital Info section of the header.
 *
 *   * 4 equal columns, 16px gaps — real space between fields instead of the
 *     spreadsheet's hairlines, each field its own box;
 *   * every standard field exactly one column; Address and Percentage = 100%
 *     (and the repeat-group/grid tables) take a whole row and start a new one;
 *   * 2 columns on a narrower drawer, 1 on a phone — resolved against the
 *     drawer's own width (container queries), not the window's, because the
 *     drawer is 76% of the screen on a laptop and the whole screen on a phone;
 *   * the same height for every standard box: label (wrapping to two lines,
 *     never truncated), value, nothing else — helper text lives in the (i).
 *
 * Grid auto-placement does the "full-row field leaves the rest of a partly
 * filled row empty" rule by itself: a `1 / -1` item cannot fit beside
 * anything, so it moves to the next row and nothing flows around it.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { Field as ProtoField } from '@/proto/schema';
import { Icon } from '@/proto/ui/icons';
import { InfoTip } from '@/proto/ui/InfoTip';

/** Types that always take the whole row (UI spec §3/§4). Keyed by TYPE, so a
 *  field added in Presets is placed correctly with no change here. */
export const FULL_ROW_TYPES = new Set<ProtoField['type']>(['address', 'percent_split', 'repeat_group', 'grid']);

export function isFullRow(type: ProtoField['type']): boolean {
  return FULL_ROW_TYPES.has(type);
}

/** A `grid-column` value. One column, or the whole row — nothing between. */
export function spanFor(field: Pick<ProtoField, 'type'>): string {
  return isFullRow(field.type) ? '1 / -1' : 'span 1';
}

/** The grid. Needs an `@container` ancestor — see `FIELD_GRID_CONTAINER`. */
export const FIELD_GRID = 'grid grid-cols-1 gap-4 @[30rem]:grid-cols-2 @[50rem]:grid-cols-4';

/** Put on the element whose width decides the column count. */
export const FIELD_GRID_CONTAINER = '@container';

/** The box every standard field sits in. */
export function fieldCardClass({ requiredEmpty, fullRow }: { requiredEmpty?: boolean; fullRow?: boolean }): string {
  return `group/cell relative flex min-w-0 flex-col rounded-lg border bg-white px-3 pb-2 pt-2.5 transition-[border-color,box-shadow,background-color] duration-150 hover:border-ink-300/80 focus-within:border-brand-600/45 focus-within:shadow-[0_0_0_3px_rgba(29,78,216,.07)] ${
    fullRow ? '' : 'min-h-[88px]'
  } ${requiredEmpty ? 'border-warn/55 bg-warn-bg/25' : 'border-line'}`;
}

/** The value sits at the foot of the box, so values line up across a row even
 *  when one label wraps to two lines and its neighbour's does not. */
export const FIELD_VALUE_SLOT = 'mt-auto pt-1.5 min-w-0';

/**
 * The label row: label (wraps, two lines at most), state icons, the (i) for
 * helper text, then whatever the caller adds (mention, notes) on the right.
 */
export function FieldLabelRow({
  field,
  requiredEmpty,
  handle,
  children,
  tone = 'default',
}: {
  field: Pick<ProtoField, 'label' | 'hint' | 'system' | 'sync' | 'required'>;
  requiredEmpty?: boolean;
  /** The reorder handle, when the grid is sortable. */
  handle?: ReactNode;
  /** Right-hand controls. */
  children?: ReactNode;
  tone?: 'default' | 'muted';
}) {
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      {handle}
      <span
        className={`line-clamp-2 min-w-0 break-words text-[11px] font-semibold uppercase leading-[15px] tracking-[.05em] ${
          tone === 'muted' ? 'text-ink-400' : 'text-ink-500'
        }`}
        title={field.label}
      >
        {field.label}
        {field.required ? <span className="ml-0.5 text-warn" aria-label="required">*</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-1 pt-px">
        {field.system ? <Icon name="lock" size={10} className="text-ink-400" aria-label="Filled in by the system" /> : null}
        {field.sync ? <Icon name="link" size={10} className="text-brand-600" aria-label="Sync-enabled" /> : null}
        {requiredEmpty ? <Icon name="alert-triangle" size={10} className="text-warn" aria-label="Required and empty" /> : null}
        {field.hint ? <InfoTip text={field.hint} label={field.label} /> : null}
      </span>
      {children ? <span className="ml-auto flex shrink-0 items-center gap-1">{children}</span> : null}
    </div>
  );
}

/** A section heading inside a tab: a label and a rule, no box around the
 *  fields — the fields are the boxes (no cards inside cards). */
export function SectionHeading({ label, children }: { label: string; children?: ReactNode }) {
  return (
    <header className="mb-2.5 flex items-center gap-3">
      <h3 className="shrink-0 text-[11.5px] font-semibold uppercase tracking-[.08em] text-ink-600">{label}</h3>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-line" />
      {children}
    </header>
  );
}

export function gridColumn(field: Pick<ProtoField, 'type'>): CSSProperties {
  return { gridColumn: spanFor(field) };
}
