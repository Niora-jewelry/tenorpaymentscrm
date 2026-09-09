/**
 * Admin → Presets, sub-step 4: the choices editor.
 *
 * Property (f) of the client's own six-things-vary-per-module table
 * (`CLIENT-SPEC-BY-MODULE.md` §1) — *"Different statuses per module"*: Current
 * Status offers New lead / Working / Qualified in Leads and Onboarding /
 * Active / At risk in Contacts, from one global field definition. Rows in
 * `field_choices`, never a condition in code.
 *
 * ── THE TRAP, AND IT IS SILENT ───────────────────────────────────────────
 * `choicesFor()` (`config.ts:251`) returns the module-scoped set **if any rows
 * exist for that module**, otherwise the global set. IT IS NOT A MERGE. So
 * adding ONE module-scoped choice to a field with eight global ones does not
 * give that module nine options — it gives it exactly one, immediately, with
 * no error, and every record whose value is one of the other eight now
 * resolves to nothing.
 *
 * That is why creating an override is its own operation (`createModuleOverride`
 * below) that copies the WHOLE global set first, rather than something that
 * happens implicitly the first time an admin adds a row in a module's tab. The
 * copy has to be the default, not a thing the admin is trusted to remember.
 *
 * ── WHAT CANNOT BE DONE HERE, DELIBERATELY ───────────────────────────────
 *   - **No delete.** `records.values` holds a choice's KEY; removing a choice
 *     records still hold leaves them resolving to nothing, which reads as a
 *     rendering bug rather than as the data loss it is. Add / rename / reorder
 *     / re-swatch only, this pass — `remaining-plan.md` § Phase 3, and the same
 *     posture Phase 4 takes for pipeline steps. The writer (migration 36) has
 *     no DELETE in it, so this is structural, not a UI omission.
 *   - **No editing a `key` after creation.** Renaming is free precisely
 *     because the key never moves: `value` is the display label, and changing
 *     it touches zero record rows. Changing the key would orphan every record
 *     holding it. A trigger (migration 36) refuses it at the database too.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from './permissions';
import { loadConfig, type FieldType, type Choice } from './config';
import { assertAdmin, slugifyKey } from './adminConfig';
import { CHOICE_FIELD_TYPES, SWATCHES, type SetFieldChoicesInput, type ModuleOverrideInput } from './adminSchemas';

const isChoiceType = (t: FieldType) => (CHOICE_FIELD_TYPES as readonly FieldType[]).includes(t);

type SwatchInput = SetFieldChoicesInput['choices'][number]['swatch'];

/** `field_choices.swatch` is the `swatch` enum, so a stored value is always
 * one of these — but it arrives typed as a plain string, and a real check is
 * cheaper to read than a cast that asserts what nobody verified. */
const asSwatch = (s: string | null): SwatchInput =>
  (SWATCHES as readonly string[]).includes(s ?? '') ? (s as SwatchInput) : '';

export type ChoiceRow = {
  /** Permanent. What `records.values` stores, and the only thing a record and
   * a choice have in common. */
  key: string;
  /** The display label — the editable half. */
  value: string;
  swatch: string | null;
  position: number;
};

export type ChoiceFieldRow = {
  id: string;
  key: string;
  label: string;
  type: FieldType;
  tabLabel: string;
  subtabLabel: string | null;
  /** `module_id IS NULL` — the set every module falls back to. */
  global: ChoiceRow[];
  /** Module id → that module's own set. A module absent from this map has no
   * override and shows `global`; a module present here shows ONLY its own
   * rows. */
  byModule: Record<string, ChoiceRow[]>;
};

const toRow = (c: Choice): ChoiceRow => ({ key: c.key, value: c.value, swatch: c.swatch, position: c.position });
const byPosition = (a: ChoiceRow, b: ChoiceRow) => a.position - b.position;

/**
 * What a save hands back: the rows AS STORED, keys included.
 *
 * A union whose success case *carries* them, rather than a `Result` plus an
 * optional field, for the reason Phase 1's `SetValueState` was reshaped the
 * same way — a caller cannot quietly ignore what it has to adopt. It has to
 * here: a new option is submitted with an empty key and gets one assigned
 * server-side, so a form that kept its own pre-save copy would submit that
 * blank key again on the next save and mint a SECOND choice
 * (`option`, `option_2`) instead of editing the first.
 */
export type SetChoicesResult =
  | { ok: true; fieldId: string; choices: { key: string; value: string; swatch: string }[] }
  | { ok: false; message: string };

/**
 * Every field that can carry choices, with both scopes resolved.
 *
 * Reads `loadConfig()`, which filters archived fields — unlike Phase 1's
 * `listFieldsForAdmin`, this screen must not offer an archived field: its
 * options cannot appear anywhere until it is restored, so editing them would
 * be editing something invisible.
 */
export async function listChoiceFields(ctx: AuthContext): Promise<ChoiceFieldRow[]> {
  assertAdmin(ctx);
  const config = await loadConfig();

  const tabById = new Map(config.tabs.map((t) => [t.id, t]));
  const subtabById = new Map(config.subtabs.map((s) => [s.id, s]));

  return config.fields
    .filter((f) => isChoiceType(f.type))
    .map((f) => {
      const mine = config.choices.filter((c) => c.fieldId === f.id);
      const byModule: Record<string, ChoiceRow[]> = {};
      for (const c of mine) {
        if (!c.moduleId) continue;
        (byModule[c.moduleId] ??= []).push(toRow(c));
      }
      for (const rows of Object.values(byModule)) rows.sort(byPosition);

      return {
        id: f.id,
        key: f.key,
        label: f.label,
        type: f.type,
        tabLabel: tabById.get(f.tabId)?.label ?? '(unknown tab)',
        subtabLabel: f.subtabId ? (subtabById.get(f.subtabId)?.label ?? null) : null,
        global: mine.filter((c) => c.moduleId === null).map(toRow).sort(byPosition),
        byModule,
      };
    })
    .sort((a, b) => a.tabLabel.localeCompare(b.tabLabel) || a.label.localeCompare(b.label));
}

/**
 * Turns what the form sent into what the database should hold.
 *
 * A NEW row arrives with no key and gets one slugified from its label, made
 * unique against the keys already in this scope. An EXISTING row arrives
 * carrying its key and keeps it, whatever happened to its label — that is the
 * whole rename guarantee, and it is why the form has to round-trip the key
 * rather than re-deriving it from the label on save.
 *
 * De-duplication happens here rather than in the Zod schema for the same
 * reason it does in `adminColumns.ts`: two rows colliding on a key is not a
 * shape the admin can correct from the form (they typed two different labels),
 * so it is normalised rather than rejected with a message nobody can act on.
 */
function normalise(input: SetFieldChoicesInput['choices']): { key: string; value: string; swatch: string }[] {
  const taken = new Set<string>();
  const out: { key: string; value: string; swatch: string }[] = [];

  for (const c of input) {
    const value = c.value.trim();
    if (!value) continue;

    let key = c.key.trim() || slugifyKey(value);
    if (!key) key = 'option';
    if (taken.has(key)) {
      let n = 2;
      while (taken.has(`${key}_${n}`)) n += 1;
      key = `${key}_${n}`;
    }
    taken.add(key);
    out.push({ key, value, swatch: c.swatch });
  }
  return out;
}

/**
 * Replaces one scope's whole ordered list — global, or one module's override.
 *
 * "Replaces" in the sense that the submitted order and labels win; it never
 * removes a choice that is not in the list. See migration 36 for why that
 * asymmetry is the point rather than an oversight.
 */
export async function setFieldChoices(ctx: AuthContext, input: SetFieldChoicesInput): Promise<SetChoicesResult> {
  assertAdmin(ctx);

  const config = await loadConfig();
  const field = config.fields.find((f) => f.id === input.fieldId);
  if (!field) return { ok: false, message: 'That field no longer exists.' };
  // The database enforces this too (and must, against direct SQL) — checking
  // here turns it into a sentence instead of a raised 23514.
  if (!isChoiceType(field.type)) {
    return { ok: false, message: `${field.label} is a ${field.type} field — it does not have choices.` };
  }
  if (input.moduleId && !config.modules.some((m) => m.id === input.moduleId)) {
    return { ok: false, message: 'That module no longer exists.' };
  }

  const choices = normalise(input.choices);
  if (!choices.length) {
    // Not a database rule: the writer has no DELETE, so an empty list would
    // simply do nothing, leaving the old options in place while the admin
    // watched a save "succeed" and change nothing. Saying so is better than a
    // silent no-op — and it is also the honest answer to "how do I remove an
    // option", which is not something this pass does.
    return { ok: false, message: 'Add at least one option before saving. Options cannot be removed in this build.' };
  }

  const supabase = supabaseAdmin();
  const { error } = await supabase.rpc('set_field_choices', {
    p_field_id: input.fieldId,
    p_module_id: input.moduleId,
    p_choices: choices,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, fieldId: input.fieldId, choices };
}

/**
 * Starts a per-module override by COPYING THE FULL GLOBAL SET into it.
 *
 * This is the guard for this file's headline trap. `choicesFor()` swaps
 * wholesale to the module's rows the instant one exists, so an override that
 * begins as a single row makes that module offer a single option and orphans
 * every record already holding one of the others. Beginning as an exact copy
 * makes creating an override a no-op for users until the admin actually
 * changes something — which is what "override" should mean.
 *
 * Doing it here rather than by pre-filling the form matters: the copy then
 * holds for any caller, not just the one screen that remembers to.
 */
export async function createModuleOverride(ctx: AuthContext, input: ModuleOverrideInput): Promise<SetChoicesResult> {
  assertAdmin(ctx);

  const config = await loadConfig();
  const field = config.fields.find((f) => f.id === input.fieldId);
  if (!field) return { ok: false, message: 'That field no longer exists.' };

  const existing = config.choices.filter((c) => c.fieldId === input.fieldId && c.moduleId === input.moduleId);
  if (existing.length) return { ok: false, message: 'That module already has its own options for this field.' };

  const global = config.choices
    .filter((c) => c.fieldId === input.fieldId && c.moduleId === null)
    .sort((a, b) => a.position - b.position);

  if (!global.length) {
    return {
      ok: false,
      message: `${field.label} has no options yet. Add its global options first — a module override starts as a copy of them.`,
    };
  }

  return setFieldChoices(ctx, {
    fieldId: input.fieldId,
    moduleId: input.moduleId,
    choices: global.map((c) => ({ key: c.key, value: c.value, swatch: asSwatch(c.swatch) })),
  });
}
