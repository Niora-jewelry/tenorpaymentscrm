'use server';

/**
 * The Team Assignment actions. Parsed here; every rule is in the database.
 * Each one revalidates the module, so the list and the drawer both redraw
 * from what the viewer may now see.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { assignMember, assignTeam, takeAssignment, unassignMember, unassignTeam } from '@/lib/teams/service';
import type { TeamResult } from '@/lib/teams/types';

const teamInput = z.object({
  moduleSlug: z.string().regex(/^[a-z0-9-]{1,60}$/),
  recordId: z.string().uuid(),
  teamId: z.string().uuid(),
});
const memberInput = teamInput.extend({ userId: z.string().uuid() });

const BAD: TeamResult = { ok: false, message: 'That request was not valid.' };

export async function assignTeamAction(input: unknown): Promise<TeamResult> {
  const p = teamInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await assignTeam(ctx, p.data.recordId, p.data.teamId);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}

export async function assignMemberAction(input: unknown): Promise<TeamResult> {
  const p = memberInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await assignMember(ctx, p.data.recordId, p.data.teamId, p.data.userId);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}

export async function takeAssignmentAction(input: unknown): Promise<TeamResult> {
  const p = teamInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await takeAssignment(ctx, p.data.recordId, p.data.teamId);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}

export async function unassignTeamAction(input: unknown): Promise<TeamResult> {
  const p = teamInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await unassignTeam(ctx, p.data.recordId, p.data.teamId);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}

export async function unassignMemberAction(input: unknown): Promise<TeamResult> {
  const p = memberInput.safeParse(input);
  if (!p.success) return BAD;
  const ctx = await authorize();
  const r = await unassignMember(ctx, p.data.recordId, p.data.teamId, p.data.userId);
  revalidatePath(`/${p.data.moduleSlug}`);
  return r;
}
