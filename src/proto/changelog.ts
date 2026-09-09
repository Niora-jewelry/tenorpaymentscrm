/**
 * PROTOTYPE — a dated record of what changed, and why.
 *
 * At 138 fields and 13 tabs across three amendments in three days, nobody can
 * hold the diff in their head from reading code. This file is the one place
 * that says, in plain language, what happened and where to go look — and the
 * "What's changed" section on `/prototype` plus the "New" badges in the
 * sidebar and the drawer tab strip both read it directly, so it can't drift
 * from what was actually built the way a separate written doc can.
 *
 * One entry per amendment. Newest first. `isNewestEntry(id)` is the whole
 * mechanism behind every "New" badge in the product — no read/dismiss state
 * to manage, because the badge is defined as "in the latest entry", which
 * moves forward on its own the next time something is added here.
 */

export type ChangeLink = { label: string; href: string };

export type ChangeEntry = {
  id: string;
  date: string; // 'YYYY-MM-DD'
  title: string;
  summary: string;
  links: ChangeLink[];
  /** Ids the badges key off — tab ids, subtab ids as `tabId/subtabId`. */
  newIds: string[];
};

export const CHANGELOG: ChangeEntry[] = [
  {
    id: '2026-08-19',
    date: '2026-08-19',
    title: 'Equipment List, Pricing restructured, and per-user personalization',
    summary:
      'A seventh custom tab — Merchant Equipment List — lands in every module. ' +
      'Pricing goes from an empty 7-item placeholder (with a duplicate entry) ' +
      'to 4 named subtabs the client wrote descriptions for, filled with 57 ' +
      'real fields — the "hopefully tomorrow" pricing fields, delivered. One ' +
      'of those subtabs, One Time Charges, has no fields of its own — it is a ' +
      'grid, like Logins, with typed columns so Charge amount actually formats ' +
      'as currency and Date is actually a date picker. Users can now drag to ' +
      'reorder dashboard columns and drawer fields, saved per user and durable ' +
      'across logins — order only, admin still controls what exists.',
    links: [
      { label: 'Merchant Equipment List — open a record in Deals', href: '/prototype/deals' },
      { label: 'Pricing → One Time Charges — the typed grid', href: '/prototype/deals' },
      { label: 'Drag a dashboard column to reorder it', href: '/prototype/leads' },
    ],
    newIds: [
      'equipment',
      'pricing/td_merchant',
      'pricing/vendor_to_td',
      'pricing/one_time_charges',
      'pricing/other_vendor',
    ],
  },
  {
    id: '2026-08-18',
    date: '2026-08-18',
    title: '81 real fields, transcribed from the client’s spreadsheet',
    summary:
      'Every field in the prototype became real — names, types, choice lists ' +
      'and tab placements taken directly from CRM-things.xlsx, replacing the ' +
      'earlier placeholder structure. Sidebar navigation, motion, an icon set ' +
      'with no emoji anywhere, and the six field gaps flagged the day before ' +
      '(repeatable owners, the must-total-100% control, the fee grid, real ' +
      'field notes, the Prior POS checkbox, Last message received) all landed ' +
      'the same day.',
    links: [{ label: 'Open the Records List drawer', href: '/prototype/records' }],
    newIds: [],
  },
  {
    id: '2026-08-17',
    date: '2026-08-17',
    title: 'The Global Amendment — one drawer, not six',
    summary:
      'The client replaced the per-module drawer with a single global one: ' +
      'one set of tabs, one set of subtabs, one set of fields, identical in ' +
      'every module. A field now lives in exactly one tab, always the same ' +
      'one everywhere — the only thing a module still controls is ORDER. This ' +
      'deleted the field engine’s most complicated part: the old placement ' +
      'table keyed by field × module.',
    links: [{ label: 'Compare Leads and Deals — same tabs, different order', href: '/prototype/leads' }],
    newIds: [],
  },
];

/** The single most recent entry — every "New" badge in the product keys off this. */
export const LATEST_ENTRY = CHANGELOG[0]!;

const NEW_IDS = new Set(LATEST_ENTRY.newIds);

/**
 * Whether a tab, subtab, or `tabId/subtabId` placement was introduced in the
 * latest changelog entry. Used to badge sidebar items, tab strips, and
 * subtab pills as "New" with no dismiss logic — it stops applying the moment
 * a newer entry is added above it, automatically.
 */
export function isNewestChange(id: string): boolean {
  return NEW_IDS.has(id);
}
