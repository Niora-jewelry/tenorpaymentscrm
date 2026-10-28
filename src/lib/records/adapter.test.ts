import { describe, it, expect } from 'vitest';
import { adaptFieldForDashboard, adaptRecordRow, adaptFieldForDrawer } from './adapter';
import type { Config, Field } from './config';
import type { RecordRow } from './records';

function field(overrides: Partial<Field> & Pick<Field, 'id' | 'key' | 'tabId'>): Field {
  return {
    label: overrides.key, type: 'text', subtabId: null, position: 0, hint: null,
    notesEnabled: false, syncEnabled: false, isSystem: false, readOnly: false,
    required: false, sensitive: false, wide: false, placeholder: false,
    width: null, digits: null, repeatMax: null, repeatSchema: null,
    repeatGroupKey: null, gridColumns: null, section: null, autoSource: null, autoSourceField: null, archivedAt: null,
    ...overrides,
  };
}

const config: Config = {
  modules: [
    { id: 'mod-1', slug: 'leads', label: 'Leads', kind: 'display', position: 0, adminOnly: false, frozen: false, showsOpenCases: false },
    { id: 'mod-2', slug: 'deals', label: 'Deals', kind: 'display', position: 1, adminOnly: false, frozen: false, showsOpenCases: false },
  ],
  tabs: [{ id: 'tab-1', key: 'overview', label: 'Overview', kind: 'custom', isSystem: false, acceptsFields: true, position: 0 }],
  subtabs: [{ id: 'sub-1', tabId: 'tab-1', key: 'ownership', label: 'Ownership', description: null, position: 0, comingSoon: false }],
  fields: [
    field({
      id: 'f1', key: 'current_status', tabId: 'tab-1', subtabId: null, type: 'status',
      label: 'Current status', hint: 'Pipeline-synced', width: 140, digits: null,
    }),
    field({ id: 'f2', key: 'owner_1_ssn', tabId: 'tab-1', subtabId: 'sub-1', type: 'identifier', label: 'Owner SSN', sensitive: true, digits: [9] }),
    field({
      id: 'f3', key: 'one_time_charges', tabId: 'tab-1', subtabId: null, type: 'grid', label: 'One time charges',
      gridColumns: [{ label: 'Vendor', type: 'text' }, { label: 'Amount', type: 'currency' }],
    }),
  ],
  moduleTabOrder: [],
  moduleSubtabOrder: [],
  moduleColumns: [
    { moduleId: 'mod-1', fieldId: 'f1', position: 0, defaultVisible: true },
    { moduleId: 'mod-2', fieldId: 'f1', position: 3, defaultVisible: true },
  ],
  moduleHeaderFields: [{ moduleId: 'mod-1', fieldId: 'f1', position: 0 }],
  choices: [
    { fieldId: 'f1', moduleId: null, key: 'new', value: 'New', swatch: 'blue', position: 0 },
    { fieldId: 'f1', moduleId: null, key: 'won', value: 'Won', swatch: 'teal', position: 1 },
    { fieldId: 'f1', moduleId: 'mod-1', key: 'lead_new', value: 'Lead: New', swatch: 'purple', position: 0 },
  ],
  pipelines: [],
  pipelineSteps: [],
};

describe('adaptFieldForDashboard — the DB→prototype field-contract mapping', () => {
  it('uses the field KEY as Field.id, not its uuid — the identity the whole prototype UI relies on', () => {
    const adapted = adaptFieldForDashboard(config, config.fields[0]!);
    expect(adapted.id).toBe('current_status');
  });

  it('carries global choices as `choices` and per-module overrides as `choicesByModule`', () => {
    const adapted = adaptFieldForDashboard(config, config.fields[0]!);
    expect(adapted.choices?.map((c) => c.value)).toEqual(['New', 'Won']);
    expect(adapted.choicesByModule?.leads?.map((c) => c.value)).toEqual(['Lead: New']);
    expect(adapted.choicesByModule?.deals).toBeUndefined();
  });

  it('carries each choice KEY, in both scopes — what records actually store', () => {
    // The bug this pins down shipped and went unnoticed through two phases:
    // dropping `key` here left the LABEL as an option's only identity, so
    // every status/dropdown cell rendered its raw stored key with no swatch,
    // the drawer's picker could not show the current selection at all, and
    // choosing an option wrote the label back into a key-shaped column. None
    // of it errors.
    const adapted = adaptFieldForDashboard(config, config.fields[0]!);
    expect(adapted.choices?.map((c) => c.key)).toEqual(['new', 'won']);
    expect(adapted.choicesByModule?.leads?.map((c) => c.key)).toEqual(['lead_new']);
  });

  it('orders each scope by its own position, not by discovery order', () => {
    const shuffled: Config = {
      ...config,
      choices: [
        { fieldId: 'f1', moduleId: null, key: 'won', value: 'Won', swatch: 'teal', position: 30 },
        { fieldId: 'f1', moduleId: 'mod-1', key: 'b', value: 'B', swatch: null, position: 20 },
        { fieldId: 'f1', moduleId: null, key: 'new', value: 'New', swatch: 'blue', position: 10 },
        { fieldId: 'f1', moduleId: 'mod-1', key: 'a', value: 'A', swatch: null, position: 10 },
      ],
    };
    const adapted = adaptFieldForDashboard(shuffled, shuffled.fields[0]!);
    expect(adapted.choices?.map((c) => c.key)).toEqual(['new', 'won']);
    expect(adapted.choicesByModule?.leads?.map((c) => c.key)).toEqual(['a', 'b']);
  });

  it('leaves choicesByModule undefined entirely when no field has a per-module override', () => {
    const adapted = adaptFieldForDashboard(config, config.fields[1]!);
    expect(adapted.choicesByModule).toBeUndefined();
  });

  it('resolves columnIn to the real module slugs, in whatever order module_columns rows exist', () => {
    const adapted = adaptFieldForDashboard(config, config.fields[0]!);
    expect(adapted.columnIn.sort()).toEqual(['deals', 'leads']);
  });

  it('resolves headerIn only for modules whose module_header_fields actually references this field', () => {
    const adapted = adaptFieldForDashboard(config, config.fields[0]!);
    expect(adapted.headerIn).toEqual(['leads']);
    const noHeader = adaptFieldForDashboard(config, config.fields[1]!);
    expect(noHeader.headerIn).toBeUndefined();
  });

  it('resolves `tab` to "tabKey" for a tab-level field and "tabKey/subtabKey" for a subtab field', () => {
    expect(adaptFieldForDashboard(config, config.fields[0]!).tab).toBe('overview');
    expect(adaptFieldForDashboard(config, config.fields[1]!).tab).toBe('overview/ownership');
  });

  it('carries sensitive/digits through untouched (identifier field masking depends on these)', () => {
    const adapted = adaptFieldForDashboard(config, config.fields[1]!);
    expect(adapted.sensitive).toBe(true);
    expect(adapted.digits).toEqual([9]);
  });
});

describe('adaptFieldForDrawer — everything adaptFieldForDashboard does, plus typed grid columns', () => {
  it('carries grid_columns through as Field.columns unchanged', () => {
    const adapted = adaptFieldForDrawer(config, config.fields[2]!);
    expect(adapted.columns).toEqual([
      { label: 'Vendor', type: 'text' },
      { label: 'Amount', type: 'currency' },
    ]);
  });

  it('leaves columns undefined for a field with no grid_columns', () => {
    const adapted = adaptFieldForDrawer(config, config.fields[0]!);
    expect(adapted.columns).toBeUndefined();
  });

  it('still applies the same id-is-key identity as the dashboard adapter', () => {
    expect(adaptFieldForDrawer(config, config.fields[0]!).id).toBe('current_status');
  });
});

describe('adaptRecordRow', () => {
  const baseRow: RecordRow = {
    id: 'rec-1',
    dealName: "Joe's Pizza",
    values: { current_status: 'new' },
    creatorKind: 'user',
    creatorUserId: 'user-1',
    creatorCampaignId: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    deletedAt: null,
  };

  it('maps a user-created record to a { kind: "user", id } creator', () => {
    const adapted = adaptRecordRow(baseRow, ['leads']);
    expect(adapted.creator).toEqual({ kind: 'user', id: 'user-1' });
  });

  it('maps a campaign-created record to a { kind: "campaign", id } creator', () => {
    const campaignRow: RecordRow = { ...baseRow, creatorKind: 'campaign', creatorUserId: null, creatorCampaignId: 'camp-1' };
    const adapted = adaptRecordRow(campaignRow, []);
    expect(adapted.creator).toEqual({ kind: 'campaign', id: 'camp-1' });
  });

  it('passes memberships through as given (a separate join-table fetch, not derived here)', () => {
    const adapted = adaptRecordRow(baseRow, ['leads', 'deals']);
    expect(adapted.memberships).toEqual(['leads', 'deals']);
  });

  it('passes real JSONB values through untouched', () => {
    const adapted = adaptRecordRow(baseRow, []);
    expect(adapted.values).toEqual({ current_status: 'new' });
  });
});
