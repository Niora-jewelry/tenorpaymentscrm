/**
 * Sorting a record list by a column (UI/UX spec §6: "Columns should be
 * sortable … by their value where the type allows (Dropdown, Status, Date,
 * Number, Currency)"). Shared by the server query and the table header, so
 * the two can never disagree about which columns sort.
 */

/** A field key (or `deal_name`) and a direction. */
export type ListSort = { fieldId: string; dir: 'asc' | 'desc' };

/** Percentage is a Number with a % sign, so it sorts too. */
export const SORTABLE_TYPES: ReadonlySet<string> = new Set([
  'number', 'currency', 'percentage', 'date', 'dropdown', 'status',
]);

/** `?sort=monthly_volume.desc` → a sort, or null for anything malformed. */
export function parseSort(raw: string | undefined | null): ListSort | null {
  const m = /^([a-z][a-z0-9_]{0,59})\.(asc|desc)$/.exec(raw ?? '');
  return m ? { fieldId: m[1]!, dir: m[2] as 'asc' | 'desc' } : null;
}

export function formatSort(sort: ListSort | null): string | null {
  return sort ? `${sort.fieldId}.${sort.dir}` : null;
}
