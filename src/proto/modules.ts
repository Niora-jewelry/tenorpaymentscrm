/**
 * PROTOTYPE — the global drawer, and the per-module ordering over it.
 *
 * Rewritten for the Global Amendment, then updated 19 Aug 2026 against
 * `CRM-19aug.xlsx`: a seventh custom tab (Merchant Equipment List) and a
 * complete restructure of Pricing's subtabs, from a 7-item placeholder list
 * with a duplicate entry to 4 named subtabs the client wrote descriptions for.
 *
 * TABS and SUBTABS are defined ONCE here and are identical in every module. A
 * module contributes nothing but order.
 *
 * Both orderings are transcribed straight from the sheets, "Custom Tabs" and
 * "Hard Coded Tabs". Where the sheets give two separate ordered lists, the
 * drawer renders custom tabs first, then system tabs — fields before
 * activity, which is how the old Records List read too.
 */
import type { Module, Pipeline, Tab } from './schema';

/* ========================================================================== */
/* THE GLOBAL TABS — one definition, every module                             */
/* ========================================================================== */

/**
 * Custom tabs. Seven, from sheet "Custom Tabs" as of 19 Aug — six from the
 * 17 Aug pass plus Merchant Equipment List, new this amendment.
 *
 * "Each tab should have a notes field" (merged H2:H7 in the 18 Aug sheet, now
 * I2:I7) applies to all of them — implemented as a tab-scoped note thread,
 * not a field. See `Note` in schema.
 */
export const CUSTOM_TABS: Tab[] = [
  { id: 'contact', label: 'Contact', kind: 'custom', system: false, acceptsFields: true },
  { id: 'overview', label: 'Overview', kind: 'custom', system: false, acceptsFields: true },
  {
    id: 'application',
    label: 'Application',
    kind: 'custom',
    system: false,
    acceptsFields: true,
    subtabs: [
      { id: 'general', label: 'General' },
      { id: 'acq', label: 'ACQ' },
      { id: 'ach', label: 'ACH' },
      { id: 'private', label: 'Private' },
      { id: 'ownership', label: 'Ownership' },
      { id: 'prior', label: 'Prior Processor' },
    ],
  },
  {
    /*
     * 19 Aug: completely restructured. The old placeholder list (Processing,
     * ACH, Gateway, Terminal, POS, Other, Partner — with ACH listed twice, a
     * bug already flagged in CLIENT-UPDATE-2026-08-18.md) is replaced outright
     * by 4 named subtabs, each with the client's own description text.
     */
    id: 'pricing',
    label: 'Pricing',
    kind: 'custom',
    system: false,
    acceptsFields: true,
    subtabs: [
      {
        id: 'td_merchant',
        label: 'Processor-TD Merchant Pricing',
        description:
          'This tab lists the fees the merchant pays the processor/TapDash. TapDash participates in these fees.',
      },
      {
        id: 'vendor_to_td',
        label: 'Processor-Vendor Pricing to TD',
        description:
          'This tab lists the costs incurred by TapDash to pay for the merchants operations. The Merchant does not participate in these costs.',
      },
      {
        // No field rows in the sheet — described by the client in chat as a
        // grid instead: "Similar to logins tab: columns and user can add as
        // needed — Vendor name, Charge amount (currency), Date, Paid by, Notes."
        id: 'one_time_charges',
        label: 'One Time Charges',
        description: 'This Tab details all one time charges incurred by either the merchant or TD.',
      },
      {
        id: 'other_vendor',
        label: 'Other Vendor Merchant Payments',
        description:
          'This tab lists all payments the merchant is in contract directly with vendors other than TapDash. TapDash does not participate in these costs/revenues.',
      },
    ],
  },
  { id: 'marketing', label: 'Marketing', kind: 'custom', system: false, acceptsFields: true },
  {
    // New 19 Aug. Sits between Marketing and Other in every module's order —
    // confirmed identical position across all six rows of the sheet.
    id: 'equipment',
    label: 'Merchant Equipment List',
    kind: 'custom',
    system: false,
    acceptsFields: true,
  },
  {
    id: 'other',
    label: 'Other',
    kind: 'freeform',
    system: false,
    // "This tab should allow users to add their own fields and their own
    // information" — per-record entries, not schema fields. So: no fields.
    acceptsFields: false,
  },
];

/** System tabs. Six, from sheet "Hard Coded Tabs". */
export const SYSTEM_TABS: Tab[] = [
  {
    id: 'communication',
    label: 'Communication',
    kind: 'communication',
    system: true,
    acceptsFields: false,
    // New order, and "Call recordings" — previously "Phone recordings".
    subtabs: [
      { id: 'email', label: 'Email' },
      { id: 'phone', label: 'Phone', comingSoon: true },
      { id: 'text', label: 'Text' },
      { id: 'teams', label: 'Teams', comingSoon: true },
      { id: 'instantly', label: 'Instantly' },
      { id: 'recordings', label: 'Call recordings', comingSoon: true },
    ],
  },
  { id: 'updates', label: 'Updates', kind: 'updates', system: true, acceptsFields: false },
  { id: 'cases', label: 'Cases', kind: 'cases', system: true, acceptsFields: false },
  {
    id: 'files',
    label: 'Files',
    kind: 'files',
    system: true,
    acceptsFields: true,
    subtabs: [
      { id: 'application', label: 'Application files' },
      { id: 'other', label: 'Other files' },
    ],
  },
  { id: 'logins', label: 'Logins', kind: 'logins', system: true, acceptsFields: true },
  { id: 'statements', label: 'Statements', kind: 'statements', system: true, acceptsFields: true },
];

export const ALL_TABS: Tab[] = [...CUSTOM_TABS, ...SYSTEM_TABS];

export const TAB_BY_ID = new Map(ALL_TABS.map((t) => [t.id, t]));

/** Resolve `tabId` or `tabId/subtabId` to its labels. */
export function describePlacement(placement: string): string {
  const [tabId, subId] = placement.split('/');
  const tab = TAB_BY_ID.get(tabId!);
  if (!tab) return placement;
  const sub = subId ? tab.subtabs?.find((s) => s.id === subId) : undefined;
  return sub ? `${tab.label} → ${sub.label}` : tab.label;
}

/* ========================================================================== */
/* Pipelines — per-module, never shared                                       */
/* ========================================================================== */

export const PIPELINES: Pipeline[] = [
  {
    id: 'pipe_lead',
    label: 'Lead Pipeline',
    module: 'leads',
    steps: [
      { id: 'new', label: 'New lead', swatch: 'slate' },
      { id: 'contacted', label: 'Contacted', swatch: 'blue' },
      { id: 'qualified', label: 'Qualified', swatch: 'indigo' },
      { id: 'statement', label: 'Statement received', swatch: 'purple' },
      { id: 'proposal', label: 'Proposal sent', swatch: 'amber' },
      { id: 'closed', label: 'Closed', swatch: 'teal' },
    ],
  },
  {
    id: 'pipe_deal',
    label: 'Deal Pipeline',
    module: 'deals',
    steps: [
      { id: 'app_sent', label: 'Application sent', swatch: 'slate' },
      { id: 'app_in', label: 'Application received', swatch: 'blue' },
      { id: 'underwriting', label: 'Underwriting', swatch: 'purple' },
      { id: 'approved', label: 'Approved', swatch: 'green' },
      { id: 'equipment', label: 'Equipment ordered', swatch: 'amber' },
      { id: 'installed', label: 'Installed', swatch: 'teal' },
      { id: 'live', label: 'Live', swatch: 'lime' },
    ],
  },
  {
    id: 'pipe_account',
    label: 'Pipeline',
    module: 'contacts',
    steps: [
      { id: 'onboarding', label: 'Onboarding', swatch: 'blue' },
      { id: 'active', label: 'Active', swatch: 'teal' },
      { id: 'at_risk', label: 'At risk', swatch: 'amber' },
      { id: 'churned', label: 'Churned', swatch: 'red' },
    ],
  },
  {
    id: 'pipe_case',
    label: 'Support Pipeline',
    module: 'tickets',
    steps: [
      { id: 'reported', label: 'Reported', swatch: 'orange' },
      { id: 'investigating', label: 'Investigating', swatch: 'amber' },
      { id: 'awaiting', label: 'Awaiting merchant', swatch: 'purple' },
      { id: 'resolved', label: 'Resolved', swatch: 'teal' },
    ],
  },
];

const pipelinesFor = (m: string) => PIPELINES.filter((p) => p.module === m);

/* ========================================================================== */
/* The modules — order and nothing else                                       */
/* ========================================================================== */

export const MODULES: Module[] = [
  {
    slug: 'records',
    label: 'Records List',
    kind: 'storage',
    adminOnly: true,
    blurb:
      'The master store. Every record in the system lives here — including archived records that appear in no display module. The only place Delete exists.',
    customTabOrder: ['contact', 'overview', 'application', 'pricing', 'marketing', 'equipment', 'other'],
    systemTabOrder: ['communication', 'updates', 'cases', 'files', 'logins', 'statements'],
    pipelines: [],
  },
  {
    slug: 'leads',
    label: 'Leads',
    kind: 'display',
    blurb:
      'Where records are usually first created. Same drawer as everywhere else — only the tab order differs.',
    customTabOrder: ['contact', 'overview', 'marketing', 'application', 'pricing', 'equipment', 'other'],
    systemTabOrder: ['communication', 'updates', 'files', 'logins', 'statements', 'cases'],
    pipelines: pipelinesFor('leads'),
  },
  {
    slug: 'deals',
    label: 'Deals',
    kind: 'display',
    blurb:
      'Active deal work. Application sits third here and fourth in Leads — that ordering is the only drawer difference between the two.',
    customTabOrder: ['contact', 'overview', 'application', 'marketing', 'pricing', 'equipment', 'other'],
    systemTabOrder: ['communication', 'updates', 'files', 'logins', 'statements', 'cases'],
    pipelines: pipelinesFor('deals'),
  },
  {
    slug: 'contacts',
    label: 'Contacts',
    kind: 'display',
    blurb: 'Signed clients and ongoing relationships. Pricing is pulled forward to third.',
    customTabOrder: ['contact', 'overview', 'pricing', 'application', 'marketing', 'equipment', 'other'],
    systemTabOrder: ['communication', 'updates', 'cases', 'files', 'logins', 'statements'],
    pipelines: pipelinesFor('contacts'),
  },
  {
    slug: 'tickets',
    label: 'Tickets',
    kind: 'display',
    blurb:
      'Records with active casework. Cases sits second in the system tabs, and one hardcoded column — Open case managers — is auto-populated.',
    customTabOrder: ['contact', 'overview', 'pricing', 'application', 'marketing', 'equipment', 'other'],
    systemTabOrder: ['communication', 'cases', 'updates', 'logins', 'files', 'statements'],
    pipelines: pipelinesFor('tickets'),
  },
  {
    slug: 'residuals',
    label: 'Residuals',
    kind: 'display',
    // "The structure of the residual tab will be different than the others —
    // So do not work on it yet. I have someone else designing it."
    frozen: true,
    blurb:
      'Frozen at the client’s request — someone else is designing its structure. The tab order below is from the sheet; nothing beyond it has been built.',
    customTabOrder: ['pricing', 'overview', 'contact', 'application', 'marketing', 'equipment', 'other'],
    systemTabOrder: ['communication', 'statements', 'updates', 'cases', 'files', 'logins'],
    pipelines: [],
  },
];

export const DISPLAY_MODULES = MODULES.filter((m) => m.kind === 'display');

export function moduleBySlug(slug: string): Module | undefined {
  return MODULES.find((m) => m.slug === slug);
}

export function pipelineById(id: string): Pipeline | undefined {
  return PIPELINES.find((p) => p.id === id);
}

/**
 * The drawer's tab list for one module: its custom tabs in its own order, then
 * its system tabs in its own order. Both lists come from the sheets.
 */
export function tabsForModule(m: Module): Tab[] {
  const pick = (ids: string[]) =>
    ids.map((id) => TAB_BY_ID.get(id)).filter(Boolean) as Tab[];
  return [...pick(m.customTabOrder), ...pick(m.systemTabOrder)];
}

/** Subtabs for a tab within a module, in that module's order if it sets one. */
export function subtabsForModule(m: Module, tab: Tab): Subtab[] {
  if (!tab.subtabs) return [];
  const order = m.subtabOrder?.[tab.id];
  if (!order) return tab.subtabs;
  const byId = new Map(tab.subtabs.map((s) => [s.id, s]));
  const ordered = order.map((id) => byId.get(id)).filter(Boolean) as Subtab[];
  // Anything the module forgot to order still renders, at the end.
  return [...ordered, ...tab.subtabs.filter((s) => !order.includes(s.id))];
}

type Subtab = NonNullable<Tab['subtabs']>[number];
