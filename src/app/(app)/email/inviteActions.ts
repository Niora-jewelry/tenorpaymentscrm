'use server';

/**
 * Meeting invitations in the reading pane: when / where, how the person has
 * answered, and Accept / Tentative / Decline — sent from Outlook, so the
 * organiser gets the reply and the calendar updates as it does in Outlook.
 *
 * The event is read when the invitation is opened (Graph's delta can't
 * expand it) and remembered on the message row. Answering needs Edit and the
 * person's OWN connection: nobody replies to a meeting on someone else's
 * behalf, admins included.
 */
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { actingFor } from '@/lib/mail/acting';
import { MAIL_MESSAGES } from '@/lib/mail/messages';
import { mailLog } from '@/lib/mail/log';
import { GraphError } from '@/lib/mail/graph/transport';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export type InviteResponse = 'none' | 'accepted' | 'tentativelyAccepted' | 'declined' | 'organizer' | 'notResponded';
export type InviteView =
  | {
      state: 'ok';
      start: string | null;
      end: string | null;
      timeZone: string | null;
      allDay: boolean;
      location: string | null;
      organizer: string | null;
      response: InviteResponse;
      cancelled: boolean;
      /** False when this person can't answer here (view-only, or someone else's mailbox). */
      canRespond: boolean;
    }
  | { state: 'unavailable' };

type GraphEvent = {
  id?: string;
  isAllDay?: boolean;
  isCancelled?: boolean;
  isOrganizer?: boolean;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  responseStatus?: { response?: string };
};

/** Graph returns event times as a wall-clock string plus a zone; ask for UTC and mark it so. */
const utc = (t?: { dateTime?: string }) => (t?.dateTime ? `${t.dateTime.replace(/\.\d+$/, '')}Z` : null);

async function load(messageId: string) {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('mail_messages')
    .select('id, mailbox_id, graph_id, meeting_message_type')
    .eq('id', messageId)
    .maybeSingle();
  return data as { id: string; mailbox_id: string; graph_id: string; meeting_message_type: string | null } | null;
}

export async function inviteAction(input: { messageId: string }): Promise<Result<InviteView>> {
  const parsed = z.object({ messageId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const ctx = await authorize();
  if (await currentImpersonation()) return { ok: false, message: MAIL_MESSAGES.impersonating };
  let canEdit = true;
  try {
    await requireEmailAccess(ctx, 'view');
    await requireEmailAccess(ctx, 'edit').catch(() => {
      canEdit = false;
    });
  } catch (e) {
    if (e instanceof EmailAccessError) return { ok: false, message: e.message };
    throw e;
  }
  const m = await load(parsed.data.messageId);
  if (!m?.meeting_message_type) return { ok: false, message: 'That invitation is no longer here.' };
  const acting = await actingFor(ctx, m.mailbox_id);
  if (!acting) return { ok: true, data: { state: 'unavailable' } };

  try {
    const res = await acting.graph.request<{ event?: GraphEvent | null }>({
      path: `${acting.root}/messages/${encodeURIComponent(m.graph_id)}`,
      query: {
        $select: 'id',
        $expand: 'microsoft.graph.eventMessage/event($select=id,isAllDay,isCancelled,isOrganizer,start,end,location,organizer,responseStatus)',
      },
      headers: { Prefer: 'outlook.timezone="UTC"' },
    });
    const ev = res?.event;
    if (!ev?.id) return { ok: true, data: { state: 'unavailable' } };
    const response = (ev.isOrganizer ? 'organizer' : (ev.responseStatus?.response ?? 'none')) as InviteResponse;
    await supabaseAdmin()
      .from('mail_messages')
      .update({
        event_graph_id: ev.id,
        event_start: utc(ev.start),
        event_end: utc(ev.end),
        event_location: ev.location?.displayName?.slice(0, 500) || null,
        event_response: response,
      })
      .eq('id', m.id);
    return {
      ok: true,
      data: {
        state: 'ok',
        start: utc(ev.start),
        end: utc(ev.end),
        timeZone: ev.start?.timeZone ?? null,
        allDay: Boolean(ev.isAllDay),
        location: ev.location?.displayName || null,
        organizer: ev.organizer?.emailAddress?.name || ev.organizer?.emailAddress?.address || null,
        response,
        cancelled: Boolean(ev.isCancelled),
        canRespond: canEdit && acting.own && !ev.isOrganizer && !ev.isCancelled,
      },
    };
  } catch (e) {
    const code = e instanceof GraphError ? e.classified.code : 'internal';
    mailLog('warn', 'invites', 'read_failed', { code });
    // Not in the calendar (or no calendar access): the honest answer is "use Outlook".
    if (code === 'not_found' || code === 'scope_missing') return { ok: true, data: { state: 'unavailable' } };
    return { ok: false, message: code === 'throttled' ? MAIL_MESSAGES.busy(10) : MAIL_MESSAGES.providerDown };
  }
}

const VERB = { accept: 'accept', tentative: 'tentativelyAccept', decline: 'decline' } as const;
const STORED: Record<keyof typeof VERB, InviteResponse> = { accept: 'accepted', tentative: 'tentativelyAccepted', decline: 'declined' };

export async function respondInviteAction(input: { messageId: string; response: keyof typeof VERB; comment?: string }): Promise<Result<InviteResponse>> {
  const parsed = z
    .object({ messageId: z.uuid(), response: z.enum(['accept', 'tentative', 'decline']), comment: z.string().max(2000).optional() })
    .safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const ctx = await authorize();
  if (await currentImpersonation()) return { ok: false, message: MAIL_MESSAGES.impersonating };
  try {
    await requireEmailAccess(ctx, 'edit');
  } catch (e) {
    if (e instanceof EmailAccessError) return { ok: false, message: e.message };
    throw e;
  }
  const limit = await rateLimit(userKey('mail_action', ctx.userId), RATE_LIMITS.mailActionPerUser);
  if (!limit.allowed) return { ok: false, message: MAIL_MESSAGES.busy(limit.retryAfterSeconds) };

  const m = await load(parsed.data.messageId);
  if (!m) return { ok: false, message: 'That invitation is no longer here.' };
  const { data: row } = await supabaseAdmin().from('mail_messages').select('event_graph_id').eq('id', m.id).maybeSingle();
  const eventId = row?.event_graph_id as string | null;
  if (!eventId) return { ok: false, message: 'This meeting isn’t in the calendar. Open it in Outlook to respond.' };
  const acting = await actingFor(ctx, m.mailbox_id);
  if (!acting?.own) return { ok: false, message: 'You can answer invitations only in a mailbox you connected yourself.' };

  try {
    const comment = parsed.data.comment?.trim();
    await acting.graph.request({
      method: 'POST',
      path: `${acting.root}/events/${encodeURIComponent(eventId)}/${VERB[parsed.data.response]}`,
      body: { sendResponse: true, ...(comment ? { comment } : {}) },
    });
    const stored = STORED[parsed.data.response];
    const admin = supabaseAdmin();
    await admin.from('mail_messages').update({ event_response: stored }).eq('id', m.id);
    // Outlook may move the invitation (a decline goes to Deleted Items): pick that up soon.
    await admin.rpc('mail_enqueue', { p_mailbox_id: m.mailbox_id, p_kind: 'message_changed', p_target: m.graph_id, p_priority: 3, p_delay_seconds: 3 });
    return { ok: true, data: stored };
  } catch (e) {
    const code = e instanceof GraphError ? e.classified.code : 'internal';
    mailLog('warn', 'invites', 'respond_failed', { code });
    if (code === 'not_found') return { ok: false, message: 'This meeting is no longer in the calendar — it may have been cancelled.' };
    if (code === 'throttled') return { ok: false, message: MAIL_MESSAGES.busy(10) };
    if (code === 'scope_missing') return { ok: false, message: 'Outlook needs one more permission to answer invitations. Reconnect this mailbox in Email settings.' };
    return { ok: false, message: MAIL_MESSAGES.generic };
  }
}
