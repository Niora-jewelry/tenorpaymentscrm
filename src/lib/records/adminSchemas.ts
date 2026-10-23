/**
 * Input schemas for the Admin Panel's server actions — Presets (sub-steps 1-5)
 * and, from Phase 6a, permission templates.
 *
 * Same posture as `lib/auth/schemas.ts`, for the same reason (CLAUDE.md §6):
 * parse at the server boundary, never trust, and let the parsed type BE the
 * function's input type so there is no unvalidated path through. A Server
 * Action is a public HTTP endpoint — "the form only submits valid values" is
 * not a security property.
 *
 * These describe SHAPE and USER-CORRECTABLE limits only. Two things are
 * deliberately left to the layers below:
 *   - normalisation (`slugifyKey`), which is a data-layer concern;
 *   - uniqueness and placement legality, which are database constraints
 *     (`fields_placement_guard`, the unique indexes) and must stay that way —
 *     a schema check here would be a second, drift-prone copy of a rule the
 *     database already enforces against direct SQL too.
 */
import { z } from 'zod';
import type { FieldType } from './config';
import type { Swatch } from '@/proto/schema';
import { GRANT_LEVELS, GRANT_SCOPES } from './grantRules';

/** Ids reaching an action come from a rendered <option>/checkbox value, but
 * an action is a public endpoint — a non-uuid here should be rejected as a
 * bad request, not sent to Postgres to fail as a cast error. */
const uuid = z.string().uuid('Invalid id.');

/** A human-typed key, pre-slugify. Length is checked against the raw input
 * rather than the slug: an all-punctuation key ("!!!") slugifies to empty,
 * which the data layer still rejects as a belt-and-braces check. */
const keySchema = z
  .string()
  .trim()
  .min(1, 'Key is required.')
  .max(60, 'Key must be 60 characters or fewer.');

const labelSchema = z
  .string()
  .trim()
  .min(1, 'Label is required.')
  .max(120, 'Label must be 120 characters or fewer.');

/** Empty is legitimate here — assigning later is still a supported flow for
 * everything except creating a TAB, which the client has since ruled out. */
const moduleIdsSchema = z.array(uuid).max(50);

/**
 * Creating a tab requires at least one module.
 *
 * Client instruction: "In presets a tab should not be able to be created with
 * no module assigned."
 *
 * This used to be allowed on purpose — the note above this line said so. The
 * trouble with it is what the result looks like: a tab with no modules appears
 * in the Tabs list, has fields pointed at it, can be granted permissions, and
 * is visible to nobody anywhere in the product. There is no error and nothing
 * to notice, which is exactly the failure this project's rules are written
 * against.
 *
 * Deliberately NOT applied to subtabs. The instruction names tabs, a subtab is
 * already anchored to a parent tab, and widening a rule past what was asked
 * would change behaviour nobody requested.
 */
const atLeastOneModuleSchema = z
  .array(uuid)
  .min(1, 'Choose at least one module for this tab.')
  .max(50);

export const createTabSchema = z.object({
  key: keySchema,
  label: labelSchema,
  moduleIds: atLeastOneModuleSchema,
});

export const createSubtabSchema = z.object({
  tabId: uuid,
  key: keySchema,
  label: labelSchema,
  /** Pricing's client-authored blurb, rendered at the top of the subtab.
   * Optional by design — most subtabs have none. */
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer.').default(''),
  moduleIds: moduleIdsSchema,
});

/** Rename only. The KEY is deliberately absent — it is the identity that
 *  `fields.tab_id`, `module_tab_order`, every grant row and every saved
 *  per-user field order point at, so changing it would orphan all of them. */
export const renameTabSchema = z.object({
  tabId: uuid,
  label: labelSchema,
});

export const renameSubtabSchema = z.object({
  subtabId: uuid,
  label: labelSchema,
  description: z.string().trim().max(500, 'Description must be 500 characters or fewer.').default(''),
});

/** A module's whole tab order, replaced at once. Ids omitted are removed from
 *  that module — which is how a tab leaves ONE module without being touched
 *  anywhere else. 50 is the same ceiling `moduleIdsSchema` uses. */
export const setModuleTabOrderSchema = z.object({
  moduleId: uuid,
  tabIds: z.array(uuid).max(50),
});

export const setModuleSubtabOrderSchema = z.object({
  moduleId: uuid,
  subtabIds: z.array(uuid).max(50),
});

export const assignTabSchema = z.object({
  tabId: uuid,
  moduleIds: moduleIdsSchema,
});

export const assignSubtabSchema = z.object({
  subtabId: uuid,
  moduleIds: moduleIdsSchema,
});

export type CreateTabInput = z.infer<typeof createTabSchema>;
export type RenameTabInput = z.infer<typeof renameTabSchema>;
export type RenameSubtabInput = z.infer<typeof renameSubtabSchema>;
export type SetModuleTabOrderInput = z.infer<typeof setModuleTabOrderSchema>;
export type SetModuleSubtabOrderInput = z.infer<typeof setModuleSubtabOrderSchema>;
export type CreateSubtabInput = z.infer<typeof createSubtabSchema>;

/* -------------------------------------------------------------------------- */
/* Fields — sub-step 2                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The `field_type` enum, as a runtime list the admin form can render.
 *
 * `config.ts` owns the TYPE; this is the only runtime copy, and the two are
 * pinned together below so adding an enum value to the database without
 * offering it here is a compile error rather than a field type the admin
 * silently can never create.
 */
export const FIELD_TYPES = [
  'text', 'long_text', 'number', 'currency', 'percentage', 'checkbox',
  'email', 'phone', 'url', 'address',
  'date', 'datetime', 'months',
  'dropdown', 'status', 'multi_select', 'team_member',
  'identifier', 'file', 'percent_split', 'grid', 'repeat_group',
] as const satisfies readonly FieldType[];

/** Compile error if a `FieldType` exists that `FIELD_TYPES` doesn't list. The
 * `satisfies` above catches the other direction (a value that isn't a real
 * field type). */
type MissingFieldType = Exclude<FieldType, (typeof FIELD_TYPES)[number]>;
const _everyFieldTypeIsOffered: [MissingFieldType] extends [never] ? true : { missing: MissingFieldType } = true;
void _everyFieldTypeIsOffered;

/**
 * Grid column types, deliberately narrower than `FIELD_TYPES`.
 *
 * `GridCell` (`proto/ui/value.tsx:782`) renders exactly three things: a
 * right-aligned currency input, a date picker, and — for every other type —
 * a plain text input. Offering all 22 would present 19 options that render
 * identically, which is how an admin ends up believing a column is typed when
 * it isn't. These three are also exactly what the client's own One Time
 * Charges spec asks for (vendor/paid-by/notes text, charge amount currency,
 * date).
 */
export const GRID_COLUMN_TYPES = ['text', 'currency', 'date'] as const satisfies readonly FieldType[];

/** Member types inside a `repeat_group`'s inline schema. Scalars only — a
 * choice-backed or structural member would need storage (`field_choices` rows,
 * a nested placement) that a JSONB member definition has nowhere to put. */
export const REPEAT_MEMBER_TYPES = [
  'text', 'long_text', 'number', 'currency', 'percentage',
  'date', 'datetime', 'email', 'phone', 'url', 'checkbox', 'identifier',
] as const satisfies readonly FieldType[];

const fieldTypeSchema = z.enum(FIELD_TYPES);

/** '' (the "no subtab" option) and a missing value both mean "on the tab
 * itself", which the database stores as NULL — not as an empty string. */
const optionalUuid = z.preprocess((v) => (v === '' || v == null ? null : v), uuid.nullable());

/** An unchecked checkbox is absent from FormData entirely; a checked one is
 * the string 'on'. Neither is a boolean, so this cannot be `z.boolean()`. */
const checkbox = z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean());

/**
 * A dynamic list the client component built in React state and submitted as
 * one JSON string, rather than as parallel `getAll()` arrays — zipping two
 * independent arrays silently mispairs labels and types if they ever differ in
 * length, and there is no way to notice from the server side.
 *
 * Malformed JSON degrades to an empty list on purpose: the only caller that
 * sends anything but valid JSON is a hand-made request, and an empty list is
 * already rejected by the per-type refinements below with a message that says
 * what is actually wrong.
 */
function parseJsonList(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const gridColumnsSchema = z.preprocess(
  parseJsonList,
  z
    .array(
      z.object({
        label: z.string().trim().min(1, 'Every grid column needs a label.').max(60),
        type: z.enum(GRID_COLUMN_TYPES),
      }),
    )
    .max(12, 'A grid can have at most 12 columns.'),
);

const repeatSchemaSchema = z.preprocess(
  parseJsonList,
  z
    .array(
      z.object({
        key: keySchema,
        label: labelSchema,
        type: z.enum(REPEAT_MEMBER_TYPES),
        sensitive: z.boolean().default(false),
      }),
    )
    .max(20, 'A repeating group can have at most 20 member fields.'),
);

const hintSchema = z.string().trim().max(300, 'Hint must be 300 characters or fewer.').default('');
const sectionSchema = z.string().trim().max(80, 'Section names must be 80 characters or fewer.').default('');

/** Shared by create and update — the metadata that is safe to change at any
 * point in a field's life. `key` and `type` are absent from BOTH by design;
 * see `adminFields.ts` for why neither can ever be edited. */
const fieldMetaShape = {
  label: labelSchema,
  tabId: uuid,
  subtabId: optionalUuid,
  hint: hintSchema,
  section: sectionSchema,
  required: checkbox,
  sensitive: checkbox,
  wide: checkbox,
  notesEnabled: checkbox,
};

export const createFieldSchema = z
  .object({
    ...fieldMetaShape,
    key: keySchema,
    type: fieldTypeSchema,
    /** Only read when `type` is 'repeat_group'; see the refinement below. */
    repeatMax: z.coerce.number().int().min(1, 'A repeating group needs to allow at least 1.').max(20).default(5),
    repeatGroupKey: z.string().trim().max(60).default(''),
    repeatSchema: repeatSchemaSchema,
    /** Only read when `type` is 'grid'. */
    gridColumns: gridColumnsSchema,
  })
  .superRefine((v, ctx) => {
    // Mirrors the database's own `grid_shape` / `repeat_group_shape` /
    // `repeat_group_key_shape` checks so the admin gets a sentence instead of
    // a 23514. The database remains the actual guarantee — these run only on
    // the half of the shape a form can get wrong.
    if (v.type === 'grid' && v.gridColumns.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['gridColumns'], message: 'A grid field needs at least one column.' });
    }
    if (v.type === 'repeat_group' && v.repeatSchema.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['repeatSchema'],
        message: 'A repeating group needs at least one member field.',
      });
    }
  });

export const updateFieldSchema = z.object({ ...fieldMetaShape, fieldId: uuid });

/** Archive and restore carry nothing but the id — every other decision
 * (is it a system field? is it `deal_name`?) is read from the row itself, not
 * taken from the request. */
export const fieldIdSchema = z.object({ fieldId: uuid });

export type CreateFieldInput = z.infer<typeof createFieldSchema>;
export type UpdateFieldInput = z.infer<typeof updateFieldSchema>;

/* -------------------------------------------------------------------------- */
/* Columns & header fields — sub-step 3                                       */
/* -------------------------------------------------------------------------- */

/**
 * One module's whole ordered list, replaced in a single write — the array
 * index IS the position, so the order carried here is the only thing that
 * decides it. Both `module_columns` and `module_header_fields` take exactly
 * this shape.
 *
 * An EMPTY array is valid input: "show no configured columns on this module"
 * is a real, recoverable choice (the frozen Deal Name column renders
 * regardless), not a mistake to reject at the boundary.
 *
 * Not checked here, deliberately, because neither is a shape the admin can
 * correct: duplicate ids and the frozen field are normalised away in
 * `adminColumns.ts`, and the frozen field is refused by a trigger besides.
 */
export const setModuleFieldListSchema = z.object({
  moduleId: uuid,
  fieldIds: z.array(uuid).max(200, 'That is more fields than one module can list.'),
});

export type SetModuleFieldListInput = z.infer<typeof setModuleFieldListSchema>;

/* -------------------------------------------------------------------------- */
/* Choices — sub-step 4                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The 12 fixed swatches (`swatch` enum, migration 1), as a runtime list the
 * form can render — the same job `FIELD_TYPES` does above, pinned the same way
 * so a colour added to the database enum without being offered here is a
 * compile error rather than a colour the admin silently can never pick.
 *
 * A colour picker is deliberately not an option: a pill has to stay legible
 * against its own background, and these twelve are the pairs that were
 * designed (`proto/ui/tokens.ts`).
 */
export const SWATCHES = [
  'slate', 'blue', 'indigo', 'teal', 'green', 'lime',
  'amber', 'orange', 'red', 'pink', 'purple', 'brown',
] as const satisfies readonly Swatch[];

type MissingSwatch = Exclude<Swatch, (typeof SWATCHES)[number]>;
const _everySwatchIsOffered: [MissingSwatch] extends [never] ? true : { missing: MissingSwatch } = true;
void _everySwatchIsOffered;

/** `''` is how "no colour" arrives from a `<select>` — a dropdown's choices
 * carry no swatch at all in the seed, only statuses do. */
const swatchSchema = z.union([z.literal(''), z.enum(SWATCHES)]);

/**
 * The four field types whose stored value IS a choice.
 *
 * `team_member` is not one despite looking like a picker — its options are
 * users, resolved live from `profiles`, not authored rows. `months` is not one
 * either: its twelve options are the calendar (`MONTH_NAMES`), not
 * configuration. Offering either would create rows nothing ever reads.
 *
 * Lives here rather than in `adminChoices.ts` because both the server data
 * layer and two client components need it, and that module is `server-only`.
 */
export const CHOICE_FIELD_TYPES = [
  'dropdown', 'status', 'multi_select', 'percent_split',
] as const satisfies readonly FieldType[];

/** A swatch is only ever DRAWN for a status field — `CellValue`/`ValueDisplay`
 * render a `StatusPill` for `status` and a plain `OutlineChip` for everything
 * else (`proto/ui/value.tsx`). Offering a colour on a dropdown would be a
 * control with no visible effect. */
export const SWATCHED_FIELD_TYPES: readonly FieldType[] = ['status'];

/**
 * One option. `key` is present and unchanged for an existing choice, and empty
 * for a new one — the data layer slugifies a key from the label in that case.
 *
 * The asymmetry is deliberate and is the rename guarantee in one line: the
 * form ROUND-TRIPS the key of every row it loaded, so renaming a label can
 * never produce a different key, and a key that no request can change is a key
 * no record can be orphaned from.
 */
const choiceSchema = z.object({
  key: z.string().trim().max(60, 'Choice key must be 60 characters or fewer.').default(''),
  value: z.string().trim().min(1, 'Every option needs a label.').max(120, 'An option label must be 120 characters or fewer.'),
  swatch: swatchSchema.default(''),
});

/**
 * One SCOPE's whole ordered list: `moduleId` null is the global set, a uuid is
 * that module's override. The array index is the position.
 *
 * Not a merge of the two scopes, and the schema cannot express that it isn't —
 * see `adminChoices.ts`, whose header is where that lives.
 */
export const setFieldChoicesSchema = z.object({
  fieldId: uuid,
  moduleId: uuid.nullable(),
  choices: z.array(choiceSchema).max(100, 'That is more options than one field can offer.'),
});

/** Creating an override carries no list — the whole point is that the server
 * copies the global set, rather than the client sending one it believes to be
 * current. */
export const moduleOverrideSchema = z.object({ fieldId: uuid, moduleId: uuid });

/**
 * Removing one option from one scope. The key, not the label: two options can
 * share a label after a rename, and only the key says which one a record holds.
 */
export const removeFieldChoiceSchema = z.object({
  fieldId: uuid,
  moduleId: uuid.nullable(),
  key: z.string().trim().min(1, 'Which option?').max(60, 'Choice key must be 60 characters or fewer.'),
});

export type SetFieldChoicesInput = z.infer<typeof setFieldChoicesSchema>;
export type ModuleOverrideInput = z.infer<typeof moduleOverrideSchema>;
export type RemoveFieldChoiceInput = z.infer<typeof removeFieldChoiceSchema>;

/* -------------------------------------------------------------------------- */
/* Pipelines & steps — sub-step 5                                             */
/* -------------------------------------------------------------------------- */

/**
 * A step's colour, unlike a choice's, is NOT NULLABLE — `pipeline_steps.swatch`
 * is `swatch not null`, because every chip in the step bar is drawn coloured
 * (`RealPipelineBar` reads `SWATCHES[step.swatch]` unconditionally). So there
 * is no `''` member here, and a step with no colour is not a state that exists.
 */
const stepSwatchSchema = z.enum(SWATCHES);

/**
 * One step. `id` is a real uuid for a step that already exists and `''` for one
 * being added — the database assigns it, and the editor adopts what comes back.
 *
 * Same asymmetry as a choice's `key`, and the same reason: records reference a
 * step BY ID (`record_pipelines.step_id`), so an id that round-trips unchanged
 * is an id no record can be orphaned from. Unlike a choice, nothing here has to
 * be derived from the label — which is what makes renaming a step free.
 */
const pipelineStepSchema = z.object({
  id: z.union([z.literal(''), uuid]).default(''),
  label: labelSchema,
  swatch: stepSwatchSchema,
});

/** At least one, always: `create_pipeline` refuses an empty list and the step
 * bar has nothing to assign without one. The cap is a sanity bound, not a
 * client rule — the longest seeded pipeline has 7 steps. */
const stepListSchema = z
  .array(pipelineStepSchema)
  .min(1, 'A pipeline needs at least one step.')
  .max(30, 'That is more steps than one pipeline can hold.');

/** The create dialog builds its steps in React state and submits them as one
 * JSON string, for the reason `parseJsonList` explains above. */
export const createPipelineSchema = z.object({
  moduleId: uuid,
  label: labelSchema,
  steps: z.preprocess(parseJsonList, stepListSchema),
});

export const renamePipelineSchema = z.object({ pipelineId: uuid, label: labelSchema });

/** The whole ordered list, not a delta — the array index IS the position, the
 * same contract as `setModuleFieldListSchema` and `setFieldChoicesSchema`.
 * Called with a real array (not FormData), so no preprocessing. */
export const setPipelineStepsSchema = z.object({ pipelineId: uuid, steps: stepListSchema });

/** Reordering the pipelines within one module. Empty is meaningless rather
 * than harmful — it reorders nothing. */
export const setPipelineOrderSchema = z.object({
  moduleId: uuid,
  pipelineIds: z.array(uuid).max(20, 'That is more pipelines than one module can hold.'),
});

export type CreatePipelineInput = z.infer<typeof createPipelineSchema>;
export type RenamePipelineInput = z.infer<typeof renamePipelineSchema>;
export type SetPipelineStepsInput = z.infer<typeof setPipelineStepsSchema>;
export type SetPipelineOrderInput = z.infer<typeof setPipelineOrderSchema>;

/* -------------------------------------------------------------------------- */
/* Permission templates — Phase 6a                                            */
/* -------------------------------------------------------------------------- */

/**
 * A template carries a label and nothing else — `permission_templates` has no
 * other editable column, and its grants are their own table, edited in 6c.
 *
 * Uniqueness is NOT checked here, deliberately, exactly as this file's header
 * says of every other unique key: it is migration 38's index, which also holds
 * against direct SQL. A copy of the rule here would be a second one to keep in
 * step, and could only ever check what a stale screen believed.
 */
export const createTemplateSchema = z.object({ label: labelSchema });

export const renameTemplateSchema = z.object({ templateId: uuid, label: labelSchema });
export const deleteTemplateSchema = z.object({ templateId: uuid });

export type CreateTemplateInput = z.infer<typeof createTemplateSchema>;
export type RenameTemplateInput = z.infer<typeof renameTemplateSchema>;
export type DeleteTemplateInput = z.infer<typeof deleteTemplateSchema>;

/* -------------------------------------------------------------------------- */
/* Grants — Phase 6c                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The two enums a grant is made of, taken from the runtime lists rather than
 * written out again — `GRANT_LEVELS` is pinned against the `Grant` type in
 * `grantRules.ts`, so a level added to the `permission_level` enum cannot be
 * accepted here without being offered in the UI too.
 *
 * `grantRules.ts` is imported rather than `permissions.ts` on purpose: this
 * module is reached from client components (`FIELD_TYPES`, `SWATCHES`,
 * `CHOICE_FIELD_TYPES` are all rendered), and `permissions.ts` is `server-only`.
 */
const grantLevelSchema = z.enum(GRANT_LEVELS);
const grantScopeSchema = z.enum(GRANT_SCOPES);

/**
 * One cell. The scope is identified by (kind, id) exactly as the tables key it —
 * there is no per-scope-kind action, because the three differ in nothing but
 * which table the id lives in, and three near-identical action pairs is three
 * places for the next rule to be added to two of.
 *
 * The `level` is NOT checked against the field's caps here. That check needs the
 * field row (is it read-only? is it the frozen column?), which is a data-layer
 * lookup, not a shape — see `grantWriteRefusal`, called by `adminGrants.ts`
 * against the config it just loaded. A schema copy would be a second one to keep
 * in step and could only check what the request claimed about itself.
 */
const grantScopeShape = {
  scopeKind: grantScopeSchema,
  scopeId: uuid,
  /*
   * Which module this grant applies to — Admin-Module-Plan §2.2's per-module
   * granularity.
   *
   * Absent or empty means the GLOBAL row: the grant applies in every module,
   * which is what every grant meant before this existed. A `<select>` submits
   * '' for its "All modules" option and cannot submit null, so the empty
   * string is normalised here at the boundary rather than in four call sites.
   */
  /*
   * ⚠ `.nullable()` AS WELL AS `.optional()`, and that is not belt-and-braces.
   *
   * `.optional()` permits `undefined` only. The permission screens pass an
   * explicit `null` for "All modules" — which is the DEFAULT state of both
   * screens — so with optional alone every grant write was rejected by Zod
   * before reaching the data layer, and the row reported a bare "Invalid
   * input". It broke setting any permission at all, on both screens, while
   * typecheck, 308 tests and the build stayed green: nothing exercised the
   * action with a null until the UI did.
   */
  moduleId: z
    .union([uuid, z.literal('')])
    .nullable()
    .optional()
    .transform((v) => (v ? v : null)),
};

export const setTemplateGrantSchema = z.object({
  templateId: uuid,
  ...grantScopeShape,
  level: grantLevelSchema,
});

export const clearTemplateGrantSchema = z.object({ templateId: uuid, ...grantScopeShape });

export const setUserGrantSchema = z.object({
  userId: uuid,
  ...grantScopeShape,
  level: grantLevelSchema,
});

export const clearUserGrantSchema = z.object({ userId: uuid, ...grantScopeShape });

/** The same two shapes again, for a grant decided BEFORE the person exists —
 *  the client's "adjust permissions before sending invite" (migration 93). */
export const setInviteGrantSchema = z.object({
  inviteId: uuid,
  ...grantScopeShape,
  level: grantLevelSchema,
});

export const clearInviteGrantSchema = z.object({ inviteId: uuid, ...grantScopeShape });

/**
 * Several cells at once — the client's Addition 4 (16 Oct 2026): "bulk select
 * permissions … select multiple at once and choose the permission". A `null`
 * level is "Not set", the same clear the single-cell action performs.
 *
 * The module context is bound on the server like the single-cell actions'
 * (`moduleId` is the page's, never the client's); the array carries only
 * what the admin ticked. 500 is more than any matrix holds, and a bound at
 * all keeps one request from being asked to write without limit.
 */
const grantBatchItem = z.object({
  scopeKind: grantScopeSchema,
  scopeId: uuid,
  level: grantLevelSchema.nullable(),
});
export const grantBatchItemsSchema = z.array(grantBatchItem).min(1).max(500);

export const setTemplateGrantsSchema = z.object({
  templateId: uuid,
  moduleId: grantScopeShape.moduleId,
  items: grantBatchItemsSchema,
});
export const setUserGrantsSchema = z.object({
  userId: uuid,
  moduleId: grantScopeShape.moduleId,
  items: grantBatchItemsSchema,
});
export const setInviteGrantsSchema = z.object({
  inviteId: uuid,
  moduleId: grantScopeShape.moduleId,
  items: grantBatchItemsSchema,
});
export type GrantBatchItem = z.infer<typeof grantBatchItem>;

export type SetTemplateGrantInput = z.infer<typeof setTemplateGrantSchema>;
export type ClearTemplateGrantInput = z.infer<typeof clearTemplateGrantSchema>;
export type SetUserGrantInput = z.infer<typeof setUserGrantSchema>;
export type ClearUserGrantInput = z.infer<typeof clearUserGrantSchema>;
export type SetTemplateGrantsInput = z.infer<typeof setTemplateGrantsSchema>;
export type SetUserGrantsInput = z.infer<typeof setUserGrantsSchema>;
export type SetInviteGrantsInput = z.infer<typeof setInviteGrantsSchema>;

/* -------------------------------------------------------------------------- */
/* Users — retro-fitted in Phase 6c                                           */
/* -------------------------------------------------------------------------- */

/**
 * `Admin → Users`' actions predate the Zod-at-the-boundary rule being enforced
 * for this area and read `FormData` with raw `String(...)` casts — the same gap
 * Phase 0 retro-fixed for Presets, on endpoints that pause an account and
 * reassign a permission template. Fixed here rather than left, because 6c is
 * what adds `adminUsers.ts` to the guard test's watch list, and because
 * `pauseUserAction(userId)` taking whatever arrived over the wire is not a
 * shape to grow a fourth caller onto.
 */
export const inviteUserSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(254),
  roleId: uuid,
  /*
   * Permissions chosen at invite time — the client's own request: "when
   * inviting a user I should be able to immediately assign permissions".
   *
   * Optional, because "configure them by hand later" stays a legitimate
   * choice. A `<select>` submits '' for its empty option and cannot submit
   * null, so the empty string is normalised here at the boundary rather than
   * being special-cased by every caller downstream.
   */
  templateId: z
    .union([uuid, z.literal('')])
    .optional()
    .transform((v) => (v ? v : null)),
});

export const userIdSchema = z.object({ userId: uuid });

/**
 * The bulk reassignment that has to happen before a user can be deleted —
 * Admin §2.1.
 *
 * `fromUserId <> toUserId` is NOT checked here, deliberately, and the reason is
 * the same one this file gives for uniqueness and placement legality:
 * `reassign_user_records` refuses it (23514), which also holds against direct
 * SQL, and the data layer turns that into a sentence. A copy here could only
 * check what the request claimed about itself.
 */
/** One invite, by id — cancel or renew. */
export const inviteIdSchema = z.object({ inviteId: uuid });

export type InviteIdInput = z.infer<typeof inviteIdSchema>;

export const reassignUserRecordsSchema = z.object({ fromUserId: uuid, toUserId: uuid });

export type ReassignUserRecordsInput = z.infer<typeof reassignUserRecordsSchema>;

/**
 * `templateId` is `''` for "no template" — the dropdown's own empty option,
 * which `assignTemplate` has always accepted as NULL and which nothing offered
 * until now (6a's finding).
 *
 * `confirmClearOverrides` is the 6c decision in one field. Assigning a template
 * deletes every one of that user's personal overrides, deliberately — "Template:
 * X" without "(edited)" has to mean they have none — and until 6c nothing could
 * create one, so the clear destroyed nothing. Now it can destroy a
 * hand-built permission set with no error and no visible change beyond a badge.
 * So the destructive path is not reachable without the caller saying, in the
 * request itself, that it knows: the data layer refuses when this is false and
 * overrides exist, and the UI only sets it after showing the count.
 */
export const assignTemplateSchema = z.object({
  userId: uuid,
  templateId: z.union([z.literal(''), uuid]),
  confirmClearOverrides: z.boolean().default(false),
});

export type InviteUserInput = z.infer<typeof inviteUserSchema>;
export type AssignTemplateInput = z.infer<typeof assignTemplateSchema>;

/* -------------------------------------------------------------------------- */
/* Record visibility grants                                                   */
/* -------------------------------------------------------------------------- */

/**
 * "An admin can grant User A access to User B's records", one-directional.
 *
 * A DIFFERENT thing from the `user_grants` schemas above, despite the shared
 * word: those decide Hidden/View/Edit on a scope of a record already visible,
 * this decides whether the record is in the query result at all
 * (`can_see_record()`, migration 1). Kept apart deliberately — one schema
 * covering both would be one endpoint that could be talked into the other.
 *
 * `ownerId <> viewerId` is NOT checked here, in line with this file's own rule
 * about uniqueness and placement legality: it is `visibility_grant_not_self`, a
 * check constraint that also holds against direct SQL, and `adminVisibility.ts`
 * turns the violation into a sentence. A copy here could only check what the
 * request claimed about itself.
 */
export const recordVisibilityGrantSchema = z.object({ ownerId: uuid, viewerId: uuid });

/** Revoking carries the grant's own id and nothing else — who it was between is
 * read from the row, never taken from the request. */
export const revokeVisibilityGrantSchema = z.object({ grantId: uuid });

export type RecordVisibilityGrantInput = z.infer<typeof recordVisibilityGrantSchema>;
export type RevokeVisibilityGrantInput = z.infer<typeof revokeVisibilityGrantSchema>;

/**
 * Extending the Statements month grid — Modules Amendment 4.
 *
 * The bounds are a sanity window, not the rule: `add_statement_year`
 * (migration 56) re-derives the only year it will accept and refuses anything
 * else, because the screen an admin is looking at may be minutes old. What this
 * schema is for is the other half — a Server Action is a public endpoint, and
 * `year` arriving as `"2033); drop"` or as `20330` should never reach the
 * database at all.
 */
export const addStatementYearSchema = z.object({
  year: z.number().int().min(2024).max(2100),
});

export type AddStatementYearInput = z.infer<typeof addStatementYearSchema>;

/**
 * One thing in the Recycle Bin that is not a record — Admin §6.
 *
 * `kind` is an enum rather than a free string because it selects WHICH database
 * function runs. A Server Action is a public endpoint, and an unchecked kind is
 * an unchecked function name.
 */
export const binItemSchema = z.object({
  kind: z.enum(['file', 'update', 'reply', 'login', 'case', 'case_reply']),
  id: uuid,
});

export type BinItemInput = z.infer<typeof binItemSchema>;

/**
 * The first message from a Zod failure, for a form that shows one error line.
 *
 * `lib/auth/schemas.ts` has `fieldErrors()`, which returns a per-field map —
 * the auth forms render errors inline against each input. The Presets dialogs
 * show a single message, so flattening to the first issue is what they can
 * actually display. Kept separate rather than reused so neither form's error
 * rendering constrains the other's.
 */
export function firstIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? 'Check the values and try again.';
}
