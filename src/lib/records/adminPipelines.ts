/**
 * Admin → Presets, sub-step 5: pipelines and their steps.
 *
 * A pipeline is the step bar at the top of a record's drawer — the shape of a
 * process, per module. `record_pipelines` is keyed `(record_id, module_id)`,
 * so a record's position in one module's pipeline never interacts with its
 * position in another's; that is the "independent per module" line the drawer
 * prints, and it is a fact about the primary key rather than a UI convention.
 *
 * ── REMOVING A STEP (client, 4 Nov 2026) ─────────────────────────────────
 *   A step is removed by `remove_pipeline_step` (migration 9904), never by
 *   `set_pipeline_steps`, which still has no DELETE. The records standing on
 *   it are moved to a step the admin picks first, each with its activity row,
 *   in the same transaction; a step an automation uses is refused.
 *
 * ── WHAT CANNOT BE DONE HERE, DELIBERATELY ───────────────────────────────
 *   - **No delete of a pipeline.** Deleting a pipeline cascades, wiping every
 *     assignment in that module silently.
 *   - **No moving a pipeline to another module, or a step to another
 *     pipeline.** Both strand `record_pipelines` rows that name the old
 *     module/pipeline, and neither errors. Triggers (migration 37) refuse both
 *     at the database, which is why neither appears in any input type here.
 *
 * ── THE SYNCED STATUS FIELD IS NOT SET HERE, AND MUST NOT BE ─────────────
 * Admin §3.6: "creating a pipeline auto-creates a linked Status field whose
 * options are the pipeline's steps." That is real as of migration 57, and it
 * happens INSIDE `create_pipeline` — so there is no input for it here and no
 * caller has to remember it. The field, its options and its per-record value
 * are all projections with one writer each; the database refuses a direct
 * write to the value, and this module never touches `status_field_id`.
 *
 * (This header previously recorded the opposite — that `status_field_id` was
 * deliberately left NULL because nothing read it. Migration 57 is what changed
 * that, and it answers the question the old note raised: the choice KEY is the
 * step id, which is what keeps `pipeline_steps` and `field_choices` in step
 * without either side having to be copied into the other.)
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from './permissions';
import { loadConfig } from './config';
import { assertAdminPage, type Result } from './adminConfig';
import type {
  CreatePipelineInput,
  RenamePipelineInput,
  SetPipelineStepsInput,
  RemovePipelineStepInput,
  SetPipelineOrderInput,
} from './adminSchemas';

export type AdminStepRow = { id: string; label: string; swatch: string; position: number; records?: number };

export type AdminPipelineRow = {
  id: string;
  moduleId: string;
  label: string;
  position: number;
  steps: AdminStepRow[];
};

/**
 * What a step save hands back: the steps AS STORED, ids included.
 *
 * A union whose success case *carries* them, for the reason Phase 3's
 * `SetChoicesResult` and Phase 1's `SetValueState` are shaped this way — a
 * caller cannot quietly ignore what it has to adopt, and here it must: a new
 * step is submitted with a blank id and given a real one by the database, so
 * an editor that kept its own pre-save copy would submit the blank id again on
 * the next save and mint a SECOND step instead of editing the first.
 */
export type SetStepsResult =
  | { ok: true; pipelineId: string; steps: AdminStepRow[] }
  | { ok: false; message: string };

/**
 * Every pipeline with its steps, in admin order.
 *
 * Reads `loadConfig()` — pipelines have no archived state and no admin-only
 * rows, so unlike Phase 1's `listFieldsForAdmin` there is nothing here the
 * cached config does not already hold.
 */
export async function listPipelinesForAdmin(ctx: AuthContext): Promise<AdminPipelineRow[]> {
  await assertAdminPage(ctx, 'presets');
  const config = await loadConfig();

  const stepsByPipeline = new Map<string, AdminStepRow[]>();
  for (const s of config.pipelineSteps) {
    const row = { id: s.id, label: s.label, swatch: s.swatch, position: s.position };
    const list = stepsByPipeline.get(s.pipelineId);
    if (list) list.push(row);
    else stepsByPipeline.set(s.pipelineId, [row]);
  }
  for (const list of stepsByPipeline.values()) list.sort((a, b) => a.position - b.position);

  // How many records stand on each step: the editor says so before a remove.
  const counts = new Map<string, number>();
  await Promise.all(
    config.pipelines.map(async (p) => {
      const { data } = await supabaseAdmin().rpc('pipeline_step_counts', { p_pipeline_id: p.id });
      for (const r of (data ?? []) as { step_id: string; records: number }[]) counts.set(r.step_id, Number(r.records) || 0);
    }),
  );
  for (const list of stepsByPipeline.values()) for (const s of list) s.records = counts.get(s.id) ?? 0;

  return config.pipelines
    .map((p) => ({
      id: p.id,
      moduleId: p.moduleId,
      label: p.label,
      position: p.position,
      steps: stepsByPipeline.get(p.id) ?? [],
    }))
    .sort((a, b) => a.position - b.position);
}

/** The messages migration 37 raises are written for a person to read, so they
 * are surfaced as-is rather than being re-worded here from an error code. */
const failed = (error: { message: string }): { ok: false; message: string } => ({ ok: false, message: error.message });

/**
 * Creates a pipeline together with its first steps, in one transaction.
 *
 * The steps are not optional. `RealPipelineBar` assigns a pipeline by putting
 * the record on its FIRST step, so a step-less pipeline renders a button that
 * throws — `create_pipeline` refuses one, and the bar skips any that exist
 * anyway. Both halves, per CLAUDE.md.
 */
export async function createPipeline(ctx: AuthContext, input: CreatePipelineInput): Promise<Result> {
  await assertAdminPage(ctx, 'presets');

  const config = await loadConfig();
  // The function enforces this too (and must, against direct SQL) — checking
  // here turns a raised 23503 into a sentence.
  if (!config.modules.some((m) => m.id === input.moduleId)) {
    return { ok: false, message: 'That module no longer exists.' };
  }

  const supabase = supabaseAdmin();
  const { data, error } = await supabase.rpc('create_pipeline', {
    p_module_id: input.moduleId,
    p_label: input.label.trim(),
    p_steps: input.steps.map((s) => ({ label: s.label.trim(), swatch: s.swatch })),
  });
  if (error) return failed(error);
  return { ok: true, id: data as string };
}

/**
 * Renames a pipeline. A plain single-row update, not an RPC: there is no
 * second write to keep it atomic with, and `label` is display-only — nothing
 * references a pipeline by name.
 *
 * `module_id` is absent from the input type entirely rather than being ignored
 * here, so no request shape can move a pipeline between modules (see the file
 * header, and the trigger that holds the same line against direct SQL).
 */
export async function renamePipeline(ctx: AuthContext, input: RenamePipelineInput): Promise<Result> {
  await assertAdminPage(ctx, 'presets');
  const supabase = supabaseAdmin();

  const label = input.label.trim();
  if (!label) return { ok: false, message: 'Label is required.' };

  const { error } = await supabase.from('pipelines').update({ label }).eq('id', input.pipelineId);
  if (error) return failed(error);
  return { ok: true, id: input.pipelineId };
}

/**
 * Replaces a pipeline's whole ordered step list — add, rename, re-colour,
 * reorder. Never removes; a step absent from the list keeps existing and is
 * moved after the submitted ones so it cannot end up sharing a position with
 * them (migration 37 explains why that matters).
 *
 * An existing step's id round-trips unchanged, which is what makes renaming
 * one free: records hold the id, never the label. That is the whole difference
 * from Phase 3, where a choice's identity had to be derived from its label the
 * first time and then frozen.
 */
export async function setPipelineSteps(ctx: AuthContext, input: SetPipelineStepsInput): Promise<SetStepsResult> {
  await assertAdminPage(ctx, 'presets');

  const config = await loadConfig();
  if (!config.pipelines.some((p) => p.id === input.pipelineId)) {
    return { ok: false, message: 'That pipeline no longer exists.' };
  }

  const supabase = supabaseAdmin();
  const { data, error } = await supabase.rpc('set_pipeline_steps', {
    p_pipeline_id: input.pipelineId,
    p_steps: input.steps.map((s) => ({ id: s.id, label: s.label.trim(), swatch: s.swatch })),
  });
  if (error) return failed(error);

  return { ok: true, pipelineId: input.pipelineId, steps: (data ?? []) as AdminStepRow[] };
}

export type RemoveStepResult = { ok: true; moved: number; steps: AdminStepRow[] } | { ok: false; message: string };

/**
 * Removes one step. Its records move to `moveTo` first (required when it has
 * any), each move logged on the record; all in one transaction in the database.
 */
export async function removePipelineStep(ctx: AuthContext, input: RemovePipelineStepInput): Promise<RemoveStepResult> {
  await assertAdminPage(ctx, 'presets');
  const config = await loadConfig();
  if (!config.pipelineSteps.some((s) => s.id === input.stepId && s.pipelineId === input.pipelineId)) {
    return { ok: false, message: 'That step is no longer part of this pipeline.' };
  }
  const { data, error } = await supabaseAdmin().rpc('remove_pipeline_step', { p_step_id: input.stepId, p_move_to: input.moveTo, p_actor: ctx.userId });
  if (error) return failed(error);
  const out = data as { moved: number; steps: AdminStepRow[] };
  return { ok: true, moved: Number(out.moved) || 0, steps: out.steps ?? [] };
}

/**
 * Reorders the pipelines within one module.
 *
 * Only meaningful where a module has more than one, which no module does
 * today — every seeded module has exactly one pipeline and two have none. It
 * exists because nothing stops an admin creating a second, and because
 * `pipelinesForModule` sorts by position, so without this the order of two
 * pipelines would be whatever their creation order happened to be, with no way
 * to change it.
 */
export async function setPipelineOrder(ctx: AuthContext, input: SetPipelineOrderInput): Promise<Result> {
  await assertAdminPage(ctx, 'presets');
  const supabase = supabaseAdmin();

  // De-duplicated for the same reason `adminColumns.ts` does it: a repeated id
  // is not a shape the admin can correct from the form, so it is normalised
  // rather than rejected with a message nobody can act on.
  const seen = new Set<string>();
  const pipelineIds: string[] = [];
  for (const id of input.pipelineIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    pipelineIds.push(id);
  }

  const { error } = await supabase.rpc('set_pipeline_order', {
    p_module_id: input.moduleId,
    p_pipeline_ids: pipelineIds,
  });
  if (error) return failed(error);
  return { ok: true, id: input.moduleId };
}
