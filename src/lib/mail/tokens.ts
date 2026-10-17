/**
 * Access tokens for a Microsoft sign-in (`mail_identities`), minted from the
 * stored refresh token and shared by every server instance.
 *
 * ── WHERE A TOKEN COMES FROM, CHEAPEST FIRST ─────────────────────────────
 *   1. This instance's memory, while it has more than two minutes left.
 *   2. The encrypted access token in `mail_identity_secrets` — so a cold
 *      Vercel instance does not refresh a token another one just minted.
 *   3. Microsoft's token endpoint, with the refresh token. The new pair is
 *      written back with a compare-and-set on `updated_at`: if another
 *      instance refreshed first, its row stands and this one simply uses its
 *      own (equally valid) access token. Microsoft keeps an older refresh
 *      token valid after rotation, so losing the race costs nothing.
 *
 * ── WHEN MICROSOFT SAYS NO ───────────────────────────────────────────────
 * A refresh token Microsoft refuses for good (`invalid_grant`, revoked
 * consent, password reset, MFA policy) breaks the identity in ONE database
 * call — `mail_mark_identity_broken` marks its connections, deletes the dead
 * secret and hands every mailbox it was pulling to another connector. Our
 * own client secret being rejected is NOT the person's fault: it marks the
 * provider `config_error` and breaks nobody.
 *
 * Every failure surfaces as a `GraphError`, the same type the transport
 * throws, so callers handle exactly one error shape.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { mailConfig, tokenAad } from './config';
import { seal, open, toBytea, fromBytea } from './crypto';
import { refreshTokens, OAuthError, type TokenSet } from './oauthClient';
import { createGraphTransport, GraphError, type GraphTransport } from './graph/transport';
import { mailLog } from './log';

/** Refresh this long before Microsoft's expiry, so no call races it. */
const EARLY_MS = 2 * 60 * 1000;
/**
 * How long this instance trusts its memory before re-reading the row. Short,
 * so a disconnect or a broken sign-in stops being used within minutes even
 * though Microsoft's token itself would still work for up to an hour.
 */
const MEMORY_MS = 5 * 60 * 1000;

const memory = new Map<string, { token: string; expiresAt: number; checkAt: number }>();

function remember(identityId: string, token: string, expiresAt: number): void {
  memory.set(identityId, { token, expiresAt, checkAt: Date.now() + MEMORY_MS });
}
const inflight = new Map<string, Promise<string>>();

function reconnectRequired(detail: string): GraphError {
  return new GraphError(401, { code: 'reconnect_required', reaction: 'none', connection: 'broken', detail }, null);
}

type SecretRow = {
  refresh_token_enc: unknown;
  refresh_token_iv: unknown;
  access_token_enc: unknown;
  access_token_iv: unknown;
  access_token_expires_at: string | null;
  updated_at: string;
};

/** Seals and stores the token pair from the connect flow (no race to lose there). */
export async function storeTokenSet(
  identityId: string,
  owner: { userId: string; microsoftUserId: string },
  set: TokenSet,
): Promise<void> {
  const { tokenKey } = mailConfig();
  const aad = tokenAad(owner.userId, owner.microsoftUserId);
  const acc = seal(set.accessToken, tokenKey, aad);
  const { error } = await supabaseAdmin()
    .from('mail_identity_secrets')
    .update({
      access_token_enc: toBytea(acc.ciphertext),
      access_token_iv: toBytea(acc.iv),
      access_token_expires_at: new Date(set.expiresAt).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('identity_id', identityId);
  if (error) throw new Error(`Could not store the access token: ${error.code ?? 'db'}`);
  remember(identityId, set.accessToken, set.expiresAt);
}

export function forgetToken(identityId: string): void {
  memory.delete(identityId);
}

/** A current access token for one sign-in. */
export function accessTokenFor(identityId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  if (!opts.forceRefresh) {
    const hit = memory.get(identityId);
    const now = Date.now();
    if (hit && now < hit.checkAt && hit.expiresAt - now > EARLY_MS) return Promise.resolve(hit.token);
  }
  const running = inflight.get(identityId);
  if (running) return running;
  const p = mint(identityId, Boolean(opts.forceRefresh)).finally(() => inflight.delete(identityId));
  inflight.set(identityId, p);
  return p;
}

async function mint(identityId: string, forceRefresh: boolean): Promise<string> {
  const admin = supabaseAdmin();
  const cfg = mailConfig();

  const { data: ident, error: identErr } = await admin
    .from('mail_identities')
    .select('id, user_id, microsoft_user_id, status, deleted_at')
    .eq('id', identityId)
    .maybeSingle();
  if (identErr) throw new GraphError(0, { code: 'provider_down', reaction: 'reschedule', detail: 'db' }, null);
  if (!ident || ident.deleted_at || ident.status === 'broken' || ident.status === 'disconnected') {
    memory.delete(identityId);
    throw reconnectRequired('identity_unusable');
  }

  const { data: sec, error: secErr } = await admin
    .from('mail_identity_secrets')
    .select('refresh_token_enc, refresh_token_iv, access_token_enc, access_token_iv, access_token_expires_at, updated_at')
    .eq('identity_id', identityId)
    .maybeSingle<SecretRow>();
  if (secErr) throw new GraphError(0, { code: 'provider_down', reaction: 'reschedule', detail: 'db' }, null);
  if (!sec) throw reconnectRequired('no_secret');

  const aad = tokenAad(ident.user_id as string, ident.microsoft_user_id as string);
  const now = Date.now();

  // 2. Another instance's still-fresh token.
  if (!forceRefresh && sec.access_token_enc && sec.access_token_iv && sec.access_token_expires_at) {
    const expiresAt = Date.parse(sec.access_token_expires_at);
    if (expiresAt - now > EARLY_MS) {
      try {
        const token = open({ ciphertext: fromBytea(sec.access_token_enc), iv: fromBytea(sec.access_token_iv) }, cfg.tokenKey, aad);
        remember(identityId, token, expiresAt);
        return token;
      } catch {
        // Unreadable cached token: fall through and mint a new one.
      }
    }
  }

  // 3. Refresh with Microsoft.
  let refreshToken: string;
  try {
    refreshToken = open({ ciphertext: fromBytea(sec.refresh_token_enc), iv: fromBytea(sec.refresh_token_iv) }, cfg.tokenKey, aad);
  } catch {
    // Wrong key or tampered row: no amount of retrying fixes it.
    await admin.rpc('mail_mark_identity_broken', { p_identity_id: identityId, p_code: 'reconnect_required', p_detail: 'token_unreadable' });
    mailLog('error', 'tokens', 'refresh_token_unreadable', { identityId });
    throw reconnectRequired('token_unreadable');
  }

  let set: TokenSet;
  try {
    set = await refreshTokens(cfg.endpoints, cfg.creds, refreshToken);
  } catch (e) {
    if (!(e instanceof OAuthError)) throw e;
    const c = e.classified;
    if (c.code === 'app_secret_invalid') {
      await admin
        .from('mail_provider_health')
        .update({ state: 'config_error', last_error_code: 'app_secret_invalid', updated_at: new Date().toISOString() })
        .eq('id', 1);
    } else if (c.connection === 'broken') {
      memory.delete(identityId);
      await admin.rpc('mail_mark_identity_broken', {
        p_identity_id: identityId,
        p_code: c.code,
        p_detail: (c.detail ?? '').slice(0, 500),
      });
    }
    mailLog('warn', 'tokens', 'refresh_failed', { identityId, status: e.status, code: c.code, detail: c.detail });
    throw new GraphError(e.status, c, e.oauthCode);
  }

  const acc = seal(set.accessToken, cfg.tokenKey, aad);
  const patch: Record<string, unknown> = {
    access_token_enc: toBytea(acc.ciphertext),
    access_token_iv: toBytea(acc.iv),
    access_token_expires_at: new Date(set.expiresAt).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (set.refreshToken) {
    const rt = seal(set.refreshToken, cfg.tokenKey, aad);
    patch.refresh_token_enc = toBytea(rt.ciphertext);
    patch.refresh_token_iv = toBytea(rt.iv);
  }
  const { error: casErr } = await admin
    .from('mail_identity_secrets')
    .update(patch)
    .eq('identity_id', identityId)
    .eq('updated_at', sec.updated_at);
  if (casErr) mailLog('warn', 'tokens', 'store_failed', { identityId, code: casErr.code });

  await admin
    .from('mail_identities')
    .update({ last_token_ok_at: new Date().toISOString(), consecutive_auth_failures: 0 })
    .eq('id', identityId);

  remember(identityId, set.accessToken, set.expiresAt);
  return set.accessToken;
}

/** Graph, acting as one stored sign-in. */
export function graphForIdentity(identityId: string): GraphTransport {
  return createGraphTransport({
    baseUrl: mailConfig().endpoints.graph,
    token: ({ forceRefresh }) => accessTokenFor(identityId, { forceRefresh }),
  });
}

/**
 * Graph with a token we hold in hand — the connect flow, before any identity
 * row exists. A 401 retries with the same token and then fails; there is
 * nothing to refresh yet.
 */
export function graphWithToken(accessToken: string): GraphTransport {
  return createGraphTransport({ baseUrl: mailConfig().endpoints.graph, token: async () => accessToken });
}
