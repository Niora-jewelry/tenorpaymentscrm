/**
 * POST /api/mail/graph/lifecycle — Microsoft Graph lifecycle notifications
 * (reauthorizationRequired, subscriptionRemoved, missed).
 *
 * Public in `proxy.ts`; authenticated by the subscription's clientState,
 * exactly like the change notifications.
 */
import { graphWebhook } from '@/lib/mail/sync/webhookRoute';
import { acceptLifecycle } from '@/lib/mail/sync/notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const POST = graphWebhook(acceptLifecycle);
