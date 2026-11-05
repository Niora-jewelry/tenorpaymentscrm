'use server';

/**
 * Server actions for broadcast and group texting. Thin shells: parse, authorise,
 * call `lib/phone/*`, say what happened in words. Every rule lives below this.
 */
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import {
  broadcastProblems,
  createBroadcast,
  drainBroadcasts,
  previewBroadcast,
  stopBroadcast,
  type BroadcastLine,
  type BroadcastPreview,
  type BroadcastRefusal,
} from '@/lib/phone/broadcasts';
import { addGroupMember, closeGroup, createGroup, removeGroupMember, sendGroupMessage, type GroupRefusal } from '@/lib/phone/groups';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import { MAX_BROADCAST_RECIPIENTS, MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS } from '@/lib/phone/bulkRules';

export type BulkResult = { ok: true } | { ok: false; message: string };

const numbers = z.array(z.string().trim().min(1).max(40)).min(1, 'Add at least one number.').max(2000, 'That is too many numbers.');
const body = z.string().trim().min(1, 'Type a message first.').max(1600);
const member = z.object({ number: z.string().trim().min(3).max(40), name: z.string().trim().max(120).nullish() });

const first = (e: z.ZodError) => e.issues[0]?.message ?? 'That is not valid.';

const BROADCAST_REFUSAL: Record<BroadcastRefusal, string> = {
  not_permitted: 'You do not have permission to send to many people.',
  no_number: 'You have no phone number assigned. Ask an administrator.',
  not_configured: 'Twilio is not connected yet, so nothing was sent.',
  no_recipients: 'None of these numbers can receive a broadcast, so nothing was sent.',
  too_many: `A broadcast can go to at most ${MAX_BROADCAST_RECIPIENTS} numbers.`,
  rate_limited: 'Too many broadcasts in the last hour. Try again later.',
  not_found: 'That broadcast is not available to you.',
};

const list = (values: string[]) => values.map((v) => (v.startsWith('+') ? formatPhoneDisplay(v) : v)).join(', ');

function groupRefusal(r: GroupRefusal): string {
  switch (r.error) {
    case 'not_permitted':
      return 'You do not have permission to use group texts.';
    case 'no_number':
      return 'You have no phone number assigned. Ask an administrator.';
    case 'not_configured':
      return 'Twilio is not connected yet.';
    case 'rate_limited':
      return 'Too many attempts. Try again in a little while.';
    case 'not_found':
      return 'That group is not available to you.';
    case 'closed':
      return 'This group has been closed.';
    case 'duplicate_group':
      return 'You already have an open group with exactly these people.';
    case 'no_members_left':
      return 'Everyone in this group has opted out, so nothing was sent.';
    case 'number_not_capable':
      return `Your number ${formatPhoneDisplay(r.number)} cannot group text. Twilio needs a US or Canada local number, not toll-free.`;
    case 'too_few':
      return `A group needs at least ${MIN_GROUP_MEMBERS} people.`;
    case 'too_many':
      return `A group can have at most ${MAX_GROUP_MEMBERS} people, because your line counts as the tenth.`;
    case 'bad_numbers':
      return `These are not phone numbers: ${list(r.numbers)}`;
    case 'members_not_capable':
      return `Twilio can only group text US and Canada local numbers, not toll-free or international: ${list(r.numbers)}`;
    case 'members_opted_out':
      return `These numbers replied STOP and cannot be added: ${list(r.numbers)}`;
    case 'twilio_failed':
      return `Twilio did not accept this: ${r.detail}`;
  }
}

export async function previewBroadcastAction(input: unknown): Promise<{ ok: true; preview: BroadcastPreview } | { ok: false; message: string }> {
  const ctx = await authorize();
  const parsed = z.object({ numbers }).safeParse(input);
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  const result = await previewBroadcast(ctx, parsed.data.numbers);
  return result.ok ? result : { ok: false, message: BROADCAST_REFUSAL[result.error] };
}

export async function sendBroadcastAction(input: unknown): Promise<{ ok: true; willReceive: number } | { ok: false; message: string }> {
  const ctx = await authorize();
  const parsed = z.object({ numbers, body }).safeParse(input);
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  const result = await createBroadcast(ctx, parsed.data.numbers, parsed.data.body);
  if (!result.ok) return { ok: false, message: BROADCAST_REFUSAL[result.error] };

  // Starts straight away. The per-minute cron picks up whatever this does not reach.
  after(async () => {
    try {
      await drainBroadcasts(20_000);
    } catch (e) {
      console.error('[broadcast] first run crashed', e instanceof Error ? e.message.slice(0, 200) : 'unknown');
    }
  });
  revalidatePath('/phone');
  return { ok: true, willReceive: result.willReceive };
}

export async function stopBroadcastAction(input: unknown): Promise<BulkResult> {
  const ctx = await authorize();
  const parsed = z.object({ broadcastId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  const result = await stopBroadcast(ctx, parsed.data.broadcastId);
  if (!result.ok) return { ok: false, message: BROADCAST_REFUSAL[result.error] };
  revalidatePath('/phone');
  return { ok: true };
}

export async function broadcastProblemsAction(input: unknown): Promise<{ ok: true; lines: BroadcastLine[] } | { ok: false; message: string }> {
  const ctx = await authorize();
  const parsed = z.object({ broadcastId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  return { ok: true, lines: await broadcastProblems(ctx, parsed.data.broadcastId) };
}

function finish(result: { ok: true } | ({ ok: false } & GroupRefusal)): BulkResult {
  if (!result.ok) return { ok: false, message: groupRefusal(result) };
  revalidatePath('/phone');
  return { ok: true };
}

export async function createGroupAction(input: unknown): Promise<{ ok: true; groupId: string } | { ok: false; message: string }> {
  const ctx = await authorize();
  const parsed = z
    .object({ name: z.string().trim().min(1, 'Give the group a name.').max(60, 'Keep the name under 60 characters.'), members: z.array(member).max(50) })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  const result = await createGroup(ctx, parsed.data);
  if (!result.ok) return { ok: false, message: groupRefusal(result) };
  revalidatePath('/phone');
  return { ok: true, groupId: result.groupId };
}

export async function sendGroupMessageAction(input: unknown): Promise<BulkResult> {
  const ctx = await authorize();
  const parsed = z.object({ groupId: z.string().uuid(), body }).safeParse(input);
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  return finish(await sendGroupMessage(ctx, parsed.data.groupId, parsed.data.body));
}

export async function addGroupMemberAction(input: unknown): Promise<BulkResult> {
  const ctx = await authorize();
  const parsed = z.object({ groupId: z.string().uuid(), member }).safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Enter a phone number.' };
  return finish(await addGroupMember(ctx, parsed.data.groupId, parsed.data.member));
}

export async function removeGroupMemberAction(input: unknown): Promise<BulkResult> {
  const ctx = await authorize();
  const parsed = z.object({ groupId: z.string().uuid(), memberId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  return finish(await removeGroupMember(ctx, parsed.data.groupId, parsed.data.memberId));
}

export async function closeGroupAction(input: unknown): Promise<BulkResult> {
  const ctx = await authorize();
  const parsed = z.object({ groupId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: first(parsed.error) };
  return finish(await closeGroup(ctx, parsed.data.groupId));
}
