/**
 * The Email module's own health, for admins: is Microsoft accepting our app
 * secret, when does that secret expire, and how many mailboxes need someone.
 * Read with the service role (these tables have no policies) — callers must
 * already be on an admin-only path, or pass only the banner text onward.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { serverEnv } from '@/lib/env.server';
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

/**
 * The one line a person should see about the whole module, if any: the
 * secret has expired or is about to (admins), or Outlook can't be reached.
 */
export async function moduleNotice(isAdmin: boolean): Promise<{ tone: 'warn' | 'error'; text: string } | null> {
  const state = await providerState();
  if (state === 'config_error') return { tone: 'error', text: isAdmin ? MAIL_MESSAGES.appSecretAdmin : MAIL_MESSAGES.providerDown };
  if (state === 'down') return { tone: 'warn', text: MAIL_MESSAGES.providerDown };
  if (!isAdmin) return null;
  const days = secretDaysLeft(serverEnv.MAIL_CLIENT_SECRET_EXPIRES_AT);
  if (days !== null && days <= SECRET_WARNING_DAYS) {
    const on = new Date(Date.parse(serverEnv.MAIL_CLIENT_SECRET_EXPIRES_AT!)).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    return {
      tone: days <= 7 ? 'error' : 'warn',
      text:
        days < 0
          ? `The Microsoft app secret expired on ${on}. Create a new one in Azure and update MAIL_CLIENT_SECRET.`
          : `The Microsoft app secret expires on ${on} (${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}). Create a new one in Azure and update MAIL_CLIENT_SECRET before then, or mail stops syncing.`,
    };
  }
  return null;
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
    secretDaysLeft: secretDaysLeft(serverEnv.MAIL_CLIENT_SECRET_EXPIRES_AT),
  };
}
