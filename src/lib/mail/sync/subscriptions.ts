/**
 * Microsoft Graph change notifications for a mailbox: create, renew,
 * recreate.
 *
 * Two subscriptions per mailbox cover everything: `/users/{id}/messages`
 * (every message in every folder) and `/users/{id}/mailFolders` (the tree).
 * Notifications only say WHAT changed; the engine then re-reads that item,
 * so a lost or duplicated notification costs at most one extra fetch, and
 * the tiered delta reconciliation catches anything that never arrives.
 *
 * Each subscription has its own 32-byte random `clientState`, compared in
 * constant time on every notification — the only proof a POST really came
 * from Microsoft for a subscription we made.
 *
 * Off unless MAIL_WEBHOOKS_ENABLED=true: preview deployments must never
 * register subscriptions pointing at themselves. Off → `subscription_healthy`
 * stays false and hot folders are polled every minute instead.
 */
import 'server-only';
import { randomBytes } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { mailConfig } from '../config';
import { GraphError } from '../graph/transport';
import { mailLog } from '../log';
import type { MailboxCtx } from './ingest';

/** Just under Graph's 10,080-minute ceiling for Outlook resources. */
export const SUBSCRIPTION_MINUTES = 10_020;
/** Renew once less than a day is left — renewals then never race expiry. */
export const RENEW_WITHIN_MS = 24 * 3600 * 1000;

export const NOTIFY_PATH = '/api/mail/graph/notifications';
export const LIFECYCLE_PATH = '/api/mail/graph/lifecycle';

type Resource = 'messages' | 'mailFolders';
const RESOURCES: Resource[] = ['messages', 'mailFolders'];

type SubRow = {
  id: string;
  resource: Resource;
  graph_subscription_id: string | null;
  client_state: string;
  expires_at: string | null;
  status: string;
};

type GraphSubscription = { id?: string; expirationDateTime?: string };

/** What a healthy pair looks like, decided in one place. */
export function isHealthy(rows: Array<Pick<SubRow, 'resource' | 'status' | 'expires_at'>>, now = Date.now()): boolean {
  return RESOURCES.every((r) => {
    const row = rows.find((x) => x.resource === r);
    return !!row && row.status === 'active' && !!row.expires_at && Date.parse(row.expires_at) > now;
  });
}

export async function ensureSubscriptions(ctx: MailboxCtx, now = Date.now()): Promise<{ healthy: boolean; created: number; renewed: number }> {
  const admin = supabaseAdmin();
  const cfg = mailConfig();
  if (!cfg.webhooksEnabled) {
    await admin.from('mail_mailboxes').update({ subscription_healthy: false }).eq('id', ctx.id);
    return { healthy: false, created: 0, renewed: 0 };
  }

  const { data, error } = await admin
    .from('mail_subscriptions')
    .select('id, resource, graph_subscription_id, client_state, expires_at, status')
    .eq('mailbox_id', ctx.id);
  if (error) throw new Error(`mail_subscriptions read failed: ${error.code ?? 'db'}`);
  const rows = (data ?? []) as SubRow[];
  const expiry = new Date(now + SUBSCRIPTION_MINUTES * 60_000).toISOString();
  let created = 0;
  let renewed = 0;

  for (const resource of RESOURCES) {
    const row = rows.find((r) => r.resource === resource);
    const live = row?.status === 'active' && row.graph_subscription_id && row.expires_at;
    if (live && Date.parse(row.expires_at!) - now > RENEW_WITHIN_MS) continue;

    try {
      if (live) {
        try {
          const res = await ctx.graph.request<GraphSubscription>({
            method: 'PATCH',
            path: `/subscriptions/${encodeURIComponent(row.graph_subscription_id!)}`,
            body: { expirationDateTime: expiry },
          });
          await admin
            .from('mail_subscriptions')
            .update({ expires_at: res?.expirationDateTime ?? expiry, renewed_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() })
            .eq('id', row.id);
          renewed += 1;
          continue;
        } catch (e) {
          // Gone on Microsoft's side (expired, removed): make a new one below.
          if (!(e instanceof GraphError) || e.classified.code !== 'not_found') throw e;
        }
      }

      const clientState = randomBytes(32).toString('base64url');
      const res = await ctx.graph.request<GraphSubscription>({
        method: 'POST',
        path: '/subscriptions',
        body: {
          changeType: 'created,updated,deleted',
          notificationUrl: `${cfg.webhookBase}${NOTIFY_PATH}`,
          lifecycleNotificationUrl: `${cfg.webhookBase}${LIFECYCLE_PATH}`,
          resource: `${ctx.root.slice(1)}/${resource}`,
          expirationDateTime: expiry,
          clientState,
        },
      });
      if (!res?.id) throw new GraphError(0, { code: 'unknown', reaction: 'none', detail: 'no_subscription_id' }, null);

      const stale = row?.graph_subscription_id;
      const { error: upErr } = await admin.from('mail_subscriptions').upsert(
        {
          mailbox_id: ctx.id,
          resource,
          graph_subscription_id: res.id,
          client_state: clientState,
          expires_at: res.expirationDateTime ?? expiry,
          status: 'active',
          last_error: null,
          renewed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'mailbox_id,resource' },
      );
      if (upErr) throw new Error(`mail_subscriptions upsert failed: ${upErr.code ?? 'db'}`);
      created += 1;

      // Best effort: the replaced one would otherwise keep posting until it lapses.
      if (stale && stale !== res.id) {
        await ctx.graph.request({ method: 'DELETE', path: `/subscriptions/${encodeURIComponent(stale)}` }).catch(() => {});
      }
    } catch (e) {
      const c = e instanceof GraphError ? e.classified : null;
      mailLog('warn', 'subscriptions', 'ensure_failed', { mailboxId: ctx.id, resource, code: c?.code ?? 'internal' });
      if (row) {
        await admin
          .from('mail_subscriptions')
          .update({ status: 'failed', last_error: (c?.code ?? 'internal').slice(0, 500), updated_at: new Date().toISOString() })
          .eq('id', row.id);
      }
      // Throttling and a dead sign-in are the drain's to handle; anything else
      // just leaves this mailbox on polling until the next attempt.
      if (c?.code === 'throttled' || c?.connection === 'broken') throw e;
    }
  }

  const { data: after } = await admin.from('mail_subscriptions').select('resource, status, expires_at').eq('mailbox_id', ctx.id);
  const healthy = isHealthy((after ?? []) as SubRow[], now);
  await admin.from('mail_mailboxes').update({ subscription_healthy: healthy }).eq('id', ctx.id);
  return { healthy, created, renewed };
}
