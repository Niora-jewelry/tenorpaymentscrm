/**
 * Whose Microsoft sign-in acts when a person reads or changes something in a
 * mailbox.
 *
 *   * Their OWN connection to that mailbox, while it works.
 *   * Otherwise — an admin looking at a member's personal mailbox, which the
 *     spec allows — the mailbox's sync identity: the connector whose token
 *     already pulls it. The admin acts with that person's delegated access,
 *     never more (spec item 8, told to Izzy).
 *
 * Callers must already have proved the person may SEE the mailbox (an RLS
 * read through the request-scoped client). This picks a token; it is not the
 * permission check.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from '@/lib/records/permissions';
import { graphForIdentity } from './tokens';
import { rootFor } from './sync/folders';
import type { GraphTransport } from './graph/transport';

export type Acting = { identityId: string; root: string; graph: GraphTransport; own: boolean };

export async function actingFor(ctx: AuthContext, mailboxId: string): Promise<Acting | null> {
  const admin = supabaseAdmin();
  const { data: mb } = await admin
    .from('mail_mailboxes')
    .select('id, address, graph_user_id, sync_identity_id, deleted_at')
    .eq('id', mailboxId)
    .maybeSingle();
  if (!mb || mb.deleted_at) return null;

  const { data: own } = await admin
    .from('mail_connections')
    .select('identity_id, status')
    .eq('mailbox_id', mailboxId)
    .eq('user_id', ctx.userId)
    .is('disconnected_at', null)
    .in('status', ['ok', 'degraded'])
    .maybeSingle();

  const identityId = (own?.identity_id as string | undefined) ?? (mb.sync_identity_id as string | null);
  if (!identityId) return null;
  return {
    identityId,
    root: rootFor({ graph_user_id: mb.graph_user_id as string | null, address: mb.address as string }),
    graph: graphForIdentity(identityId),
    own: Boolean(own),
  };
}
