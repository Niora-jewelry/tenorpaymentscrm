/**
 * The two sidebar numbers: invitations not yet answered, and chats with something
 * unread. Worked out from Microsoft when the sidebar asks, at most about once a
 * minute per person, and kept so the next page load has a number straight away.
 */
import 'server-only';
import { graphForIdentity } from '@/lib/mail/tokens';
import { teamsGranted } from '@/lib/mail/scopes';
import type { AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { identitiesOf, usable, type Identity } from './access';
import { listForIdentity } from './chat';
import { countUnanswered, type GraphEventShape } from './format';
import { allPages, readThrough } from './snapshots';

export type TeamsCounts = { calendar: number; chat: number };

/** Long enough that several open tabs share one look at Microsoft. */
const FRESH_MS = 45_000;
/** An invitation further out than this has not started to matter. */
const LOOK_AHEAD_DAYS = 60;

export async function storedCounts(userId: string): Promise<TeamsCounts> {
  const { data } = await supabaseAdmin().from('teams_counts').select('calendar_unanswered, chat_unread').eq('user_id', userId).maybeSingle();
  return { calendar: Number(data?.calendar_unanswered ?? 0), chat: Number(data?.chat_unread ?? 0) };
}

async function unanswered(identity: Identity): Promise<number | null> {
  const now = new Date();
  const until = new Date(now.getTime() + LOOK_AHEAD_DAYS * 86400_000);
  const { data } = await readThrough(
    identity.id,
    'unanswered',
    'all',
    () =>
      allPages<GraphEventShape>(graphForIdentity(identity.id), {
        path: '/me/calendarView',
        query: { startDateTime: now.toISOString(), endDateTime: until.toISOString(), $select: 'id,isOrganizer,isCancelled,responseStatus,seriesMasterId', $top: 200 },
      }),
    { maxAgeMs: FRESH_MS },
  );
  return data ? countUnanswered(data) : null;
}

/** Fresh from Microsoft where possible. A failure keeps the last number, never zero. */
export async function refreshCounts(ctx: AuthContext): Promise<TeamsCounts> {
  const { data: row } = await supabaseAdmin().from('teams_counts').select('calendar_unanswered, chat_unread, refreshed_at').eq('user_id', ctx.userId).maybeSingle();
  const held: TeamsCounts = { calendar: Number(row?.calendar_unanswered ?? 0), chat: Number(row?.chat_unread ?? 0) };
  if (row?.refreshed_at && Date.now() - Date.parse(row.refreshed_at as string) < FRESH_MS) return held;

  const identities = (await identitiesOf(ctx.userId)).filter((i) => usable(i) && teamsGranted(i.scopes));
  if (identities.length === 0) {
    if (row) await supabaseAdmin().from('teams_counts').update({ calendar_unanswered: 0, chat_unread: 0, refreshed_at: new Date().toISOString() }).eq('user_id', ctx.userId);
    return { calendar: 0, chat: 0 };
  }

  const each = await Promise.all(
    identities.map(async (identity) => {
      const [calendar, list] = await Promise.all([unanswered(identity), listForIdentity(identity, true, FRESH_MS)]);
      return { calendar, chat: list.stale ? null : list.chats.filter((c) => c.unread).length };
    }),
  );
  const next: TeamsCounts = {
    calendar: each.some((e) => e.calendar === null) ? held.calendar : each.reduce((n, e) => n + (e.calendar ?? 0), 0),
    chat: each.some((e) => e.chat === null) ? held.chat : each.reduce((n, e) => n + (e.chat ?? 0), 0),
  };
  const { error } = await supabaseAdmin()
    .from('teams_counts')
    .upsert({ user_id: ctx.userId, calendar_unanswered: next.calendar, chat_unread: next.chat, refreshed_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) console.error('[teams] could not keep the counts', { code: error.code });
  return next;
}
