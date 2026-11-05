/**
 * "Waiting for admin approval": someone whose organization's Microsoft admin has to
 * approve the app before they can finish connecting. Microsoft says so at sign-in,
 * and it applies to Email as well as Calendar and Chat.
 */
import 'server-only';
import { mailApp, mailConfig } from '@/lib/mail/config';
import { FULL_SCOPE_PARAM } from '@/lib/mail/scopes';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function waitingForAdmin(userId: string): Promise<void> {
  const { error } = await supabaseAdmin().from('teams_pending_approvals').upsert({ user_id: userId, requested_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) console.error('[teams] could not note a pending approval', { code: error.code });
}

export async function clearWaitingForAdmin(userId: string): Promise<void> {
  const { error } = await supabaseAdmin().from('teams_pending_approvals').delete().eq('user_id', userId);
  if (error) console.error('[teams] could not clear a pending approval', { code: error.code });
}

export async function isWaitingForAdmin(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from('teams_pending_approvals').select('id').eq('user_id', userId).maybeSingle();
  return Boolean(data);
}

const GRAPH_RESOURCE = 'https://graph.microsoft.com/';
const OIDC = new Set(['openid', 'profile', 'email', 'offline_access']);

/**
 * The page where a Microsoft admin approves the app for their whole organization.
 * `organizations` lets Microsoft work out which one from the admin's own sign-in.
 */
export async function adminApprovalUrl(): Promise<string> {
  const cfg = mailConfig();
  const { creds } = await mailApp();
  const scope = FULL_SCOPE_PARAM.split(' ')
    .map((s) => (OIDC.has(s) ? s : `${GRAPH_RESOURCE}${s}`))
    .join(' ');
  const base = cfg.endpoints.authorize.replace(/\/oauth2\/v2\.0\/authorize$/, '');
  const q = new URLSearchParams({ client_id: creds.clientId, scope, redirect_uri: cfg.redirectUri });
  return `${base}/v2.0/adminconsent?${q.toString()}`;
}

/**
 * The message someone copies and sends to their Microsoft admin. It goes to other
 * companies, where the app is not registered, so App registrations cannot find it, and
 * Enterprise apps lists it only once someone has approved it. Microsoft's request route
 * comes first because the admin answers it in their own panel and nobody needs a link.
 * The link names only what a signed-in person's connection uses.
 */
export async function adminRequestText(): Promise<string> {
  const { creds } = await mailApp();
  return [
    'Hello,',
    '',
    'We use Tenor Payments CRM, and I need to connect my own Microsoft account to it for my email, calendar and Teams chats. Our organization requires a Microsoft admin to approve the app once, for everyone. You do not sign in to the CRM, and none of your own mail or accounts get connected.',
    '',
    `The app's Application ID is ${creds.clientId}.`,
    '',
    'Option 1, approve my request in the admin panel. A Global Administrator switches this on once:',
    '1. Go to https://entra.microsoft.com and open Entra ID, then Enterprise apps, then Consent and permissions, then Admin consent settings.',
    '2. Set "Users can request admin consent to apps they are unable to consent to" to Yes, choose who reviews requests, and save. Microsoft says this can take up to an hour.',
    '3. Tell me, and I will send the request from Microsoft\'s page. Reviewers get an email.',
    '4. Open Enterprise apps, then Admin consent requests, then My Pending. Select the app, click Review permissions and consent, and accept.',
    '',
    "Option 2, approve now on Microsoft's approval page, which lists the permissions the CRM asks for:",
    await adminApprovalUrl(),
    'Sign in there with your admin account, review the permissions, click Accept and close the page.',
    '',
    'Please let me know when it is done, and I will connect my own account. Thank you.',
  ].join('\n');
}
