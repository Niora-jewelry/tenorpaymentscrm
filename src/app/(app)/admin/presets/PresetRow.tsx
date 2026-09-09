'use client';

/**
 * The shared row skeleton behind the Tabs, Subtabs and Fields lists.
 *
 * All three used to lay a row out with a bare flex, which meant every row sized
 * its own columns: a field carrying four chips pushed its buttons somewhere
 * different from the field above it, and the label, the key and the type never
 * landed in the same place twice. Nothing was misaligned by a rule — there just
 * were no columns, only a run of chips that happened to start at the same left
 * edge.
 *
 * So each list now declares ONE grid template and hands it to both its header
 * and every one of its rows. A column is then in the same place on every row by
 * construction, and adding a chip to a row cannot move anything else.
 *
 * Striping, not hairlines, carries the row across those columns: with the
 * rightmost column a hundred-odd pixels from the label it names, a 1px divider
 * was not enough to follow one row over. The stripe is decorative only — a row
 * that carries a state colour of its own (an archived field) keeps it, because
 * a state a user needs to see must never be paved over by alternation.
 */

import type { ReactNode } from 'react';

/**
 * The four columns, sized once per list. Name flexes, the middle two are
 * fixed so they line up, and the action column is exactly as wide as its
 * widest control — a fluid action column is what made the buttons wander.
 */
export const TAB_GRID = 'grid grid-cols-[minmax(0,1.25fr)_112px_minmax(0,1.5fr)_100px] items-start gap-x-3';
export const FIELD_GRID = 'grid grid-cols-[minmax(0,1.3fr)_136px_minmax(0,1.2fr)_178px] items-start gap-x-3';

/**
 * The alternating row tint — the one place to change it for all three lists.
 *
 * Swap it for any of these, lightest first:
 *
 *   bg-canvas       #f6f9fb  barely there
 *   bg-line-faint   #eef3f7  a shade stronger, still neutral
 *   bg-line-soft    #e8eef4  strongest of the palette's own neutrals
 *   bg-gray-100     #f3f4f6  Tailwind's flat grey — current. The only tint here
 *                            with no blue in it, so it sits slightly cooler
 *                            than the rest of the screen; that is the trade for
 *                            a stripe that is plainly visible.
 *   bg-brand-50     #eff5fd  a blue tint — NOTE this is also the row hover
 *                            colour, so hovering a striped row would do nothing
 *                            visible. Change ROW_HOVER too if you take it.
 *
 * Anything darker stops being a stripe and starts looking like a selected row,
 * which is a state this list does not have.
 */
const STRIPE_BG = 'bg-gray-100';
const ROW_HOVER = 'hover:bg-brand-50';

/** Zebra background for row `i` within its list (or its group). */
export function stripe(i: number) {
  return i % 2 === 1 ? STRIPE_BG : 'bg-white';
}

/** One row. `tone` overrides the stripe for rows that carry their own state. */
export function PresetRow({
  grid,
  index,
  tone,
  children,
}: {
  grid: string;
  index: number;
  tone?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`${grid} px-4 py-2.5 transition-colors ${ROW_HOVER} ${tone ?? stripe(index)}`}
    >
      {children}
    </div>
  );
}

/** The column captions. Sticky-looking but not sticky: one per list is enough
 * at these row counts, and a floating header over a striped list reads as a
 * row of its own. */
export function ListHeader({ grid, columns }: { grid: string; columns: string[] }) {
  return (
    <div
      className={`${grid} border-b border-line-soft bg-white px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-[.06em] text-ink-300`}
    >
      {columns.map((c, i) => (
        <span key={i} className="truncate">
          {c}
        </span>
      ))}
    </div>
  );
}

/**
 * The name column: label above, key below in mono. Stacking them is what frees
 * the second column — inline, the key pushed the first chip a different
 * distance on every row, which is the raggedness people actually noticed.
 */
export function NameCell({
  label,
  itemKey,
  retired = false,
  children,
}: {
  label: string;
  itemKey: string;
  retired?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className={`truncate text-[13.5px] font-medium ${retired ? 'text-bad line-through' : 'text-ink-900'}`}>
        {label}
      </div>
      <div className={`truncate font-mono text-[11px] ${retired ? 'text-bad/70' : 'text-ink-300'}`}>{itemKey}</div>
      {children}
    </div>
  );
}

/** A cell of chips that wraps inside its own column instead of shoving the
 * next one along. */
export function ChipCell({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap items-center gap-1 pt-px">{children}</div>;
}

/** The action column, right-aligned so every button in the list shares an
 * edge whatever the row above it holds. */
export function ActionCell({ children }: { children: ReactNode }) {
  return <div className="flex items-center justify-end gap-1">{children}</div>;
}
