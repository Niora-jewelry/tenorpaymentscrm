/**
 * The Email module's own health. Why Microsoft is refusing us, and when the app
 * secret expires, is for Integrations alone (client, 5 Nov 2026): the Email module
 * says only that Outlook can't be reached, to everyone, admins included.
 * Read with the service role (these tables have no policies) — callers must
 * already be on an admin-only path, or pass only the banner text onward.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { integrationValues } from '@/lib/integrations/resolve';
import { MAIL_MESSAGES } from './messages';

export const SECRET_WARNING_DAYS = 30;

/** Days until the client secret expires (negative once past), or null when unknown. Pure. */
export function secretDaysLeft(expiresAt: string | undefined, now = Date.now()): number | null {
  const t = expiresAt ? Date.parse(expiresAt) : NaN;
  return Number.isFinite(t) ? Math.floor((t - now) / 86_400_000) : null;
}

export type ProviderState = 'up' | 'down' | 'config_error';

export async function providerState(): Promise<ProviderState> {
  const { data } = await supabaseAdmin().from('mail_provider_health').select('state').eq('id', 1).maybeSingle();
  return ((data?.state as ProviderState | undefined) ?? 'up');
}

/** The one line a person should see about the whole module, if any. */
export async function moduleNotice(): Promise<{ tone: 'warn' | 'error'; text: string } | null> {
  return (await providerState()) === 'up' ? null : { tone: 'warn', text: MAIL_MESSAGES.providerDown };
}

/** Microsoft has just accepted the app's keys, so stop saying it refuses them. */
export async function clearSecretRefused(): Promise<void> {
  await supabaseAdmin()
    .from('mail_provider_health')
    .update({ state: 'up', last_error_code: null, updated_at: new Date().toISOString() })
    .eq('id', 1)
    .eq('state', 'config_error');
}

export type AdminHealth = {
  provider: ProviderState;
  mailboxes: number;
  attention: number;
  connections: number;
  secretDaysLeft: number | null;
};

export async function adminHealth(): Promise<AdminHealth> {
  const admin = supabaseAdmin();
  const [{ data: boxes }, { count: connections }, provider] = await Promise.all([
    admin.from('mail_mailboxes').select('sync_status').is('deleted_at', null).is('deactivated_at', null),
    admin.from('mail_connections').select('id', { count: 'exact', head: true }).is('disconnected_at', null),
    providerState(),
  ]);
  const list = (boxes ?? []) as Array<{ sync_status: string }>;
  return {
    provider,
    mailboxes: list.length,
    attention: list.filter((b) => ['broken', 'stalled', 'degraded'].includes(b.sync_status)).length,
    connections: connections ?? 0,
    secretDaysLeft: secretDaysLeft((await integrationValues()).MAIL_CLIENT_SECRET_EXPIRES_AT),
  };
}
