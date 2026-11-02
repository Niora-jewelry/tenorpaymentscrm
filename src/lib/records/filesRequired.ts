/**
 * The Files Required column's vocabulary. No server code: the list, its filter
 * and the query all read the same words from here.
 */

/** One row still short of files, as `files_required_refresh` keeps it. */
export type FileRequiredItem = { id: string; name: string; have: number; need: number };

/** The column's id in a saved filter and in `?sort=`. It is a system column, so
 *  it is not a field, and no field can have this key: `records` holds it. */
export const FILES_REQUIRED_KEY = 'files_required';

/** Saved in a filter's values beside row names. Row names can't start with `__`
 *  and be mistaken for these: the filter treats these first. */
export const FILES_REQUIRED_FILLED = '__filled';
export const FILES_REQUIRED_EMPTY = '__empty';

export const chipText = (i: FileRequiredItem): string => `${i.name} (${i.have} of ${i.need})`;

/** The Files tab, on that row. */
export const fileRowLink = (search: string, pathname: string, recordId: string, rowId: string): string => {
  const params = new URLSearchParams(search);
  params.set('record', recordId);
  params.set('tab', 'files');
  params.set('field', rowId);
  params.delete('subtab');
  params.delete('n');
  return `${pathname}?${params}`;
};
