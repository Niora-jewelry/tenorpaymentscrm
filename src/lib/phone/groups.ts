/**
 * Group texting, on Twilio Conversations.
 *
 * Reads go through the person's session, so RLS decides what they see. Writes go
 * through the service role after the gate below, because a browser must never be
 * able to write these rows on its own.
 *
 * Only an explicit opt-out blocks somebody, the same rule as a 1-to-1 text: a
 * group is a conversation, not outreach. The rule for broadcasts is stricter.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from '@/lib/records/permissions';
import { integrationValues } from '@/lib/integrations/resolve';
import { getPublicBaseUrl } from '@/lib/twilio/webhook-request';
import { RATE_LIMITS, rateLimit, userKey } from '@/lib/security/rate-limit';
import { isOptedOut, recordConsent, revokeConsent } from '@/lib/sms/consent';
import { isStartKeyword, isStopKeyword } from '@/lib/sms/consentText';
import { canTextMany } from './broadcasts';
import { groupIdentity, isPersonAuthor, isUsLongCode, MAX_GROUP_MEMBERS, MIN_GROUP_MEMBERS, parseRecipients } from './bulkRules';
import { resolveUserActiveNumber } from './numbers';
import { resolveRecordByPhone } from './records';
import { groupTwilio, type GroupTwilio } from './twilioGroups';

export type GroupMember = { id: string; e164: string; name: string | null };
export type GroupMessage = {
  id: string;
  direction: 'in' | 'out';
  authorE164: string | null;
  body: string | null;
  hasMedia: boolean;
  status: string;
  sentAt: string;
};
export type GroupView = {
  id: string;
  name: string;
  fromE164: string;
  createdAt: string;
  canManage: boolean;
  members: GroupMember[];
  messages: GroupMessage[];
};

export type GroupRefusal =
  | { error: 'not_permitted' | 'no_number' | 'not_configured' | 'rate_limited' | 'not_found' | 'closed' | 'duplicate_group' | 'no_members_left' }
  | { error: 'number_not_capable'; number: string }
  | { error: 'too_few' | 'too_many' }
  | { error: 'bad_numbers' | 'members_not_capable' | 'members_opted_out'; numbers: string[] }
  | { error: 'twilio_failed'; detail: string };

type Fail = { ok: false } & GroupRefusal;
type Deps = { twilio?: GroupTwilio };

const cut = (e: unknown) => (e instanceof Error ? e.message.slice(0, 200) : 'Twilio did not accept this.');

async function client(deps: Deps): Promise<GroupTwilio | null> {
  if (deps.twilio) return deps.twilio;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = await integrationValues();
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) return null;
  return groupTwilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
}

/** The latest open groups this person may see, with the recent messages oldest first. */
export async function groupsForUser(ctx: AuthContext): Promise<GroupView[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('sms_groups')
    .select('id, name, owner_id, from_e164, created_at')
    .is('closed_at', null)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  const rows = (data ?? []) as { id: string; name: string; owner_id: string | null; from_e164: string; created_at: string }[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const [{ data: members, error: memberError }, { data: messages, error: messageError }] = await Promise.all([
    supabase.from('sms_group_members').select('id, group_id, e164, display_name').in('group_id', ids).is('removed_at', null).order('added_at'),
    supabase
      .from('sms_group_messages')
      .select('id, group_id, direction, author_e164, body, has_media, status, sent_at')
      .in('group_id', ids)
      .order('sent_at', { ascending: false })
      .limit(500),
  ]);
  if (memberError) throw memberError;
  if (messageError) throw messageError;

  const allowed = await canTextMany(ctx);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    fromE164: r.from_e164,
    createdAt: r.created_at,
    canManage: allowed && (r.owner_id === ctx.userId || ctx.isAdmin),
    members: ((members ?? []) as { id: string; group_id: string; e164: string; display_name: string | null }[])
      .filter((m) => m.group_id === r.id)
      .map((m) => ({ id: m.id, e164: m.e164, name: m.display_name })),
    messages: ((messages ?? []) as {
      id: string;
      group_id: string;
      direction: 'in' | 'out';
      author_e164: string | null;
      body: string | null;
      has_media: boolean;
      status: string;
      sent_at: string;
    }[])
      .filter((m) => m.group_id === r.id)
      .slice(0, 100)
      .reverse()
      .map((m) => ({
        id: m.id,
        direction: m.direction,
        authorE164: m.author_e164,
        body: m.body,
        hasMedia: m.has_media,
        status: m.status,
        sentAt: m.sent_at,
      })),
  }));
}

export type NewMember = { number: string; name?: string | null };

async function checkMembers(members: NewMember[]) {
  const parsed = parseRecipients(members.map((m) => m.number));
  if (parsed.invalid.length) return { ok: false as const, error: 'bad_numbers' as const, numbers: parsed.invalid };
  const notCapable = parsed.numbers.filter((n) => !isUsLongCode(n));
  if (notCapable.length) return { ok: false as const, error: 'members_not_capable' as const, numbers: notCapable };
  const optedOut: string[] = [];
  for (const n of parsed.numbers) if (await isOptedOut(n)) optedOut.push(n);
  if (optedOut.length) return { ok: false as const, error: 'members_opted_out' as const, numbers: optedOut };

  const nameOf = new Map<string, string | null>();
  members.forEach((m, i) => {
    const e164 = parseRecipients([members[i]!.number]).numbers[0];
    if (e164 && !nameOf.has(e164)) nameOf.set(e164, m.name?.trim() || null);
  });
  return { ok: true as const, numbers: parsed.numbers, nameOf };
}

export async function createGroup(
  ctx: AuthContext,
  input: { name: string; members: NewMember[] },
  deps: Deps = {},
): Promise<{ ok: true; groupId: string } | Fail> {
  if (!(await canTextMany(ctx))) return { ok: false, error: 'not_permitted' };

  const admin = supabaseAdmin();
  const myNumber = await resolveUserActiveNumber(admin, ctx.userId);
  if (!myNumber) return { ok: false, error: 'no_number' };
  if (!isUsLongCode(myNumber.e164)) return { ok: false, error: 'number_not_capable', number: myNumber.e164 };

  const checked = await checkMembers(input.members);
  if (!checked.ok) return { ok: false, error: checked.error, numbers: checked.numbers };
  if (checked.numbers.length < MIN_GROUP_MEMBERS) return { ok: false, error: 'too_few' };
  if (checked.numbers.length > MAX_GROUP_MEMBERS) return { ok: false, error: 'too_many' };

  const baseUrl = getPublicBaseUrl();
  const tw = await client(deps);
  if (!baseUrl || !tw) return { ok: false, error: 'not_configured' };

  const limited = await rateLimit(userKey('sms_group_create', ctx.userId), RATE_LIMITS.smsGroupCreatePerUserHour);
  if (!limited.allowed) return { ok: false, error: 'rate_limited' };

  // Twilio refuses a second group of the same people on the same number.
  const { data: existing, error: existingError } = await admin
    .from('sms_groups')
    .select('id, sms_group_members!inner(e164, removed_at)')
    .eq('from_e164', myNumber.e164)
    .is('closed_at', null)
    .is('sms_group_members.removed_at', null);
  if (existingError) throw existingError;
  const wanted = [...checked.numbers].sort().join();
  for (const g of (existing ?? []) as { sms_group_members: { e164: string }[] }[]) {
    if (g.sms_group_members.map((m) => m.e164).sort().join() === wanted) return { ok: false, error: 'duplicate_group' };
  }

  const { data: group, error: groupError } = await admin
    .from('sms_groups')
    .insert({ name: input.name, owner_id: ctx.userId, created_by: ctx.userId, from_e164: myNumber.e164 })
    .select('id')
    .single();
  if (groupError) throw groupError;
  const groupId = group.id as string;

  let conversationSid: string | null = null;
  try {
    conversationSid = await tw.createConversation(input.name);
    await tw.addWebhook(conversationSid, `${baseUrl}/api/twilio/group-message`);
    await tw.addCrmLine(conversationSid, groupIdentity(groupId), myNumber.e164);

    const rows = [];
    for (const e164 of checked.numbers) {
      rows.push({
        group_id: groupId,
        e164,
        display_name: checked.nameOf.get(e164) ?? null,
        record_id: await resolveRecordByPhone(admin, e164),
        twilio_participant_sid: await tw.addMember(conversationSid, e164),
      });
    }
    const { error: linkError } = await admin.from('sms_groups').update({ twilio_conversation_sid: conversationSid }).eq('id', groupId);
    if (linkError) throw linkError;
    const { error: memberError } = await admin.from('sms_group_members').insert(rows);
    if (memberError) throw memberError;
    return { ok: true, groupId };
  } catch (cause) {
    // Nothing has been texted yet, so leave no half-made group on either side.
    if (conversationSid) await tw.discard(conversationSid).catch(() => undefined);
    await admin.from('sms_groups').delete().eq('id', groupId);
    return { ok: false, error: 'twilio_failed', detail: cut(cause) };
  }
}

type GroupRow = { id: string; owner_id: string | null; twilio_conversation_sid: string | null; closed_at: string | null };

/** The group, if this person may act on it. */
async function managed(ctx: AuthContext, groupId: string): Promise<GroupRow | Fail> {
  if (!(await canTextMany(ctx))) return { ok: false, error: 'not_permitted' };
  const { data, error } = await supabaseAdmin()
    .from('sms_groups')
    .select('id, owner_id, twilio_conversation_sid, closed_at')
    .eq('id', groupId)
    .maybeSingle();
  if (error) throw error;
  const row = data as GroupRow | null;
  if (!row || !row.twilio_conversation_sid || (row.owner_id !== ctx.userId && !ctx.isAdmin)) return { ok: false, error: 'not_found' };
  if (row.closed_at) return { ok: false, error: 'closed' };
  return row;
}

const refused = (x: GroupRow | Fail): x is Fail => 'ok' in x;

/** Takes somebody out of the group on both sides. */
async function dropMember(
  tw: GroupTwilio,
  conversationSid: string,
  member: { id: string; twilio_participant_sid: string | null },
  reason: string,
): Promise<void> {
  if (member.twilio_participant_sid) await tw.removeMember(conversationSid, member.twilio_participant_sid);
  const { error } = await supabaseAdmin()
    .from('sms_group_members')
    .update({ removed_at: new Date().toISOString(), removed_reason: reason })
    .eq('id', member.id)
    .is('removed_at', null);
  if (error) throw error;
}

export async function sendGroupMessage(
  ctx: AuthContext,
  groupId: string,
  body: string,
  deps: Deps = {},
): Promise<{ ok: true } | Fail> {
  const group = await managed(ctx, groupId);
  if (refused(group)) return group;
  const tw = await client(deps);
  if (!tw) return { ok: false, error: 'not_configured' };

  const limited = await rateLimit(userKey('sms_group_send', ctx.userId), RATE_LIMITS.smsGroupSendPerUserMinute);
  if (!limited.allowed) return { ok: false, error: 'rate_limited' };

  const admin = supabaseAdmin();
  const sid = group.twilio_conversation_sid!;
  const { data: members, error: memberError } = await admin
    .from('sms_group_members')
    .select('id, e164, twilio_participant_sid')
    .eq('group_id', groupId)
    .is('removed_at', null);
  if (memberError) throw memberError;

  // Somebody may have replied STOP to a different text since the last message.
  let remaining = 0;
  for (const m of (members ?? []) as { id: string; e164: string; twilio_participant_sid: string | null }[]) {
    if (await isOptedOut(m.e164)) {
      try {
        await dropMember(tw, sid, m, 'opted out');
      } catch (cause) {
        return { ok: false, error: 'twilio_failed', detail: cut(cause) };
      }
    } else {
      remaining += 1;
    }
  }
  if (remaining === 0) return { ok: false, error: 'no_members_left' };

  const { data: row, error: insertError } = await admin
    .from('sms_group_messages')
    .insert({ group_id: groupId, direction: 'out', body, status: 'queued', created_by: ctx.userId })
    .select('id')
    .single();
  if (insertError) throw insertError;

  try {
    const messageSid = await tw.send(sid, groupIdentity(groupId), body);
    await admin.from('sms_group_messages').update({ twilio_message_sid: messageSid, status: 'sent' }).eq('id', row.id);
    return { ok: true };
  } catch (cause) {
    await admin.from('sms_group_messages').update({ status: 'failed' }).eq('id', row.id);
    return { ok: false, error: 'twilio_failed', detail: cut(cause) };
  }
}

export async function addGroupMember(
  ctx: AuthContext,
  groupId: string,
  member: NewMember,
  deps: Deps = {},
): Promise<{ ok: true } | Fail> {
  const group = await managed(ctx, groupId);
  if (refused(group)) return group;

  const checked = await checkMembers([member]);
  if (!checked.ok) return { ok: false, error: checked.error, numbers: checked.numbers };
  const e164 = checked.numbers[0]!;

  const admin = supabaseAdmin();
  const { count, error: countError } = await admin
    .from('sms_group_members')
    .select('id', { count: 'exact', head: true })
    .eq('group_id', groupId)
    .is('removed_at', null);
  if (countError) throw countError;
  if ((count ?? 0) >= MAX_GROUP_MEMBERS) return { ok: false, error: 'too_many' };

  const tw = await client(deps);
  if (!tw) return { ok: false, error: 'not_configured' };

  let participantSid: string;
  try {
    participantSid = await tw.addMember(group.twilio_conversation_sid!, e164);
  } catch (cause) {
    return { ok: false, error: 'twilio_failed', detail: cut(cause) };
  }
  const { error } = await admin.from('sms_group_members').insert({
    group_id: groupId,
    e164,
    display_name: checked.nameOf.get(e164) ?? null,
    record_id: await resolveRecordByPhone(admin, e164),
    twilio_participant_sid: participantSid,
  });
  if (error) throw error;
  return { ok: true };
}

export async function removeGroupMember(
  ctx: AuthContext,
  groupId: string,
  memberId: string,
  deps: Deps = {},
): Promise<{ ok: true } | Fail> {
  const group = await managed(ctx, groupId);
  if (refused(group)) return group;

  const admin = supabaseAdmin();
  const { data: member, error } = await admin
    .from('sms_group_members')
    .select('id, twilio_participant_sid')
    .eq('id', memberId)
    .eq('group_id', groupId)
    .is('removed_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!member) return { ok: false, error: 'not_found' };

  const tw = await client(deps);
  if (!tw) return { ok: false, error: 'not_configured' };
  try {
    await dropMember(tw, group.twilio_conversation_sid!, member, 'removed by user');
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: 'twilio_failed', detail: cut(cause) };
  }
}

export async function closeGroup(ctx: AuthContext, groupId: string, deps: Deps = {}): Promise<{ ok: true } | Fail> {
  const group = await managed(ctx, groupId);
  if (refused(group)) return group;
  const tw = await client(deps);
  if (!tw) return { ok: false, error: 'not_configured' };
  try {
    await tw.close(group.twilio_conversation_sid!);
  } catch (cause) {
    return { ok: false, error: 'twilio_failed', detail: cut(cause) };
  }
  const { error } = await supabaseAdmin().from('sms_groups').update({ closed_at: new Date().toISOString() }).eq('id', groupId);
  if (error) throw error;
  return { ok: true };
}

/**
 * A person replied in a group. Twilio may deliver this more than once. The opt-out
 * runs before the duplicate check, so a retry after a crash still honours it, and
 * doing it twice is harmless.
 */
export async function recordGroupReply(params: Record<string, string>, deps: Deps = {}): Promise<'stored' | 'ignored'> {
  if (params.EventType !== 'onMessageAdded' || !params.MessageSid || !params.ConversationSid) return 'ignored';
  if (!isPersonAuthor(params.Author, params.Source)) return 'ignored';
  const author = params.Author!;
  const body = params.Body ?? '';

  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('sms_groups')
    .select('id, name, owner_id')
    .eq('twilio_conversation_sid', params.ConversationSid)
    .maybeSingle();
  if (error) throw error;
  if (!data) return 'ignored';
  const group = data as { id: string; name: string; owner_id: string | null };

  if (isStopKeyword(body)) {
    await revokeConsent(author, 'replied STOP in a group text');
    const { data: member, error: memberError } = await admin
      .from('sms_group_members')
      .select('id, twilio_participant_sid')
      .eq('group_id', group.id)
      .eq('e164', author)
      .is('removed_at', null)
      .maybeSingle();
    if (memberError) throw memberError;
    const tw = await client(deps);
    if (member && tw) await dropMember(tw, params.ConversationSid, member, 'replied STOP');
  } else if (isStartKeyword(body)) {
    await recordConsent({ e164: author, source: 'verbal', note: 'Re-subscribed by replying START in a group text.' });
  }

  const { data: stored, error: insertError } = await admin
    .from('sms_group_messages')
    .upsert(
      {
        group_id: group.id,
        direction: 'in',
        author_e164: author,
        body: body || null,
        has_media: Boolean(params.Media && params.Media !== '[]'),
        twilio_message_sid: params.MessageSid,
        status: 'received',
      },
      { onConflict: 'twilio_message_sid', ignoreDuplicates: true },
    )
    .select('id');
  if (insertError) throw insertError;
  if (!stored?.length) return 'ignored';

  // Without this a reply would sit unseen until someone happened to open the group.
  if (group.owner_id) {
    const { error: notifyError } = await admin.rpc('notify', {
      p_recipient_id: group.owner_id,
      p_body: `New text in the group ${group.name}`,
      p_record_id: null,
      p_source_kind: 'sms',
    });
    if (notifyError) console.error('[group text] notify failed', notifyError.code);
  }
  return 'stored';
}
