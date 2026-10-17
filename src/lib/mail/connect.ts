/**
 * Finishing a mailbox connection, after the OAuth callback has proved the
 * state cookie is genuine and belongs to the signed-in CRM user.
 *
 * Order matters, and every check that can refuse runs BEFORE anything is
 * written:
 *
 *   1. Exchange the code (with the PKCE verifier).
 *   2. Work/school account only; tenant on the allow-list when one is set.
 *   3. Who signed in (`/me`) — must match the id token.
 *   4. Prove the mailbox: its Inbox must answer. For a shared mailbox this IS
 *      the access check — Exchange delegation is the authority, not us.
 *   5. One RPC writes identity + encrypted refresh token + mailbox (reused
 *      when another person already connected the same address) + connection.
 *      The 30-mailbox cap is a trigger inside it.
 *   6. Folder tree and the first round of sync work. A failure here does not
 *      undo the connection — the engine retries `folders_refresh`.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { mailConfig, tokenAad } from './config';
import { seal, toBytea } from './crypto';
import { exchangeCode, readIdClaims, OAuthError, type TokenSet } from './oauthClient';
import { missingScopes } from './scopes';
import { CONSUMER_TENANT_ID } from './graph/endpoints';
import { GraphError, mailboxRoot, type GraphTransport } from './graph/transport';
import { graphWithToken, storeTokenSet } from './tokens';
import { refreshFolderTree } from './sync/folders';
import { mailLog } from './log';
import type { ConnectKind } from './oauthState';

export type ConnectFailure =
  | 'cancelled'
  | 'state_invalid'
  | 'consent_required'
  | 'personal_account'
  | 'wrong_tenant'
  | 'no_mailbox'
  | 'shared_access_denied'
  | 'limit_reached'
  | 'provider_down'
  | 'app_secret_invalid'
  | 'failed';

export type ConnectResult =
  | { ok: true; mailboxId: string; address: string; created: boolean; reconnected: boolean; degraded: boolean }
  | { ok: false; reason: ConnectFailure };

type Me = { id?: string; displayName?: string | null; mail?: string | null; userPrincipalName?: string | null };

function fromOAuth(e: OAuthError): ConnectFailure {
  switch (e.classified.code) {
    case 'consent_required':
      return 'consent_required';
    case 'app_secret_invalid':
      return 'app_secret_invalid';
    case 'provider_down':
    case 'throttled':
      return 'provider_down';
    case 'reconnect_required':
      // invalid_grant on a fresh code = the code was used, expired or tampered.
      return 'state_invalid';
    default:
      return 'failed';
  }
}

/** Does this mailbox answer for this token? */
async function proveMailbox(graph: GraphTransport, root: string): Promise<'ok' | 'denied' | 'missing' | 'down'> {
  try {
    await graph.request({ path: `${root}/mailFolders/inbox`, query: { $select: 'id' } });
    return 'ok';
  } catch (e) {
    if (!(e instanceof GraphError)) throw e;
    const c = e.classified.code;
    if (c === 'mailbox_access_removed' || c === 'scope_missing' || c === 'token_expired') return 'denied';
    if (c === 'mailbox_not_found' || c === 'not_found') return 'missing';
    if (c === 'provider_down' || c === 'throttled') return 'down';
    return 'denied';
  }
}

export async function completeConnect(args: {
  userId: string;
  kind: ConnectKind;
  /** The shared mailbox address, from the signed state. */
  target?: string;
  code: string;
  verifier: string;
}): Promise<ConnectResult> {
  const cfg = mailConfig();

  // 1. Code → tokens.
  let set: TokenSet;
  try {
    set = await exchangeCode(cfg.endpoints, cfg.creds, { code: args.code, verifier: args.verifier, redirectUri: cfg.redirectUri });
  } catch (e) {
    if (e instanceof OAuthError) {
      mailLog('warn', 'connect', 'code_exchange_failed', { status: e.status, code: e.classified.code, detail: e.classified.detail });
      return { ok: false, reason: fromOAuth(e) };
    }
    throw e;
  }
  if (!set.refreshToken) {
    // Without offline_access we could never sync in the background.
    mailLog('warn', 'connect', 'no_refresh_token', {});
    return { ok: false, reason: 'consent_required' };
  }

  // 2. Whose account, which tenant.
  const claims = readIdClaims(set.idToken);
  if (!claims) return { ok: false, reason: 'failed' };
  const tenant = claims.tid.toLowerCase();
  if (tenant === CONSUMER_TENANT_ID) return { ok: false, reason: 'personal_account' };
  if (cfg.allowedTenants.size > 0 && !cfg.allowedTenants.has(tenant)) {
    mailLog('warn', 'connect', 'tenant_refused', { tenant });
    return { ok: false, reason: 'wrong_tenant' };
  }

  // 3. Who signed in.
  const graph = graphWithToken(set.accessToken);
  let me: Me;
  try {
    me = (await graph.request<Me>({ path: '/me', query: { $select: 'id,displayName,mail,userPrincipalName' } })) ?? {};
  } catch (e) {
    if (e instanceof GraphError) {
      mailLog('warn', 'connect', 'me_failed', { status: e.status, code: e.classified.code });
      return { ok: false, reason: e.classified.code === 'provider_down' || e.classified.code === 'throttled' ? 'provider_down' : 'failed' };
    }
    throw e;
  }
  if (!me.id || me.id !== claims.oid) return { ok: false, reason: 'failed' };
  const ownAddress = (me.mail || me.userPrincipalName || claims.preferredUsername || '').trim().toLowerCase();
  if (!ownAddress) return { ok: false, reason: 'no_mailbox' };

  // 4. Which mailbox, and prove it answers. Naming your own address as
  //    "shared" is just connecting your own mailbox.
  const target = args.kind === 'shared' ? (args.target ?? '').trim().toLowerCase() : '';
  const kind: ConnectKind = args.kind === 'shared' && target && target !== ownAddress ? 'shared' : 'personal';
  const address = kind === 'shared' ? target : ownAddress;
  const root = kind === 'shared' ? mailboxRoot(address) : mailboxRoot(me.id);

  const proof = await proveMailbox(graph, root);
  if (proof === 'down') return { ok: false, reason: 'provider_down' };
  if (proof !== 'ok') {
    mailLog('info', 'connect', 'mailbox_refused', { kind, proof });
    return { ok: false, reason: kind === 'shared' ? 'shared_access_denied' : 'no_mailbox' };
  }

  // 5. One transaction for identity, secret, mailbox and connection.
  const missing = missingScopes(set.scopes);
  const sealed = seal(set.refreshToken, cfg.tokenKey, tokenAad(args.userId, me.id));
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('mail_connect_mailbox', {
    p_user_id: args.userId,
    p_microsoft_user_id: me.id,
    p_tenant_id: tenant,
    p_primary_email: ownAddress,
    p_identity_display: (me.displayName ?? claims.name ?? '').slice(0, 200),
    p_scopes: set.scopes,
    p_missing_scopes: missing,
    p_refresh_enc: toBytea(sealed.ciphertext),
    p_refresh_iv: toBytea(sealed.iv),
    p_kind: kind,
    p_address: address,
    // A shared mailbox's display name is not readable with these scopes;
    // the address stands in until a synced message names it.
    p_mailbox_display: kind === 'personal' ? (me.displayName ?? '').slice(0, 200) : '',
    p_graph_user_id: kind === 'personal' ? me.id : null,
  });
  if (error) {
    if (error.code === 'P0001' && /mail_limit_reached/.test(error.message ?? '')) return { ok: false, reason: 'limit_reached' };
    mailLog('error', 'connect', 'connect_rpc_failed', { code: error.code });
    return { ok: false, reason: 'failed' };
  }
  const r = data as {
    identity_id: string;
    mailbox_id: string;
    mailbox_created: boolean;
    reconnected: boolean;
    status: 'ok' | 'degraded';
  };

  // The access token we already hold saves the engine a refresh.
  try {
    await storeTokenSet(r.identity_id, { userId: args.userId, microsoftUserId: me.id }, set);
  } catch (e) {
    mailLog('warn', 'connect', 'access_token_store_failed', { message: e instanceof Error ? e.message : 'unknown' });
  }

  // 6. Folders + first work. Best effort; the engine retries.
  try {
    await refreshFolderTree(r.mailbox_id, graph);
    const { error: bootErr } = await admin.rpc('mail_enqueue_bootstrap', { p_mailbox_id: r.mailbox_id });
    if (bootErr) throw new Error(`bootstrap ${bootErr.code ?? 'db'}`);
  } catch (e) {
    mailLog('warn', 'connect', 'bootstrap_deferred', {
      mailboxId: r.mailbox_id,
      code: e instanceof GraphError ? e.classified.code : 'internal',
    });
    await admin.rpc('mail_enqueue', { p_mailbox_id: r.mailbox_id, p_kind: 'folders_refresh', p_target: '', p_priority: 1 });
  }

  mailLog('info', 'connect', 'connected', {
    mailboxId: r.mailbox_id,
    kind,
    created: r.mailbox_created,
    reconnected: r.reconnected,
    degraded: r.status === 'degraded',
  });
  return {
    ok: true,
    mailboxId: r.mailbox_id,
    address,
    created: r.mailbox_created,
    reconnected: r.reconnected,
    degraded: r.status === 'degraded',
  };
}
