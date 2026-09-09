/**
 * Communication tab — Email/Instantly/Text messages. Read-only from this
 * app: "messages arrive via a provider webhook under the service role, which
 * bypasses RLS entirely — there is no client-side 'send' here" (migration 9's
 * `messages_select` policy comment). Nothing in `lib/records/*` ever writes
 * to this table; a provider integration (Outlook/Instantly/Twilio) is a
 * separate, later piece of work — this is the real read path the drawer
 * needs today, not a stand-in for it.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

export type MessageChannel = 'email' | 'instantly' | 'text';

export type Message = {
  id: string;
  recordId: string;
  channel: MessageChannel;
  direction: 'in' | 'out';
  from: string;
  to: string;
  subject: string | null;
  body: string | null;
  sentAt: string;
};

function mapMessage(r: Record<string, unknown>): Message {
  return {
    id: r.id as string, recordId: r.record_id as string, channel: r.channel as MessageChannel,
    direction: r.direction as 'in' | 'out', from: r.from_identity as string, to: r.to_identity as string,
    subject: (r.subject as string | null) ?? null, body: (r.body as string | null) ?? null,
    sentAt: r.sent_at as string,
  };
}

export async function messagesFor(_ctx: AuthContext, recordId: string): Promise<Message[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('messages')
    .select('id, record_id, channel, direction, from_identity, to_identity, subject, body, sent_at')
    .eq('record_id', recordId)
    .order('sent_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapMessage);
}

/** Across every channel — "have they replied at all" doesn't care which
 * channel the reply came in on. */
export async function lastInboundMessage(ctx: AuthContext, recordId: string): Promise<Message | null> {
  const all = await messagesFor(ctx, recordId);
  return all.find((m) => m.direction === 'in') ?? null;
}
