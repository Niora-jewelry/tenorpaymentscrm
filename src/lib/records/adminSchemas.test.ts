/**
 * Behavioural cover for the Presets action boundary.
 *
 * `adminConfig.test.ts` asserts that every config-writing action *calls* a
 * parse; this asserts the parse actually rejects the things it should. The
 * cases below are the ones a real submission can produce — a form field left
 * empty, a whitespace-only label, an id that isn't an id — not exhaustive
 * fuzzing of Zod itself.
 */
import { describe, it, expect } from 'vitest';
import {
  createTabSchema,
  createSubtabSchema,
  assignTabSchema,
  createFieldSchema,
  updateFieldSchema,
  setModuleFieldListSchema,
  setFieldChoicesSchema,
  moduleOverrideSchema,
  createPipelineSchema,
  renamePipelineSchema,
  setPipelineStepsSchema,
  setPipelineOrderSchema,
  firstIssueMessage,
} from './adminSchemas';

const UUID = '00000000-0000-4000-8000-000000000001';
const UUID_2 = '00000000-0000-4000-8000-000000000002';

describe('createTabSchema', () => {
  it('accepts a tab with no modules — "create now, assign later" is a real flow', () => {
    const parsed = createTabSchema.safeParse({ key: 'compliance', label: 'Compliance', moduleIds: [] });
    expect(parsed.success).toBe(true);
  });

  it('trims the label and key rather than storing the padding', () => {
    const parsed = createTabSchema.parse({ key: '  compliance  ', label: '  Compliance  ', moduleIds: [] });
    expect(parsed).toMatchObject({ key: 'compliance', label: 'Compliance' });
  });

  it('rejects a whitespace-only label, which a `required` input still allows', () => {
    const parsed = createTabSchema.safeParse({ key: 'compliance', label: '   ', moduleIds: [] });
    expect(parsed.success).toBe(false);
  });

  it('rejects a module id that is not a uuid before it reaches Postgres', () => {
    const parsed = createTabSchema.safeParse({ key: 'compliance', label: 'Compliance', moduleIds: ['leads'] });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing key outright — FormData.get returns null, not ""', () => {
    const parsed = createTabSchema.safeParse({ key: null, label: 'Compliance', moduleIds: [] });
    expect(parsed.success).toBe(false);
  });
});

describe('createSubtabSchema', () => {
  it('defaults an omitted description to empty, since most subtabs have none', () => {
    const parsed = createSubtabSchema.parse({ tabId: UUID, key: 'general', label: 'General', moduleIds: [UUID_2] });
    expect(parsed.description).toBe('');
  });

  it("keeps a real description — Pricing's client-authored blurb", () => {
    const parsed = createSubtabSchema.parse({
      tabId: UUID,
      key: 'one_time_charges',
      label: 'One Time Charges',
      description: 'All one time charges incurred by either the merchant or TD.',
      moduleIds: [],
    });
    expect(parsed.description).toBe('All one time charges incurred by either the merchant or TD.');
  });

  it('requires a real tabId — a subtab with no parent tab is not placeable', () => {
    const parsed = createSubtabSchema.safeParse({ tabId: '', key: 'general', label: 'General', moduleIds: [] });
    expect(parsed.success).toBe(false);
  });
});

describe('assignTabSchema', () => {
  it('rejects a non-uuid tabId from a directly-called action', () => {
    // This action takes arguments, not FormData — the caller is whoever posts
    // to the endpoint, so parsing matters more here, not less.
    const parsed = assignTabSchema.safeParse({ tabId: 'not-an-id', moduleIds: [UUID] });
    expect(parsed.success).toBe(false);
  });
});

/** What a real `createFieldAction` submission looks like once FormData has
 * been read: strings throughout, checkboxes absent when unchecked. */
function fieldForm(over: Record<string, unknown> = {}) {
  return {
    key: 'gateway_provider',
    label: 'Gateway Provider',
    type: 'text',
    tabId: UUID,
    subtabId: '',
    hint: '',
    required: null,
    sensitive: null,
    wide: null,
    notesEnabled: null,
    repeatMax: 5,
    repeatGroupKey: '',
    repeatSchema: '[]',
    gridColumns: '[]',
    ...over,
  };
}

describe('createFieldSchema', () => {
  it('reads an absent checkbox as false — FormData omits an unchecked box entirely', () => {
    const parsed = createFieldSchema.parse(fieldForm());
    expect(parsed).toMatchObject({ required: false, sensitive: false, wide: false, notesEnabled: false });
  });

  it("reads a checked box's 'on' as true", () => {
    const parsed = createFieldSchema.parse(fieldForm({ required: 'on', sensitive: 'on' }));
    expect(parsed).toMatchObject({ required: true, sensitive: true });
  });

  it('turns the "no subtab" option into null, not an empty string', () => {
    // `subtab_id` is a uuid column — '' is a cast error, and "on the tab
    // itself" is genuinely NULL.
    expect(createFieldSchema.parse(fieldForm()).subtabId).toBeNull();
    expect(createFieldSchema.parse(fieldForm({ subtabId: UUID_2 })).subtabId).toBe(UUID_2);
  });

  it('rejects a grid with no columns rather than letting `grid_shape` raise a 23514', () => {
    const parsed = createFieldSchema.safeParse(fieldForm({ type: 'grid' }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(firstIssueMessage(parsed.error)).toBe('A grid field needs at least one column.');
  });

  it("accepts the client's own One Time Charges grid", () => {
    const columns = [
      { label: 'Vendor name', type: 'text' },
      { label: 'Charge amount', type: 'currency' },
      { label: 'Date', type: 'date' },
      { label: 'Paid by', type: 'text' },
      { label: 'Notes', type: 'text' },
    ];
    const parsed = createFieldSchema.parse(fieldForm({ type: 'grid', gridColumns: JSON.stringify(columns) }));
    expect(parsed.gridColumns).toEqual(columns);
  });

  it('rejects a grid column type that renders as a plain text box anyway', () => {
    // `GridCell` only special-cases currency and date; offering `dropdown`
    // would promise a control that does not exist.
    const parsed = createFieldSchema.safeParse(
      fieldForm({ type: 'grid', gridColumns: JSON.stringify([{ label: 'Status', type: 'dropdown' }]) }),
    );
    expect(parsed.success).toBe(false);
  });

  it('rejects a repeating group with no member fields', () => {
    const parsed = createFieldSchema.safeParse(fieldForm({ type: 'repeat_group' }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(firstIssueMessage(parsed.error)).toBe('A repeating group needs at least one member field.');
    }
  });

  it('defaults a member field to not-sensitive so `repeat_schema` is uniform', () => {
    const parsed = createFieldSchema.parse(
      fieldForm({
        type: 'repeat_group',
        repeatSchema: JSON.stringify([{ key: 'first', label: 'First name', type: 'text' }]),
      }),
    );
    expect(parsed.repeatSchema).toEqual([{ key: 'first', label: 'First name', type: 'text', sensitive: false }]);
  });

  it('degrades malformed JSON to the empty-list message, not a parser crash', () => {
    const parsed = createFieldSchema.safeParse(fieldForm({ type: 'grid', gridColumns: '{not json' }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(firstIssueMessage(parsed.error)).toBe('A grid field needs at least one column.');
  });

  it('rejects a field type that is not in the enum', () => {
    const parsed = createFieldSchema.safeParse(fieldForm({ type: 'rich_text' }));
    expect(parsed.success).toBe(false);
  });
});

describe('updateFieldSchema', () => {
  it('drops key and type even when they are submitted', () => {
    // The immutability guarantee is that no request shape can change them —
    // not that a control is greyed out. `records.values` is keyed by `key` and
    // interpreted by `type`; changing either silently reinterprets every
    // stored value.
    const parsed = createFieldSchema.parse(fieldForm());
    expect(parsed).toHaveProperty('key');

    const updated = updateFieldSchema.parse({
      fieldId: UUID_2,
      label: 'Gateway Provider',
      tabId: UUID,
      subtabId: '',
      hint: '',
      required: null,
      sensitive: null,
      wide: null,
      notesEnabled: null,
      key: 'something_else',
      type: 'percent_split',
    });
    expect(updated).not.toHaveProperty('key');
    expect(updated).not.toHaveProperty('type');
  });

  it('requires the field id — an update with no target is not a request', () => {
    const parsed = updateFieldSchema.safeParse({ label: 'X', tabId: UUID, subtabId: '', hint: '' });
    expect(parsed.success).toBe(false);
  });
});

describe('setModuleFieldListSchema', () => {
  it('accepts an empty list — "no configured columns" is a real choice, not a mistake', () => {
    // The dashboard still renders its frozen Deal Name column, so this is
    // recoverable rather than broken. Rejecting it here would invent a rule
    // the client never asked for.
    const parsed = setModuleFieldListSchema.safeParse({ moduleId: UUID, fieldIds: [] });
    expect(parsed.success).toBe(true);
  });

  it('keeps the submitted order — the array index IS the stored position', () => {
    const parsed = setModuleFieldListSchema.parse({ moduleId: UUID, fieldIds: [UUID_2, UUID] });
    expect(parsed.fieldIds).toEqual([UUID_2, UUID]);
  });

  it('rejects a non-uuid in the list rather than sending it to Postgres to fail as a cast', () => {
    const parsed = setModuleFieldListSchema.safeParse({ moduleId: UUID, fieldIds: [UUID, 'deal_name'] });
    expect(parsed.success).toBe(false);
  });

  it('rejects a missing module — a list with no target is not a request', () => {
    const parsed = setModuleFieldListSchema.safeParse({ fieldIds: [UUID] });
    expect(parsed.success).toBe(false);
  });

  it('passes duplicates through — de-duplication is normalisation, and lives in the data layer', () => {
    // Deliberate: a repeated id would violate the tables' (module_id,
    // field_id) primary key, but it is not something the admin can correct
    // from the form, so it is stripped in `adminColumns.ts` rather than
    // rejected here with a message nobody can act on.
    const parsed = setModuleFieldListSchema.parse({ moduleId: UUID, fieldIds: [UUID_2, UUID_2] });
    expect(parsed.fieldIds).toHaveLength(2);
  });
});

describe('setFieldChoicesSchema', () => {
  const choice = (over: Record<string, unknown> = {}) => ({ key: '', value: 'New lead', swatch: '', ...over });

  it('accepts a null moduleId — that IS the global scope, not a missing value', () => {
    const parsed = setFieldChoicesSchema.safeParse({ fieldId: UUID, moduleId: null, choices: [choice()] });
    expect(parsed.success).toBe(true);
  });

  it('accepts a module uuid as the scope', () => {
    const parsed = setFieldChoicesSchema.safeParse({ fieldId: UUID, moduleId: UUID_2, choices: [choice()] });
    expect(parsed.success).toBe(true);
  });

  it('defaults a new option to an empty key — the data layer assigns it, the form never guesses', () => {
    const parsed = setFieldChoicesSchema.parse({ fieldId: UUID, moduleId: null, choices: [{ value: 'Working' }] });
    expect(parsed.choices[0]).toEqual({ key: '', value: 'Working', swatch: '' });
  });

  it('round-trips an existing key untouched — this is the whole rename guarantee', () => {
    // Records store the key. If a rename could change it, every record holding
    // the old one would be orphaned; the form carries the key back so the
    // label is the only thing a rename moves.
    const parsed = setFieldChoicesSchema.parse({
      fieldId: UUID,
      moduleId: null,
      choices: [{ key: 'new_lead', value: 'Fresh lead', swatch: 'blue' }],
    });
    expect(parsed.choices[0]!.key).toBe('new_lead');
    expect(parsed.choices[0]!.value).toBe('Fresh lead');
  });

  it('keeps the submitted order — the array index IS the stored position', () => {
    const parsed = setFieldChoicesSchema.parse({
      fieldId: UUID,
      moduleId: null,
      choices: [choice({ key: 'b', value: 'B' }), choice({ key: 'a', value: 'A' })],
    });
    expect(parsed.choices.map((c) => c.key)).toEqual(['b', 'a']);
  });

  it('rejects an empty label — an option nobody can read is not an option', () => {
    const parsed = setFieldChoicesSchema.safeParse({ fieldId: UUID, moduleId: null, choices: [choice({ value: '  ' })] });
    expect(parsed.success).toBe(false);
  });

  it('rejects a colour that is not one of the 12 swatches', () => {
    const parsed = setFieldChoicesSchema.safeParse({
      fieldId: UUID,
      moduleId: null,
      choices: [choice({ swatch: 'chartreuse' })],
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts '' as no colour — a dropdown's options carry no swatch at all", () => {
    const parsed = setFieldChoicesSchema.safeParse({ fieldId: UUID, moduleId: null, choices: [choice({ swatch: '' })] });
    expect(parsed.success).toBe(true);
  });

  it('accepts an empty list at the boundary — the data layer is what refuses it, with the reason', () => {
    // Shape-valid but a no-op against a writer that never deletes, so the
    // message ("options cannot be removed") belongs where that rule lives.
    const parsed = setFieldChoicesSchema.safeParse({ fieldId: UUID, moduleId: null, choices: [] });
    expect(parsed.success).toBe(true);
  });

  it('rejects a missing moduleId key outright — null must be stated, not implied', () => {
    const parsed = setFieldChoicesSchema.safeParse({ fieldId: UUID, choices: [choice()] });
    expect(parsed.success).toBe(false);
  });
});

describe('moduleOverrideSchema', () => {
  it('requires a real module — the global scope is never created this way', () => {
    expect(moduleOverrideSchema.safeParse({ fieldId: UUID, moduleId: UUID_2 }).success).toBe(true);
    expect(moduleOverrideSchema.safeParse({ fieldId: UUID, moduleId: null }).success).toBe(false);
  });

  it('carries no option list — the server copies the current global set itself', () => {
    const parsed = moduleOverrideSchema.parse({ fieldId: UUID, moduleId: UUID_2, choices: [{ value: 'stale' }] });
    expect(parsed).not.toHaveProperty('choices');
  });
});

describe('createPipelineSchema', () => {
  const steps = (list: { label: string; swatch: string }[]) => JSON.stringify(list);

  it('parses the steps out of the one JSON string the dialog submits', () => {
    const parsed = createPipelineSchema.parse({
      moduleId: UUID,
      label: 'Onboarding',
      steps: steps([{ label: 'Kickoff', swatch: 'blue' }, { label: 'Live', swatch: 'teal' }]),
    });
    expect(parsed.steps.map((s) => s.label)).toEqual(['Kickoff', 'Live']);
    expect(parsed.steps.every((s) => s.id === '')).toBe(true);
  });

  it('rejects a pipeline with no steps — assigning a record puts it on the first one', () => {
    const parsed = createPipelineSchema.safeParse({ moduleId: UUID, label: 'Empty', steps: '[]' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(firstIssueMessage(parsed.error)).toBe('A pipeline needs at least one step.');
  });

  it('rejects a step with no colour — `pipeline_steps.swatch` is NOT NULL, unlike a choice swatch', () => {
    expect(createPipelineSchema.safeParse({ moduleId: UUID, label: 'P', steps: steps([{ label: 'A', swatch: '' }]) }).success).toBe(false);
  });

  it('rejects a colour that is not one of the 12 swatches', () => {
    expect(
      createPipelineSchema.safeParse({ moduleId: UUID, label: 'P', steps: steps([{ label: 'A', swatch: 'chartreuse' }]) }).success,
    ).toBe(false);
  });

  it('rejects a step with an empty label, which the hidden input still allows', () => {
    expect(createPipelineSchema.safeParse({ moduleId: UUID, label: 'P', steps: steps([{ label: '  ', swatch: 'blue' }]) }).success).toBe(false);
  });

  it('carries no module for the steps and no way to name one — placement is the pipeline\'s', () => {
    const parsed = createPipelineSchema.parse({
      moduleId: UUID,
      label: 'P',
      steps: JSON.stringify([{ label: 'A', swatch: 'blue', moduleId: UUID_2 }]),
    });
    expect(parsed.steps[0]).not.toHaveProperty('moduleId');
  });
});

describe('setPipelineStepsSchema', () => {
  const step = (over: Partial<{ id: string; label: string; swatch: string }> = {}) => ({
    id: UUID,
    label: 'Contacted',
    swatch: 'blue',
    ...over,
  });

  it('round-trips an existing step id unchanged — that is the rename guarantee', () => {
    const parsed = setPipelineStepsSchema.parse({ pipelineId: UUID_2, steps: [step()] });
    expect(parsed.steps[0]!.id).toBe(UUID);
  });

  it("treats '' as a new step rather than rejecting it", () => {
    const parsed = setPipelineStepsSchema.safeParse({ pipelineId: UUID_2, steps: [step({ id: '' })] });
    expect(parsed.success).toBe(true);
  });

  it('defaults a missing id to "new" rather than to a malformed one', () => {
    const parsed = setPipelineStepsSchema.parse({ pipelineId: UUID_2, steps: [{ label: 'New', swatch: 'blue' }] });
    expect(parsed.steps[0]!.id).toBe('');
  });

  it('rejects an id that is not a uuid — a step id is what a record stores', () => {
    expect(setPipelineStepsSchema.safeParse({ pipelineId: UUID_2, steps: [step({ id: 'step-3' })] }).success).toBe(false);
  });

  it('keeps the submitted order — the array index IS the stored position', () => {
    const parsed = setPipelineStepsSchema.parse({
      pipelineId: UUID_2,
      steps: [step({ id: UUID_2, label: 'Second' }), step({ id: UUID, label: 'First' })],
    });
    expect(parsed.steps.map((s) => s.label)).toEqual(['Second', 'First']);
  });

  it('rejects an empty list at the boundary, unlike a choice list', () => {
    // The asymmetry is real: an empty CHOICE list is shape-valid and refused by
    // the data layer with a reason, but a pipeline with no steps is a state the
    // renderer cannot draw at all, so it is refused as early as possible.
    expect(setPipelineStepsSchema.safeParse({ pipelineId: UUID_2, steps: [] }).success).toBe(false);
  });
});

describe('renamePipelineSchema / setPipelineOrderSchema', () => {
  it('cannot express a module change — a pipeline never moves between modules', () => {
    const parsed = renamePipelineSchema.parse({ pipelineId: UUID, label: 'Renamed', moduleId: UUID_2 });
    expect(parsed).not.toHaveProperty('moduleId');
  });

  it('rejects a whitespace-only pipeline name', () => {
    expect(renamePipelineSchema.safeParse({ pipelineId: UUID, label: '   ' }).success).toBe(false);
  });

  it('accepts an empty order — it reorders nothing rather than clearing anything', () => {
    expect(setPipelineOrderSchema.safeParse({ moduleId: UUID, pipelineIds: [] }).success).toBe(true);
  });
});

describe('firstIssueMessage', () => {
  it('surfaces the authored message so the dialog shows something actionable', () => {
    const parsed = createTabSchema.safeParse({ key: 'compliance', label: '', moduleIds: [] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(firstIssueMessage(parsed.error)).toBe('Label is required.');
  });
});
