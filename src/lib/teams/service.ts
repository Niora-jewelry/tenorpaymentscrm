/**
 * Team Assignment (client spec, 29 Oct 2026). The rules live in the database
 * (migration 9843): these are thin calls on the viewer's own session, so
 * `auth.uid()` is who the rules are asked about. See src/lib/teams/README.md.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from '@/lib/records/permissions';
import type { AssignableTeam, RecordTeams, TeamEntry, TeamResult } from './types';

type ViewRow = { record_id: string; locked: boolean; writable: boolean; teams: TeamEntry[] };

/** The teams on these records, as this viewer may see them. A record they
 *  cannot list has no entry. */
export async function teamsFor(_ctx: AuthContext, recordIds: string[]): Promise<Map<string, RecordTeams>> {
  if (!recordIds.length) return new Map();
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('team_assignment_view', { p_ids: recordIds });
  if (error) throw error;
  return new Map(((data ?? []) as ViewRow[]).map((r) => [r.record_id, { locked: r.locked, writable: r.writable, teams: r.teams ?? [] }]));
}

/** The assign picker: only the teams this viewer can assign (rule 2). */
export async function assignableTeams(_ctx: AuthContext): Promise<AssignableTeam[]> {
  void _ctx; // Holding one is the proof of authorisation; the database asks about auth.uid().
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('team_assign_options');
  if (error) throw error;
  return (data ?? []) as AssignableTeam[];
}

/** A refusal the database worded for the user comes back as that sentence; a
 *  record that has gone reads the same as one that was never there. */
async function run(call: (s: Awaited<ReturnType<typeof createSupabaseServerClient>>) => PromiseLike<{ error: { code?: string; message: string } | null }>): Promise<TeamResult> {
  const supabase = await createSupabaseServerClient();
  const { error } = await call(supabase);
  if (!error) return { ok: true };
  if (error.code && ['42501', '23505', '23503'].includes(error.code)) return { ok: false, message: error.message };
  if (error.message === 'not found') return { ok: false, message: 'This record is no longer available to you.' };
  throw error;
}

export const assignTeam = (_ctx: AuthContext, recordId: string, teamId: string) =>
  run((s) => s.rpc('assign_team', { p_record: recordId, p_team: teamId }));

export const assignMember = (_ctx: AuthContext, recordId: string, teamId: string, userId: string) =>
  run((s) => s.rpc('assign_team_member', { p_record: recordId, p_team: teamId, p_user: userId }));

export const takeAssignment = (_ctx: AuthContext, recordId: string, teamId: string) =>
  run((s) => s.rpc('take_team_assignment', { p_record: recordId, p_team: teamId }));

export const unassignTeam = (_ctx: AuthContext, recordId: string, teamId: string) =>
  run((s) => s.rpc('unassign_team', { p_record: recordId, p_team: teamId }));

export const unassignMember = (_ctx: AuthContext, recordId: string, teamId: string, userId: string) =>
  run((s) => s.rpc('unassign_team_member', { p_record: recordId, p_team: teamId, p_user: userId }));
