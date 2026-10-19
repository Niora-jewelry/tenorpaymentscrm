/**
 * What to do with a POST from Microsoft's notification service.
 *
 * A notification is a HINT, never data: it names a subscription and an item,
 * and the engine re-reads that item from Graph with our own token. So the
 * only things trusted from the body are which subscription it claims to be
 * for — checked against the clientState we generated, in constant time —
 * and which message id to look at. Unknown subscriptions, wrong
 * clientStates and mailboxes nobody uses any more are dropped silently with
 * a 2xx, so Microsoft does not retry them.
 *
 * Every change type becomes "re-read this message" (`message_changed`):
 * with immutable ids a move can surface as deleted-then-created, and a blind
 * delete would drop a message that merely changed folder. The re-read sees
 * where it lives now, or that it is gone.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { safeEqual } from '../oauthState';
import { mailLog } from '../log';
import { rateLimit, RATE_LIMITS } from '@/lib/security/rate-limit';
import { drainMailbox, type ClaimedMailbox } from './drain';

export const MAX_NOTIFICATION_BYTES = 1_000_000;

const Change = z.object({
  subscriptionId: z.string().min(1).max(200),
  clientState: z.string().max(256).nullish(),
  changeType: z.string().max(64).nullish(),
  resource: z.string().max(2000).nullish(),
  resourceData: z.object({ id: z.string().max(1000).nullish() }).passthrough().nullish(),
  lifecycleEvent: z.string().max(64).nullish(),
});
const Envelope = z.object({ value: z.array(Change).max(1000) });
export type Notification = z.infer<typeof Change>;

/** Parses a body; anything malformed is an empty list, never an exception. */
export function parseNotifications(raw: string): Notification[] {
  if (!raw || raw.length > MAX_NOTIFICATION_BYTES) return [];
  try {
    const parsed = Envelope.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.value : [];
  } catch {
    return [];
  }
}

/** The message id a notification is about: resourceData.id, else the resource path's last segment. */
export function messageIdOf(n: Notification): string | null {
  const id = n.resourceData?.id;
  if (id) return id;
  const m = /\/messages\/([^/?]+)$/i.exec(n.resource ?? '');
  return m ? decodeURIComponent(m[1]).replace(/^\('|'\)$/g, '') : null;
}

type SubRow = {
  id: string;
  mailbox_id: string;
  resource: 'messages' | 'mailFolders';
  graph_subscription_id: string;
  client_state: string;
  mail_mailboxes: { deactivated_at: string | null; deleted_at: string | null } | null;
};

/** Only notifications for a live subscription of ours, with the right clientState. */
async function authentic(items: Notification[]): Promise<Array<{ n: Notification; sub: SubRow }>> {
  const ids = [...new Set(items.map((n) => n.subscriptionId))];
  if (ids.length === 0) return [];
  const { data, error } = await supabaseAdmin()
    .from('mail_subscriptions')
    .select('id, mailbox_id, resource, graph_subscription_id, client_state, mail_mailboxes(deactivated_at, deleted_at)')
    .in('graph_subscription_id', ids)
    .returns<SubRow[]>();
  if (error) throw new Error(`mail_subscriptions read failed: ${error.code ?? 'db'}`);
  const bySub = new Map((data ?? []).map((s) => [s.graph_subscription_id, s]));

  const out: Array<{ n: Notification; sub: SubRow }> = [];
  let rejected = 0;
  for (const n of items) {
    const sub = bySub.get(n.subscriptionId);
    if (!sub || sub.mail_mailboxes?.deactivated_at || sub.mail_mailboxes?.deleted_at) continue;
    if (!n.clientState || !safeEqual(n.clientState, sub.client_state)) {
      rejected += 1;
      continue;
    }
    out.push({ n, sub });
  }
  if (rejected) mailLog('warn', 'notify', 'client_state_mismatch', { count: rejected });
  return out;
}

/** Change notifications → queue work. Returns the mailboxes to drain now. */
export async function acceptChanges(items: Notification[]): Promise<string[]> {
  const admin = supabaseAdmin();
  const ok = await authentic(items);
  const touched = new Set<string>();
  const seenSubs = new Set<string>();

  for (const { n, sub } of ok) {
    if (!seenSubs.has(sub.id)) {
      seenSubs.add(sub.id);
      const limit = await rateLimit(`mail_notify:sub:${sub.id}`, RATE_LIMITS.mailNotifyPerSubscription);
      if (!limit.allowed) continue;
    }
    if (sub.resource === 'mailFolders') {
      await admin.rpc('mail_enqueue', { p_mailbox_id: sub.mailbox_id, p_kind: 'folders_refresh', p_target: '', p_priority: 2 });
    } else {
      const id = messageIdOf(n);
      if (!id) continue;
      await admin.rpc('mail_enqueue', { p_mailbox_id: sub.mailbox_id, p_kind: 'message_changed', p_target: id, p_priority: 1 });
    }
    touched.add(sub.mailbox_id);
  }
  if (seenSubs.size) {
    await admin.from('mail_subscriptions').update({ last_notification_at: new Date().toISOString() }).in('id', [...seenSubs]);
  }
  return [...touched];
}

/**
 * Lifecycle notifications: Microsoft telling us a subscription needs care.
 *   reauthorizationRequired → renew it now
 *   subscriptionRemoved     → it is gone: recreate, and catch up meanwhile
 *   missed                  → notifications were lost: reconcile hot folders
 */
export async function acceptLifecycle(items: Notification[]): Promise<string[]> {
  const admin = supabaseAdmin();
  const ok = await authentic(items);
  const touched = new Set<string>();
  for (const { n, sub } of ok) {
    const event = n.lifecycleEvent ?? '';
    if (event === 'reauthorizationRequired') {
      // Pull its expiry inside the renewal window so ensure PATCHes it.
      await admin.from('mail_subscriptions').update({ expires_at: new Date(Date.now() + 60_000).toISOString() }).eq('id', sub.id);
      await admin.rpc('mail_enqueue', { p_mailbox_id: sub.mailbox_id, p_kind: 'subscription_ensure', p_target: '', p_priority: 1 });
    } else if (event === 'subscriptionRemoved') {
      await admin.from('mail_subscriptions').update({ status: 'removed', updated_at: new Date().toISOString() }).eq('id', sub.id);
      await admin.from('mail_mailboxes').update({ subscription_healthy: false }).eq('id', sub.mailbox_id);
      await admin.rpc('mail_enqueue', { p_mailbox_id: sub.mailbox_id, p_kind: 'subscription_ensure', p_target: '', p_priority: 1 });
      await admin.rpc('mail_enqueue_hot', { p_mailbox_id: sub.mailbox_id });
    } else if (event === 'missed') {
      await admin.rpc('mail_enqueue_hot', { p_mailbox_id: sub.mailbox_id });
    } else {
      continue;
    }
    mailLog('info', 'notify', 'lifecycle', { mailboxId: sub.mailbox_id, event });
    touched.add(sub.mailbox_id);
  }
  return [...touched];
}

/**
 * Works the queued items right away, inside the request's `after()`, so a
 * change in Outlook reaches the CRM in seconds rather than at the next
 * minute's tick. A mailbox already leased (a tick is on it) is skipped — that
 * run picks the new items up.
 */
export async function drainSoon(mailboxIds: string[], budgetMs = 20_000): Promise<void> {
  if (mailboxIds.length === 0) return;
  const admin = supabaseAdmin();
  const owner = `notify-${randomUUID()}`;
  const deadline = Date.now() + budgetMs;

  const hasDueWork = async (id: string) => {
    const { count } = await admin
      .from('mail_sync_queue')
      .select('id', { count: 'exact', head: true })
      .eq('mailbox_id', id)
      .is('processed_at', null)
      .lte('not_before', new Date().toISOString());
    return (count ?? 0) > 0;
  };

  await Promise.all(
    mailboxIds.slice(0, 10).map(async (id) => {
      // A run already holding the lease may have made its last queue check
      // just before this notification's item landed. So keep trying while
      // work is due, instead of leaving it for the next minute's tick.
      while (Date.now() < deadline - 3_000) {
        const { data } = await admin.rpc('mail_claim_mailboxes', {
          p_owner: owner,
          p_limit: 1,
          p_lease_seconds: Math.ceil((deadline - Date.now()) / 1000) + 30,
          p_only: id,
        });
        const mb = (data ?? [])[0] as ClaimedMailbox | undefined;
        if (mb) {
          try {
            await drainMailbox(mb, deadline, owner, 'notify');
          } catch (e) {
            mailLog('error', 'notify', 'drain_crashed', { mailboxId: id, message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
            await admin.from('mail_mailboxes').update({ lease_until: null, lease_owner: null }).eq('id', id).eq('lease_owner', owner);
            return;
          }
        } else {
          await new Promise((r) => setTimeout(r, 1_000));
        }
        if (!(await hasDueWork(id))) return;
      }
    }),
  );
}
