/**
 * Pipeline assignment — the step bar in the drawer.
 *
 * "Independent per module" (prototype's own framing, unchanged by the real
 * build): `record_pipelines` keys on `(record_id, module_id)`, so a record's
 * position in the Lead Pipeline and its position in the Deal Pipeline never
 * interact.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

export type PipelineAssignment = { pipelineId: string; stepId: string; updatedAt: string } | null;

export async function pipelineAssignment(
  _ctx: AuthContext,
  recordId: string,
  moduleId: string,
): Promise<PipelineAssignment> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('record_pipelines')
    .select('pipeline_id, step_id, updated_at')
    .eq('record_id', recordId)
    .eq('module_id', moduleId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { pipelineId: data.pipeline_id, stepId: data.step_id, updatedAt: data.updated_at };
}

export async function setPipelineStep(
  _ctx: AuthContext,
  recordId: string,
  moduleId: string,
  pipelineId: string,
  stepId: string,
): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_pipeline_step', {
    p_record_id: recordId,
    p_module_id: moduleId,
    p_pipeline_id: pipelineId,
    p_step_id: stepId,
  });
  if (error) throw error;
}

export async function clearPipeline(_ctx: AuthContext, recordId: string, moduleId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('clear_pipeline', { p_record_id: recordId, p_module_id: moduleId });
  if (error) throw error;
}
