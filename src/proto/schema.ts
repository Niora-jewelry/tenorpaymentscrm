/**
 * PROTOTYPE — the shape of the CRM, as types.
 *
 * Rewritten for the Global Amendment of 17 Aug 2026, which replaced the
 * per-module drawer with a single global one:
 *
 *   "One set of tabs, one set of subtabs within each tab, one set of fields
 *    within each tab/subtab — identical for every module. A field lives in
 *    exactly one tab (or subtab), always the same one everywhere."
 *
 * The consequence for these types is that a Field no longer carries a map of
 * module → tab. It carries ONE `tab`. Everything a module can still vary lives
 * on the Module instead, and there are exactly six such things — see `Module`.
 *
 * Nothing here talks to a database. Every value is invented in `data.ts`.
 */

/* -------------------------------------------------------------------------- */
/* Field types                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The 15 types the Admin Module Plan §3.4 specifies, plus five the field
 * spreadsheet demands and the spec's list omits.
 *
 * `identifier` is ours, not theirs: MID, MCC, EIN, SSN, account and routing
 * numbers are all typed "Number" on the sheet, which cannot hold a leading zero
 * (MCC 0742 becomes 742) and cannot enforce MCC's "four digits".
 * They are digit strings, not quantities, so they get a type that says so.
 */
export type FieldType =
  // --- the 15 specified types ---
  | 'text'
  | 'long_text'
  | 'number'
  | 'currency'
  | 'date'
  | 'datetime'
  | 'dropdown'
  | 'status'
  | 'multi_select'
  | 'team_member'
  | 'email'
  | 'phone'
  | 'url'
  | 'checkbox'
  | 'file'
  // --- five the spreadsheet needs but the spec never lists ---
  /** "Percentage · 1 - 100%" */
  | 'percentage'
  /** "Address · City, State, Zip" */
  | 'address'
  /** "Multiple Choice (must total 100%)" */
  | 'percent_split'
  /** "Multi-select (months) · up to 12 months" */
  | 'months'
  /** "Excel-type sheet with 4 columns" */
  | 'grid'
  // --- ours ---
  /** A digit string with a length rule. Never arithmetic. */
  | 'identifier'
  /** The "(Add new owner)" rows on the sheet — a repeat control, not a value. */
  | 'button'
  /**
   * Real-build only (SCHEMA-DECISIONS §1) — never produced by the prototype's
   * own `src/proto/fields.ts`, which keeps the flat-key simplification for a
   * backend-less demo. Exists on this union so the real drawer's field
   * adapter (`lib/records/adapter.ts`) can type-check against the same
   * `Field` contract without a second, parallel type.
   */
  | 'repeat_group';

/** The five the specification does not list, surfaced as a gap in Presets. */
export const UNSPECIFIED_TYPES: FieldType[] = [
  'percentage',
  'address',
  'percent_split',
  'months',
  'grid',
];

/** The 12 fixed Status swatches. Admins choose from these, never a colour picker. */
export type Swatch =
  | 'slate' | 'blue' | 'indigo' | 'teal' | 'green' | 'lime'
  | 'amber' | 'orange' | 'red' | 'pink' | 'purple' | 'brown';

/**
 * One option on a dropdown / status / multi_select / percent_split field.
 *
 * `key` is the STABLE IDENTITY and is what a record actually stores; `value`
 * is the display label and is editable at any time. They are separate for one
 * reason: the choices editor lets an admin rename "New lead" to "Fresh lead"
 * without touching a single record row. If the stored value were the label,
 * every rename would orphan every record holding the old one.
 *
 * `key` is OPTIONAL because this type serves two callers with two different
 * identity models, and only one of them has keys:
 *   - the real app, where `field_choices` supplies a real citext key and
 *     `records.values` holds it (`adapter.ts`);
 *   - the prototype (`fields.ts`), a backend-less demo whose choices are bare
 *     labels and whose fixture records store those labels.
 *
 * Read it through `choiceKey()` (`fields.ts`), never as `c.key` directly —
 * that falls back to the label, which is exactly right for the prototype and
 * never reached in the real app.
 */
export type Choice = { key?: string; value: string; swatch?: Swatch };

/* -------------------------------------------------------------------------- */
/* Modules, tabs, subtabs                                                      */
/* -------------------------------------------------------------------------- */

export type ModuleSlug =
  | 'records' | 'leads' | 'deals' | 'contacts' | 'tickets' | 'residuals';

export type TabKind =
  /** Locked system tabs. Non-deletable, non-renamable, orderable. */
  | 'communication' | 'updates' | 'cases' | 'files' | 'logins' | 'statements'
  /**
   * The merchant's residual figures, keyed on the MID the record carries.
   *
   * A system tab like the six above, and for the same reason: it renders
   * computed output, so there is nothing for the field editor to place on it
   * (`accepts_fields = false`). WHICH modules carry it is a row in
   * `module_tab_order` — it is seeded onto the residuals module because that
   * is where the client put residuals, and no code knows that.
   *
   * This union has to match the `tab_kind` enum in the database. It did not
   * when the enum gained this value, and nothing complained: a DB tab's kind
   * arrives as a plain `string`, so the compiler had nothing to check it
   * against. The prototype reads its own seeded data and was unaffected either
   * way, which is exactly why the gap would have sat there.
   */
  | 'residuals'
  /** Admin-created, holds field groups. */
  | 'custom'
  /**
   * The "Other" tab. Users add their own entries per record — see
   * `CustomEntry`. It holds no fields, because there is no definition to hold.
   */
  | 'freeform';

export type Subtab = {
  id: string;
  label: string;
  comingSoon?: boolean;
  /**
   * 19 Aug amendment — Pricing's four subtabs each carry explanatory text the
   * client wrote himself (e.g. "TapDash participates in these fees" vs "The
   * Merchant does not participate"). Renders at the top of the subtab body.
   * Optional because most subtabs (Application's seven) still don't have one.
   */
  description?: string;
};

/**
 * GLOBAL. One definition, used by every module. A module may only reorder
 * these, never add, remove or rename one.
 */
export type Tab = {
  id: string;
  label: string;
  kind: TabKind;
  /** Locked system tab: non-deletable, non-renamable, still orderable. */
  system: boolean;
  /** Updates, Communication, Cases and Other can never hold fields. */
  acceptsFields: boolean;
  subtabs?: Subtab[];
};

export type PipelineStep = { id: string; label: string; swatch: Swatch };

export type Pipeline = {
  id: string;
  label: string;
  /** A pipeline belongs to exactly one module. Never shared. */
  module: ModuleSlug;
  steps: PipelineStep[];
};

/**
 * A module is now a *view*: which records it holds, and six ordering and
 * selection choices over the one global drawer.
 *
 * The Amendment names four. The field spreadsheet then varies two more —
 * header-strip membership and status choices — so the real list is six. Those
 * two live on the Field, keyed by module, because that is where the data is.
 */
export type Module = {
  slug: ModuleSlug;
  label: string;
  /** `storage` is the Records List. Everything else is a projection over it. */
  kind: 'storage' | 'display';
  blurb: string;
  /** (c) Drawer tab order — custom tabs, then system tabs. */
  customTabOrder: string[];
  systemTabOrder: string[];
  /** (d) Drawer subtab order, per parent tab. Absent = the global order. */
  subtabOrder?: Record<string, string[]>;
  pipelines: Pipeline[];
  /** Admin-only by default (the Records List). */
  adminOnly?: boolean;
  /** Set while the client has someone else designing it. Read-only shell. */
  frozen?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Fields                                                                      */
/* -------------------------------------------------------------------------- */

export type Field = {
  id: string;
  label: string;
  type: FieldType;
  choices?: Choice[];
  /**
   * (f) Per-module choice overrides. `Current Status` is the only field using
   * this today — "This is different statuses per module" — but it is modelled
   * generally so pipeline-synced statuses use the same mechanism.
   */
  choicesByModule?: Partial<Record<ModuleSlug, Choice[]>>;
  /**
   * The ONE place this field lives, globally: a tab id, or `tabId/subtabId`.
   * There is no per-module variant. That is the whole Amendment in one line.
   */
  tab: string;
  /** Collapsible heading within the tab. Ordering is global. */
  group?: string;
  /** (a)(b) Modules where this field is also a dashboard column. */
  columnIn: ModuleSlug[];
  columnOrder?: number;
  /**
   * (e) Modules whose drawer header strip carries this field. The sheet says
   * "Yes" (all), "Yes - Leads only", "Yes - Leads and tickets only", or "No".
   */
  headerIn?: ModuleSlug[];
  /** Carries a per-record notes thread. */
  notes?: boolean;
  /** Drawn in a named card under the sub-tab's main grid, with every field sharing the label. */
  section?: string;
  /** Email/Phone only: inbound messages match against this value. */
  sync?: boolean;
  /** Locked system field: non-deletable, non-renamable. */
  system?: boolean;
  /** Never editable by anyone, including admins (Record creator). */
  readOnly?: boolean;
  required?: boolean;
  /** SSN, EIN, bank and routing numbers. Masked in the UI. */
  sensitive?: boolean;
  /** Fixed column width in px on the dashboard. */
  width?: number;
  /**
   * Columns for a `grid` field, TYPED — 19 Aug amendment. One Time Charges
   * ("Vendor name, Charge amount [currency], Date [date], Paid by, Notes")
   * needs its Charge amount column to actually format as currency and its
   * Date column to actually be a date picker, not four free-text boxes with a
   * label. Reuses the ordinary field-type registry rather than inventing a
   * second one — a grid column IS a field, just one that repeats per row.
   */
  columns?: { label: string; type: FieldType }[];
  /** "Can click a button to add new owner – up to 5 owners." */
  repeatGroup?: { key: string; max: number };
  /** The spreadsheet's own annotation, shown under the field. */
  hint?: string;
  /** Digit-count rule for `identifier` — MCC is four, routing and SSN nine.
   *  Absent means any length (MID, since the client asked for that). */
  digits?: number[];
  /** Spans the full drawer width instead of sitting in the 2–3 column grid. */
  wide?: boolean;
  /** Not yet specified by the client. Rendered, but flagged. */
  placeholder?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Per-user personalization — 19 Aug amendment                                 */
/* -------------------------------------------------------------------------- */

/**
 * "Admin default → user override → permission filter." This is the middle
 * layer: what one signed-in user has dragged into their own order, on top of
 * whatever the admin configured. Never affects any other user, never touches
 * an export, never shows up in an admin's view of the config itself.
 *
 * Column order is keyed by MODULE (dashboard columns are per-module). Field
 * order is keyed by TAB, deliberately with no module in the key — the drawer
 * is global, so one personalization of "Contact" covers Contact in every
 * module the user opens, not five separate copies of the same preference.
 */
export type ColumnOrderPref = Partial<Record<ModuleSlug, string[]>>;
/** Key is a tab id, or `tabId/subtabId`. Value is field ids, in the user's order. */
export type FieldOrderPref = Record<string, string[]>;

/**
 * A dashboard filter — one per field, keyed by `fieldId` on the map that holds
 * them. Lives here rather than in `DataTable.tsx` so `store.tsx` can hold
 * `user_filters`-shaped state (§5 of the amendment: "upgraded from
 * session-only to durable — server-side per user per module") without a
 * circular import back into the component that used to own this type.
 */
export type Filter =
  | { fieldId: string; kind: 'contains'; text: string }
  | { fieldId: string; kind: 'values'; values: string[] }
  | { fieldId: string; kind: 'range'; min?: number; max?: number }
  | { fieldId: string; kind: 'dates'; from?: string; to?: string }
  | { fieldId: string; kind: 'bool'; checked: boolean }
  /** "Has any value at all." Added for the dashboard's pipeline filter
   * (Admin §3.6): a record is on a pipeline exactly when that pipeline's
   * synced Status field holds a step, so "filter by pipeline" is this, and
   * "filter by step" is an ordinary `values` filter on the same field. */
  | { fieldId: string; kind: 'present' };

/** Key is a module slug. Value is that module's saved filters, by field id. */
export type FilterPref = Partial<Record<ModuleSlug, Record<string, Filter>>>;

/**
 * Resolves an admin's base order against a user's saved override, applying
 * the amendment's drift rule: anything the user never touched — including a
 * field the admin added after the user last reordered — keeps its position
 * relative to the admin's own order. Nothing the user saved references an id
 * that no longer exists in `adminOrder`; that id is simply dropped, which is
 * how a removed field "just disappears" without a migration step.
 *
 * Pure function so it can be unit-tested with no store, no DB, no React —
 * the same shape this becomes server-side once it reads `user_column_order`
 * instead of a local override map.
 */
export function resolveOrder(adminOrder: string[], userOrder: string[] | undefined): string[] {
  if (!userOrder || userOrder.length === 0) return adminOrder;

  const known = new Set(adminOrder);
  // Ids the user has an opinion on that the admin still defines — dropping
  // anything else is how a removed field "just disappears" (amendment §5).
  const kept = userOrder.filter((id) => known.has(id));
  const keptSet = new Set(kept);

  /*
   * The set of SLOTS occupied by kept ids stays exactly where the admin put
   * it; only the VALUES filling those slots get reordered, in the user's
   * chosen sequence. Everything else — new fields, untouched fields — keeps
   * its literal admin position. That is the drift rule, and this is the
   * whole implementation of it: walk the admin order once, and every time a
   * kept-id's slot comes up, pop the next id off the user's queue instead of
   * emitting the admin's own id for that slot.
   */
  let next = 0;
  return adminOrder.map((id) => (keptSet.has(id) ? kept[next++]! : id));
}

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

export type PercentSplit = Record<string, number>;
export type GridRow = Record<string, string>;
/** An `address`-type field's structured value — street/city/state/zip/country
 * as their own keys, rather than one freeform multi-line string, so each part
 * can have its own input (a state dropdown, a zip pattern) instead of parsing
 * a blob of text. */
export type AddressValue = { street: string; street2: string; city: string; state: string; zip: string; country: string };

export type FieldValue =
  | string | number | boolean | string[] | PercentSplit | GridRow[] | AddressValue | null;

/**
 * Record creator points at a team member OR a marketing campaign:
 * "lists which team member/marketing campaign created the record".
 *
 * Campaigns are a future build, so `campaign` never occurs yet — but the
 * discriminator is carried from day one. Adding a nullable column and an enum
 * value later is a metadata change; converting a plain user reference into a
 * polymorphic pair later is a migration across every record.
 */
export type Creator =
  | { kind: 'user'; id: string }
  | { kind: 'campaign'; id: string };

export type RecordRow = {
  id: string;
  /** The universal primary field. Frozen first column, drawer title, dup key. */
  dealName: string;
  values: Record<string, FieldValue>;
  /** Read-only forever. Grants no visibility. */
  creator: Creator;
  /**
   * Display-module memberships. Records List membership is permanent and
   * therefore NOT represented here — a record is in the Records List by
   * existing. An empty array means the record is ARCHIVED.
   */
  memberships: ModuleSlug[];
  /** Independent pipeline assignment per module. */
  pipeline: Partial<Record<ModuleSlug, { pipelineId: string; stepId: string }>>;
  /**
   * The record's compare-and-swap token, for editing a value straight from the
   * dashboard table.
   *
   * OPTIONAL because the prototype builds rows from an in-memory store with no
   * concurrency to guard against, and making it required would break every
   * fixture. The real app always supplies it, and `DataTable` refuses to make a
   * cell editable without one — no token, no safe write.
   */
  updatedAt?: string;
  /** Soft-deleted to the Recycle Bin. Only reachable from the Records List. */
  deleted?: boolean;
  /** Unread @mentions for the VIEWER on this record (nobody else's). */
  mentions?: number;
  createdAt: string;
};

/**
 * One row a USER added on the "Other" tab of one record.
 *
 * Deliberately NOT a field. Under the global drawer a field exists in one tab
 * and therefore on every record in the company — so a rep adding "warehouse
 * gate code" would put it on every merchant and in every colleague's drawer.
 * These belong to one record, have no definition, and therefore cannot be
 * filtered, columned or permission-gated individually. Permission comes from
 * the Other tab's own grant.
 */
export type CustomEntry = {
  id: string;
  recordId: string;
  label: string;
  value: string;
  createdBy: string;
  at: string;
};

/* -------------------------------------------------------------------------- */
/* Tab contents                                                                */
/* -------------------------------------------------------------------------- */

export type User = {
  id: string;
  name: string;
  initials: string;
  role: string;
  hue: number;
};

export type Message = {
  id: string;
  recordId: string;
  channel: 'email' | 'instantly' | 'text';
  direction: 'in' | 'out';
  from: string;
  to: string;
  subject?: string;
  body: string;
  at: string;
};

export type Update = {
  id: string;
  recordId: string;
  authorId: string;
  body: string;
  at: string;
  edited?: boolean;
  /** Replies are exactly one level deep. A reply never has replies. */
  parentId?: string;
  mentions?: string[];
};

export type CaseThread = {
  id: string;
  recordId: string;
  /** From a single global sequence starting at #10000. Never reused. */
  number: number;
  title: string;
  issue: string;
  issueAuthorId: string;
  issueAt: string;
  solution?: string;
  solutionAuthorId?: string;
  solutionAt?: string;
  /** Always at least one. The issue author is assigned automatically. */
  managerIds: string[];
  state: 'open' | 'closed';
  replies: { id: string; authorId: string; body: string; at: string }[];
  files?: number;
  editedBy?: string;
};

export type FileRow = {
  id: string;
  recordId: string;
  /** `application` rows are locked and hardcoded; `other` rows are free-form. */
  kind: 'application' | 'other';
  name: string;
  locked?: boolean;
  files: { name: string; size: string; at: string; version?: number }[];
  note?: string;
};

export type LoginRow = {
  id: string;
  recordId: string;
  type: string;
  link: string;
  user: string;
  /** Envelope-encrypted at rest in the real system. Never exported. */
  pass: string;
  note?: string;
};

export type StatementFile = {
  recordId: string;
  /** `YYYY-MM` */
  period: string;
  files: { name: string; size: string; at: string }[];
};

/**
 * A note thread, on a FIELD or on a TAB.
 *
 * "Each tab should have a notes field" and "Each sub tab should have a notes
 * field" — modelled as a thread rather than a field, because a field would put
 * 21 undeletable system rows in the admin list, make freeform prose
 * column-selectable, and lose the author and timestamp the per-field notes
 * already carry.
 */
export type Note = {
  id: string;
  recordId: string;
  scopeKind: 'field' | 'tab';
  /** A field id, or a tab id / `tabId/subtabId`. */
  scopeId: string;
  authorId: string;
  body: string;
  at: string;
  edited?: boolean;
};

export type ActivityEntry = {
  id: string;
  recordId: string;
  actorId: string;
  at: string;
  kind:
    | 'field' | 'membership' | 'pipeline' | 'file'
    | 'update' | 'case' | 'credential' | 'record';
  summary: string;
  from?: string;
  to?: string;
};

export type Notification = {
  id: string;
  body: string;
  at: string;
  read: boolean;
  recordId?: string;
};
