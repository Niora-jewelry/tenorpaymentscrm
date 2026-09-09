import { describe, it, expect } from 'vitest';
import {
  fieldByKey, fieldsInTab, fieldsInRepeatGroup, columnsForModule, headerFieldsForModule,
  choicesFor, tabsForModule, subtabsForModule, pipelinesForModule, stepsForPipeline,
  pipelineStatusFields,
  type Config, type Field,
} from './config';

function field(overrides: Partial<Field> & Pick<Field, 'id' | 'key' | 'tabId'>): Field {
  return {
    label: overrides.key, type: 'text', subtabId: null, position: 0, hint: null,
    notesEnabled: false, syncEnabled: false, isSystem: false, readOnly: false,
    required: false, sensitive: false, wide: false, placeholder: false,
    width: null, digits: null, repeatMax: null, repeatSchema: null,
    repeatGroupKey: null, gridColumns: null, archivedAt: null,
    ...overrides,
  };
}

/** A small but real config: one module, one tab with a subtab, a repeat
 * group spanning two locations (mirrors the real 'owner' case), and both
 * global and per-module choices on one field. */
const config: Config = {
  modules: [{ id: 'mod-1', slug: 'leads', label: 'Leads', kind: 'display', position: 0, adminOnly: false, frozen: false }],
  tabs: [
    { id: 'tab-overview', key: 'overview', label: 'Overview', kind: 'custom', isSystem: false, acceptsFields: true, position: 0 },
    // A second tab, ALSO with its own subtab and its own module_subtab_order
    // row — this is what the real 'leads' module actually looks like
    // (Pricing, Application, Communication, Files all have subtabs at
    // once), and it's the shape that caught a real bug: subtabsForModule()
    // used to filter module_subtab_order by moduleId alone, so asking for
    // tab-overview's subtabs returned tab-pricing's too.
    { id: 'tab-pricing', key: 'pricing', label: 'Pricing', kind: 'custom', isSystem: false, acceptsFields: true, position: 1 },
  ],
  subtabs: [
    { id: 'sub-a', tabId: 'tab-overview', key: 'a', label: 'A', description: null, position: 0, comingSoon: false },
    { id: 'sub-pricing-1', tabId: 'tab-pricing', key: 'p1', label: 'Processor-TD', description: null, position: 0, comingSoon: false },
  ],
  // `position` is the field's GLOBAL order within the tab (spec: "global
  // order within the tab") — deliberately not restarting at 0 per subtab,
  // so a tab-level field and a subtab field can interleave.
  fields: [
    field({ id: 'f1', key: 'legal_business_name', tabId: 'tab-overview', subtabId: null, position: 0 }),
    field({ id: 'f2', key: 'current_status', tabId: 'tab-overview', subtabId: null, position: 1, type: 'status' }),
    field({ id: 'f3', key: 'in_subtab', tabId: 'tab-overview', subtabId: 'sub-a', position: 2 }),
    field({
      id: 'f4', key: 'owner_ownership', tabId: 'tab-overview', subtabId: null, position: 3,
      type: 'repeat_group', repeatGroupKey: 'owner', repeatMax: 5,
      repeatSchema: [{ key: 'first', label: 'First name', type: 'text' }],
    }),
    field({
      id: 'f5', key: 'owner_private', tabId: 'tab-overview', subtabId: 'sub-a', position: 4,
      type: 'repeat_group', repeatGroupKey: 'owner', repeatMax: 5,
      repeatSchema: [{ key: 'ssn', label: 'SSN', type: 'identifier', sensitive: true }],
    }),
    field({ id: 'f6', key: 'archived_field', tabId: 'tab-overview', subtabId: null, position: 5, archivedAt: '2026-01-01' }),
  ],
  moduleTabOrder: [
    { moduleId: 'mod-1', tabId: 'tab-overview', position: 0 },
    { moduleId: 'mod-1', tabId: 'tab-pricing', position: 1 },
  ],
  moduleSubtabOrder: [
    { moduleId: 'mod-1', subtabId: 'sub-a', position: 0 },
    { moduleId: 'mod-1', subtabId: 'sub-pricing-1', position: 0 },
  ],
  moduleColumns: [
    { moduleId: 'mod-1', fieldId: 'f2', position: 0 },
    { moduleId: 'mod-1', fieldId: 'f1', position: 1 },
  ],
  moduleHeaderFields: [{ moduleId: 'mod-1', fieldId: 'f1', position: 0 }],
  choices: [
    { fieldId: 'f2', moduleId: null, key: 'new', value: 'New', swatch: 'blue', position: 0 },
    { fieldId: 'f2', moduleId: null, key: 'won', value: 'Won', swatch: 'teal', position: 1 },
    { fieldId: 'f2', moduleId: 'mod-1', key: 'lead_new', value: 'Lead: New', swatch: 'purple', position: 0 },
  ],
  pipelines: [{ id: 'pipe-1', moduleId: 'mod-1', label: 'Sales', position: 0, statusFieldId: 'f2' }],
  pipelineSteps: [
    { id: 'step-2', pipelineId: 'pipe-1', label: 'Second', swatch: 'teal', position: 1 },
    { id: 'step-1', pipelineId: 'pipe-1', label: 'First', swatch: 'blue', position: 0 },
  ],
};

describe('fieldByKey', () => {
  it('finds a field by its key', () => {
    expect(fieldByKey(config, 'legal_business_name')?.id).toBe('f1');
  });

  it('returns undefined for an unknown key', () => {
    expect(fieldByKey(config, 'nope')).toBeUndefined();
  });
});

describe('fieldsInTab', () => {
  it('returns every field in the tab (subtabId omitted), in global position order across subtabs', () => {
    const ids = fieldsInTab(config, 'tab-overview').map((f) => f.id);
    expect(ids).toEqual(['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);
  });

  it('subtabId explicitly null returns ONLY the tab-level (no subtab) fields', () => {
    const ids = fieldsInTab(config, 'tab-overview', null).map((f) => f.id);
    expect(ids).toEqual(['f1', 'f2', 'f4', 'f6']);
  });

  it('a specific subtabId returns only that subtab’s fields', () => {
    const ids = fieldsInTab(config, 'tab-overview', 'sub-a').map((f) => f.id);
    expect(ids).toEqual(['f3', 'f5']);
  });

  it('an unknown tab returns nothing, not a crash', () => {
    expect(fieldsInTab(config, 'no-such-tab')).toEqual([]);
  });
});

describe('fieldsInRepeatGroup — migration 27’s cross-location sync target', () => {
  it('returns every repeat_group row sharing a semantic group key, across locations', () => {
    const ids = fieldsInRepeatGroup(config, 'owner').map((f) => f.id).sort();
    expect(ids).toEqual(['f4', 'f5']);
  });

  it('excludes an archived field even if it somehow shared the group key', () => {
    // Sanity: archivedAt filter is part of the query, not just type=repeat_group.
    expect(fieldsInRepeatGroup(config, 'owner').every((f) => f.archivedAt === null)).toBe(true);
  });

  it('returns nothing for an unknown group key', () => {
    expect(fieldsInRepeatGroup(config, 'nonexistent')).toEqual([]);
  });
});

describe('columnsForModule', () => {
  it('returns fields in the admin-configured column order, not field-table order', () => {
    const ids = columnsForModule(config, 'mod-1').map((f) => f.id);
    expect(ids).toEqual(['f2', 'f1']);
  });
});

describe('headerFieldsForModule', () => {
  it('returns the header-strip fields for a module', () => {
    expect(headerFieldsForModule(config, 'mod-1').map((f) => f.id)).toEqual(['f1']);
  });
});

describe('choicesFor', () => {
  it('returns the per-module override when one exists', () => {
    expect(choicesFor(config, 'f2', 'mod-1').map((c) => c.value)).toEqual(['Lead: New']);
  });

  it('falls back to the global (module_id IS NULL) set for a module with no override', () => {
    expect(choicesFor(config, 'f2', 'mod-2').map((c) => c.value)).toEqual(['New', 'Won']);
  });
});

describe('tabsForModule / subtabsForModule', () => {
  it('returns tabs in admin-configured order', () => {
    expect(tabsForModule(config, 'mod-1').map((t) => t.id)).toEqual(['tab-overview', 'tab-pricing']);
  });

  it('returns subtabs in admin-configured order when an order row exists', () => {
    expect(subtabsForModule(config, 'mod-1', 'tab-overview').map((s) => s.id)).toEqual(['sub-a']);
  });

  it('REGRESSION: does not leak another tab\'s subtabs just because both tabs have module_subtab_order rows for the same module', () => {
    // The real bug: module_subtab_order is keyed by (moduleId, subtabId)
    // only, not tabId — filtering by moduleId alone (as this used to)
    // returns every subtab across every tab in the module. Asking for
    // tab-pricing's subtabs must return ONLY sub-pricing-1, never sub-a.
    expect(subtabsForModule(config, 'mod-1', 'tab-pricing').map((s) => s.id)).toEqual(['sub-pricing-1']);
    expect(subtabsForModule(config, 'mod-1', 'tab-overview').map((s) => s.id)).toEqual(['sub-a']);
  });

  it('falls back to every subtab of the tab when no module_subtab_order rows exist', () => {
    const bare: Config = { ...config, moduleSubtabOrder: [] };
    expect(subtabsForModule(bare, 'mod-1', 'tab-overview').map((s) => s.id)).toEqual(['sub-a']);
  });
});

describe('pipelinesForModule / stepsForPipeline', () => {
  it('returns a module’s pipelines', () => {
    expect(pipelinesForModule(config, 'mod-1').map((p) => p.id)).toEqual(['pipe-1']);
  });

  it('returns a pipeline’s steps in position order, not insertion order', () => {
    expect(stepsForPipeline(config, 'pipe-1').map((s) => s.id)).toEqual(['step-1', 'step-2']);
  });
});

describe('pipelineStatusFields', () => {
  it('maps each synced Status field back to the pipeline that owns it', () => {
    const map = pipelineStatusFields(config);
    expect(map.get('f2')).toBe('pipe-1');
  });

  it('is empty for a pipeline that has no synced field yet', () => {
    const map = pipelineStatusFields({
      ...config,
      pipelines: [{ id: 'pipe-9', moduleId: 'mod-1', label: 'Old', position: 0, statusFieldId: null }],
    });
    expect(map.size).toBe(0);
  });

  it('does not claim ordinary fields', () => {
    // The drawer drops a field the moment this map knows about it, so a false
    // positive here would silently hide a real field on every record.
    const map = pipelineStatusFields(config);
    expect(map.has('f1')).toBe(false);
  });
});
