/**
 * POST /api/mail/graph/notifications — Microsoft Graph change notifications.
 *
 * Public in `proxy.ts` (Microsoft has no session). Authenticity is the
 * per-subscription clientState, checked in constant time in `notify.ts`;
 * the body is only ever a hint to re-read an item with our own token.
 */
import { graphWebhook } from '@/lib/mail/sync/webhookRoute';
import { acceptChanges } from '@/lib/mail/sync/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = graphWebhook(acceptChanges);
