/**
 * Merchant Equipment Setup: the eleven columns and what each accepts. Pure, so the
 * browser and the server read the same rules and the tests need nothing around them.
 *
 * Every column is optional, and blank is stored as nothing, never as 0: a fee left
 * blank must not read as a fee of zero. Nothing here adds anything up. The spec holds
 * calculations back until the client has decided them.
 *
 * Which columns exist for a viewer is the grant chain's answer, in `service.ts`. The
 * labels are the `fields` rows' own. Field keys are named here because a column's
 * value lives in its own database column rather than in `records.values`.
 */

export type ColumnKind = 'provider' | 'billed_by' | 'billed_to' | 'text' | 'whole' | 'money' | 'percent' | 'long_text' | 'checkbox';

export type EquipmentColumn =
  | 'provider_id' | 'billed_by' | 'billed_to' | 'item' | 'item_amount'
  | 'monthly_fee' | 'per_item_fee' | 'one_time_fee' | 'volume_fee' | 'notes' | 'proposal';

/** In the spec's order, which is the order they are drawn in. */
export const EQUIPMENT_COLUMNS: readonly { column: EquipmentColumn; fieldKey: string; kind: ColumnKind }[] = [
  { column: 'provider_id', fieldKey: 'eq_provider', kind: 'provider' },
  { column: 'billed_by', fieldKey: 'eq_billed_by', kind: 'billed_by' },
  { column: 'billed_to', fieldKey: 'eq_billed_to', kind: 'billed_to' },
  { column: 'item', fieldKey: 'eq_item', kind: 'text' },
  { column: 'item_amount', fieldKey: 'eq_item_amount', kind: 'whole' },
  { column: 'monthly_fee', fieldKey: 'eq_monthly_fee', kind: 'money' },
  { column: 'per_item_fee', fieldKey: 'eq_per_item_fee', kind: 'money' },
  { column: 'one_time_fee', fieldKey: 'eq_one_time_fee', kind: 'money' },
  { column: 'volume_fee', fieldKey: 'eq_volume_fee', kind: 'percent' },
  { column: 'notes', fieldKey: 'eq_notes', kind: 'long_text' },
  { column: 'proposal', fieldKey: 'eq_proposal', kind: 'checkbox' },
];

/** The Provider name column's field: the grant that decides who may see a provider's name. */
export const PROVIDER_FIELD_KEY = 'eq_provider';

/** The Item column's field: what the agreement's equipment line prints. */
export const ITEM_FIELD_KEY = 'eq_item';

export const columnNamed = (column: string) => EQUIPMENT_COLUMNS.find((c) => c.column === column);

export type ColumnValue = string | number | boolean | null;
export type Parsed = { ok: true; value: ColumnValue } | { ok: false; message: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MONEY_WHOLE_DIGITS = 10; // numeric(12, 2)
const MAX_WHOLE = 2147483647;

const refuse = (message: string): Parsed => ({ ok: false, message });

const asText = (raw: unknown) => (typeof raw === 'string' ? raw : typeof raw === 'number' ? String(raw) : raw == null ? '' : null);

export const BILLED_TO_CHOICES = [
  { value: 'merchant', label: 'Merchant' },
  { value: 'iso', label: 'ISO' },
] as const;

/** Parses what the browser sent for one column. The result is what gets stored. */
export function parseColumnValue(kind: ColumnKind, raw: unknown): Parsed {
  if (kind === 'checkbox') {
    if (raw === null || raw === undefined || raw === '') return { ok: true, value: false };
    return typeof raw === 'boolean' ? { ok: true, value: raw } : refuse('That is not a valid choice.');
  }

  const text = asText(raw);
  if (text === null) return refuse('That is not a valid value.');
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, value: null };

  switch (kind) {
    case 'provider':
      return UUID.test(trimmed) ? { ok: true, value: trimmed } : refuse('Pick a provider from the list.');
    case 'billed_by':
      return trimmed === 'tenor' || trimmed === 'provider' ? { ok: true, value: trimmed } : refuse('That is not a valid choice.');
    case 'billed_to':
      return trimmed === 'merchant' || trimmed === 'iso' ? { ok: true, value: trimmed } : refuse('That is not a valid choice.');
    case 'text':
      return trimmed.length <= 200 ? { ok: true, value: trimmed } : refuse('Keep this under 200 characters.');
    case 'long_text':
      return trimmed.length <= 2000 ? { ok: true, value: trimmed } : refuse('Keep this under 2,000 characters.');
    case 'whole': {
      const digits = trimmed.replace(/[,\s]/g, '');
      if (!/^\d+$/.test(digits)) return refuse('Enter a whole number.');
      const n = Number(digits);
      return n <= MAX_WHOLE ? { ok: true, value: n } : refuse('That number is too large.');
    }
    case 'money': {
      const digits = trimmed.replace(/[$,\s]/g, '');
      const m = /^(\d*)(?:\.(\d{0,2}))?$/.exec(digits);
      if (!m || (!m[1] && !m[2])) return refuse('Enter an amount with up to two decimals.');
      const whole = (m[1] || '0').replace(/^0+(?=\d)/, '');
      if (whole.length > MAX_MONEY_WHOLE_DIGITS) return refuse('That amount is too large.');
      // Kept as text: 0.1 + 0.2 is not how money should reach the database.
      return { ok: true, value: `${whole}.${(m[2] ?? '').padEnd(2, '0')}` };
    }
    case 'percent': {
      const digits = trimmed.replace(/[%\s]/g, '');
      const m = /^(\d*)(?:\.(\d{0,4}))?$/.exec(digits);
      if (!m || (!m[1] && !m[2])) return refuse('Enter a percentage, with up to four decimals.');
      const n = Number(digits);
      return n <= 100 ? { ok: true, value: digits.startsWith('.') ? `0${digits}` : digits.replace(/\.$/, '') } : refuse('A percentage cannot be over 100.');
    }
  }
}

/** What a stored value looks like in its box. Blank stays blank, never "$0". */
export function displayValue(kind: ColumnKind, value: ColumnValue | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  if (kind === 'money') return Number(value).toFixed(2);
  if (kind === 'percent') return String(Number(value));
  return String(value);
}

export type Choice = { value: string; label: string };

/**
 * The Billed by options for one row. The second is the row's current provider, by
 * name, read fresh each time: the stored value is the choice, so renaming or changing
 * the provider can never leave an old name behind. Absent until a provider is picked.
 *
 * Where the provider is Tenor itself the two would read the same, so one is offered.
 * A viewer with the provider column hidden is not told its name: a stored choice shows
 * in neutral words, and they are not offered it.
 */
export function billedByChoices(providerName: string | null, providerVisible: boolean, current: ColumnValue | undefined): Choice[] {
  const tenor: Choice = { value: 'tenor', label: 'Tenor' };
  if (!providerVisible) return current === 'provider' ? [tenor, { value: 'provider', label: 'Provider on this row' }] : [tenor];
  if (!providerName) return [tenor];
  if (providerName.trim().toLowerCase() === 'tenor') return current === 'provider' ? [{ value: 'provider', label: providerName }] : [tenor];
  return [tenor, { value: 'provider', label: providerName }];
}

/** The name as it is stored: no stray spaces, so "  NMI " is seen to be "NMI". */
export function normalizeProviderName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

/** True when `name` is already on the list, ignoring upper and lower case. */
export function providerNameTaken(name: string, existing: readonly { name: string }[]): boolean {
  const wanted = normalizeProviderName(name).toLowerCase();
  return existing.some((p) => normalizeProviderName(p.name).toLowerCase() === wanted);
}
