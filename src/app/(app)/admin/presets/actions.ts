'use server';

/**
 * Admin → Presets server actions.
 *
 * Two invariants hold for every action in this file, and for every one added
 * by Presets sub-steps 2-5. Both are enforced by `adminConfig.test.ts`, which
 * reads this file's source and fails the build on a violation:
 *
 *   1. **Parse the input with Zod** (CLAUDE.md §6). A Server Action is a
 *      public HTTP endpoint; the form having a `required` attribute proves
 *      nothing about what actually arrives here.
 *   2. **Call `revalidateConfig()` after any config write.** `loadConfig()`
 *      is `unstable_cache`d, so skipping it means the write succeeds, the
 *      database is correct, and the change never appears in a single module's
 *      dashboard or drawer — with no error anywhere. Call it directly rather
 *      than hand-rolling `revalidateTag`/`revalidatePath`.
 */
import { authorize } from '@/lib/records/permissions';
import { addStatementYear } from '@/lib/records/adminStatements';
import { revalidateConfig, revalidateStatementPeriods } from '@/lib/records/adminConfigCache';
import {
  createTabSchema,
  renameTabSchema,
  renameSubtabSchema,
  setModuleTabOrderSchema,
  setModuleSubtabOrderSchema,
  createSubtabSchema,
  assignTabSchema,
  assignSubtabSchema,
  createFieldSchema,
  updateFieldSchema,
  fieldIdSchema,
  setModuleFieldListSchema,
  setFieldChoicesSchema,
  moduleOverrideSchema,
  removeFieldChoiceSchema,
  createPipelineSchema,
  renamePipelineSchema,
  setPipelineStepsSchema,
  setPipelineOrderSchema,
  addStatementYearSchema,
  firstIssueMessage,
} from '@/lib/records/adminSchemas';
import {
  createTab, createSubtab, assignTabToModules, assignSubtabToModules,
  renameTab, renameSubtab, setModuleTabOrder, setModuleSubtabOrder, setTabModules,
} from '@/lib/records/adminPresets';
import { createField, updateField, archiveField, restoreField } from '@/lib/records/adminFields';
import { setModuleColumns, setModuleHeaderFields } from '@/lib/records/adminColumns';
import {
  setFieldChoices,
  createModuleOverride,
  removeFieldChoice,
  type SetChoicesResult,
  type RemoveChoiceResult,
} from '@/lib/records/adminChoices';
import {
  createPipeline,
  renamePipeline,
  setPipelineSteps,
  setPipelineOrder,
  type SetStepsResult,
} from '@/lib/records/adminPipelines';

export type PresetFormState = { ok: boolean; message?: string };

export async function createTabAction(_prev: PresetFormState, formData: FormData): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = createTabSchema.safeParse({
    key: formData.get('key'),
    label: formData.get('label'),
    moduleIds: formData.getAll('moduleIds'),
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await createTab(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function createSubtabAction(_prev: PresetFormState, formData: FormData): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = createSubtabSchema.safeParse({
    tabId: formData.get('tabId'),
    key: formData.get('key'),
    label: formData.get('label'),
    // The form always submits this field; `?? ''` covers a caller that omits
    // it entirely, which the schema's own default would otherwise not see.
    description: formData.get('description') ?? '',
    moduleIds: formData.getAll('moduleIds'),
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await createSubtab(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function renameTabAction(_prev: PresetFormState, formData: FormData): Promise<PresetFormState> {
  const ctx = await authorize();
  const parsed = renameTabSchema.safeParse({
    tabId: formData.get('tabId'),
    label: formData.get('label'),
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await renameTab(ctx, parsed.data.tabId, parsed.data.label);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function renameSubtabAction(_prev: PresetFormState, formData: FormData): Promise<PresetFormState> {
  const ctx = await authorize();
  const parsed = renameSubtabSchema.safeParse({
    subtabId: formData.get('subtabId'),
    label: formData.get('label'),
    description: formData.get('description') ?? '',
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await renameSubtab(ctx, parsed.data.subtabId, parsed.data.label, parsed.data.description);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

/**
 * Set exactly which modules show a tab.
 *
 * Client instruction: "Need ability to edit tab module assignments." The
 * existing `assignTabToModulesAction` only ever appends, so this is the one
 * that can also take a tab back off a module.
 *
 * Returns a state object rather than throwing, unlike its append-only
 * neighbour — a refusal here has to be shown next to the checkboxes the admin
 * just ticked, not swallowed by a `catch` that closes the editor.
 */
export async function setTabModulesAction(
  tabId: string,
  moduleIds: string[],
): Promise<PresetFormState> {
  const ctx = await authorize();
  const parsed = assignTabSchema.safeParse({ tabId, moduleIds });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setTabModules(ctx, parsed.data.tabId, parsed.data.moduleIds);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

/** Per-module tab order — two of the six things the client's §1 says vary per
 *  module, and until now the only two an admin could not change. */
export async function setModuleTabOrderAction(moduleId: string, tabIds: string[]): Promise<PresetFormState> {
  const ctx = await authorize();
  const parsed = setModuleTabOrderSchema.safeParse({ moduleId, tabIds });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setModuleTabOrder(ctx, parsed.data.moduleId, parsed.data.tabIds);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function setModuleSubtabOrderAction(moduleId: string, subtabIds: string[]): Promise<PresetFormState> {
  const ctx = await authorize();
  const parsed = setModuleSubtabOrderSchema.safeParse({ moduleId, subtabIds });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setModuleSubtabOrder(ctx, parsed.data.moduleId, parsed.data.subtabIds);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function assignTabToModulesAction(tabId: string, moduleIds: string[]): Promise<void> {
  const ctx = await authorize();

  // Not form-submitted — called directly from a client component, which makes
  // parsing MORE important, not less: the arguments are whatever the caller
  // sent over the wire.
  const parsed = assignTabSchema.safeParse({ tabId, moduleIds });
  if (!parsed.success) throw new Error(firstIssueMessage(parsed.error));

  await assignTabToModules(ctx, parsed.data.tabId, parsed.data.moduleIds);
  revalidateConfig();
}

export async function assignSubtabToModulesAction(subtabId: string, moduleIds: string[]): Promise<void> {
  const ctx = await authorize();

  const parsed = assignSubtabSchema.safeParse({ subtabId, moduleIds });
  if (!parsed.success) throw new Error(firstIssueMessage(parsed.error));

  await assignSubtabToModules(ctx, parsed.data.subtabId, parsed.data.moduleIds);
  revalidateConfig();
}

/* -------------------------------------------------------------------------- */
/* Fields — sub-step 2                                                        */
/* -------------------------------------------------------------------------- */

/** The four flags are checkboxes: absent from FormData when unchecked, so
 * `formData.get()` returns null and the schema's own coercion reads that as
 * false. Passing the raw value through is what makes that work — do not
 * `?? false` here, or an unchecked box and a missing key stop being
 * distinguishable at the boundary. */
export async function createFieldAction(_prev: PresetFormState, formData: FormData): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = createFieldSchema.safeParse({
    key: formData.get('key'),
    label: formData.get('label'),
    type: formData.get('type'),
    tabId: formData.get('tabId'),
    subtabId: formData.get('subtabId'),
    hint: formData.get('hint') ?? '',
    // The drawer card this field sits in. Omitting it here made the schema
    // default it to '' — and saving an existing field from the Edit dialog
    // then cleared its section.
    section: formData.get('section') ?? '',
    required: formData.get('required'),
    sensitive: formData.get('sensitive'),
    wide: formData.get('wide'),
    notesEnabled: formData.get('notesEnabled'),
    repeatMax: formData.get('repeatMax') ?? 5,
    repeatGroupKey: formData.get('repeatGroupKey') ?? '',
    // Both are JSON strings the client component built from its own state —
    // see `parseJsonList` in adminSchemas.ts for why they aren't parallel
    // getAll() arrays.
    repeatSchema: formData.get('repeatSchema'),
    gridColumns: formData.get('gridColumns'),
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await createField(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function updateFieldAction(_prev: PresetFormState, formData: FormData): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = updateFieldSchema.safeParse({
    fieldId: formData.get('fieldId'),
    label: formData.get('label'),
    tabId: formData.get('tabId'),
    subtabId: formData.get('subtabId'),
    hint: formData.get('hint') ?? '',
    // The drawer card this field sits in. Omitting it here made the schema
    // default it to '' — and saving an existing field from the Edit dialog
    // then cleared its section.
    section: formData.get('section') ?? '',
    required: formData.get('required'),
    sensitive: formData.get('sensitive'),
    wide: formData.get('wide'),
    notesEnabled: formData.get('notesEnabled'),
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await updateField(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

/** Archive and restore take an id and nothing else. Whether the field may be
 * archived at all (`deal_name`, any system field) is decided from the stored
 * row inside `archiveField`, never from anything the caller sent. */
export async function archiveFieldAction(fieldId: string): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = fieldIdSchema.safeParse({ fieldId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await archiveField(ctx, parsed.data.fieldId);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function restoreFieldAction(fieldId: string): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = fieldIdSchema.safeParse({ fieldId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await restoreField(ctx, parsed.data.fieldId);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Columns & header fields — sub-step 3                                       */
/* -------------------------------------------------------------------------- */

/** Both take the module's WHOLE ordered list, not a delta. Called directly
 * from a client component holding the reordered array in its own state —
 * which is why parsing matters more here, not less: the arguments are
 * whatever arrived over the wire, and an id list is exactly the shape a
 * hand-made request would tamper with. */
export async function setModuleColumnsAction(moduleId: string, fieldIds: string[]): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = setModuleFieldListSchema.safeParse({ moduleId, fieldIds });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setModuleColumns(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function setModuleHeaderFieldsAction(moduleId: string, fieldIds: string[]): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = setModuleFieldListSchema.safeParse({ moduleId, fieldIds });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setModuleHeaderFields(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

/* -------------------------------------------------------------------------- */
/* Choices — sub-step 4                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Saves one scope's whole ordered option list — the field's global set
 * (`moduleId: null`) or one module's override.
 *
 * The `key` on each row is the identity a record already stores, so it is
 * carried from the client rather than re-derived from the label: that is what
 * makes a rename free. Parsing matters more here for exactly that reason —
 * a hand-made request is the one thing that could send a *changed* key, and
 * both the data layer and a trigger refuse it.
 */
export async function setFieldChoicesAction(
  fieldId: string,
  moduleId: string | null,
  choices: { key: string; value: string; swatch: string }[],
): Promise<SetChoicesResult> {
  const ctx = await authorize();

  const parsed = setFieldChoicesSchema.safeParse({ fieldId, moduleId, choices });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setFieldChoices(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return result;
}

/** Starts a module's override as a copy of the global set. The list is not
 * sent — the server reads the current global one, so a stale screen cannot
 * seed an override from options that have since changed. */
export async function createModuleOverrideAction(fieldId: string, moduleId: string): Promise<SetChoicesResult> {
  const ctx = await authorize();

  const parsed = moduleOverrideSchema.safeParse({ fieldId, moduleId });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await createModuleOverride(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return result;
}

/** Removes one option, if no record in that scope holds it. */
export async function removeFieldChoiceAction(
  fieldId: string,
  moduleId: string | null,
  key: string,
): Promise<RemoveChoiceResult> {
  const ctx = await authorize();

  const parsed = removeFieldChoiceSchema.safeParse({ fieldId, moduleId, key });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await removeFieldChoice(ctx, parsed.data);
  if (result.ok) revalidateConfig();
  return result;
}

/* -------------------------------------------------------------------------- */
/* Pipelines & steps — sub-step 5                                             */
/* -------------------------------------------------------------------------- */

/** The pipeline and its first steps land together, in one transaction. The
 * steps arrive as a JSON string the dialog built in its own state — see
 * `parseJsonList` in adminSchemas.ts for why they are not parallel `getAll()`
 * arrays. */
export async function createPipelineAction(_prev: PresetFormState, formData: FormData): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = createPipelineSchema.safeParse({
    moduleId: formData.get('moduleId'),
    label: formData.get('label'),
    steps: formData.get('steps'),
  });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await createPipeline(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

export async function renamePipelineAction(pipelineId: string, label: string): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = renamePipelineSchema.safeParse({ pipelineId, label });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await renamePipeline(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

/**
 * Saves a pipeline's whole ordered step list.
 *
 * Each step's `id` is the identity a record already stores, carried from the
 * client rather than re-derived — which is what makes a rename free. Parsing
 * matters most for exactly that reason: a hand-made request is the one thing
 * that could send another pipeline's step id, and both the function and a
 * trigger refuse to re-parent it.
 */
export async function setPipelineStepsAction(
  pipelineId: string,
  steps: { id: string; label: string; swatch: string }[],
): Promise<SetStepsResult> {
  const ctx = await authorize();

  const parsed = setPipelineStepsSchema.safeParse({ pipelineId, steps });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setPipelineSteps(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return result;
}

export async function setPipelineOrderAction(moduleId: string, pipelineIds: string[]): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = setPipelineOrderSchema.safeParse({ moduleId, pipelineIds });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await setPipelineOrder(ctx, parsed.data);
  if (!result.ok) return result;

  revalidateConfig();
  return { ok: true };
}

/**
 * Extend the Statements month grid by one full year — Modules Amendment 4.
 *
 * NOT `revalidateConfig()`: `statement_periods` is not a `loadConfig()` table,
 * and `allPeriods` is its own cross-request cache with its own tag. Calling the
 * config invalidator here would leave the year selector stale for an hour while
 * appearing to have done the right thing. `revalidateStatementPeriods()` is the
 * sibling that owns this one.
 */
export async function addStatementYearAction(year: number): Promise<PresetFormState> {
  const ctx = await authorize();

  const parsed = addStatementYearSchema.safeParse({ year });
  if (!parsed.success) return { ok: false, message: firstIssueMessage(parsed.error) };

  const result = await addStatementYear(ctx, parsed.data.year);
  if (!result.ok) return result;

  revalidateStatementPeriods();
  return { ok: true };
}

/**
 * Drop the configuration cache, by hand.
 *
 * ── WHY A BUTTON EXISTS FOR SOMETHING EVERY WRITE DOES AUTOMATICALLY ─────
 * `adminConfigCache.ts` says the quiet part already: `loadConfig()` is cached
 * across requests with no TTL, and "a config write that doesn't invalidate
 * the tag returns success, leaves the database perfectly correct, and never
 * appears in a single module's dashboard or drawer."
 *
 * Every action on this screen calls `revalidateConfig()`, so the cache is
 * correct for anything an admin does here. The gap is the OTHER writer:
 * configuration that arrives in a MIGRATION. Several already do — the seed
 * creates every module, tab and field, and later migrations have added
 * columns and changed subtab membership. SQL cannot call into Next, so those
 * changes land in the database and stay invisible until something else
 * happens to invalidate the tag.
 *
 * That is not hypothetical. Two migrations removed the "Other files" subtab
 * and added the pipeline column; both were correct in the database and
 * neither appeared, because nothing had dropped the cache. Diagnosing it took
 * longer than writing either migration.
 *
 * So: one admin-only control that calls the same invalidator every other
 * action here calls. No new cache concept, no TTL that would re-read config
 * on a schedule nobody asked for.
 */
export async function reloadConfigCacheAction(): Promise<PresetFormState> {
  const ctx = await authorize();
  /* Reads nothing and writes nothing — but it changes what every user of the
     app sees next, so it is admin-gated like the writes beside it. */
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only.' };

  revalidateConfig();
  return { ok: true };
}
