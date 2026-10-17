/**
 * Microsoft identity platform v2: the authorize URL and the two token calls
 * (code → tokens, refresh → tokens). Plain `fetch`, no MSAL — the old CRM's
 * MSAL cache was the source of its "signed out for no reason" bugs, and the
 * flow is three HTTP requests.
 *
 * Confidential web client: every token request carries the client secret AND
 * the PKCE verifier. Pure apart from `fetchImpl`, so it is unit-tested.
 */
import { MAIL_SCOPE_PARAM, grantedScopes } from './scopes';
import { classifyGraphError, type Classified } from './errors';
import type { MailEndpoints } from './graph/endpoints';

export type ClientCredentials = { clientId: string; clientSecret: string };

export type TokenSet = {
  accessToken: string;
  /** Microsoft rotates it on most refreshes; null when it did not send one. */
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
  idToken: string | null;
};

export class OAuthError extends Error {
  constructor(
    public readonly status: number,
    public readonly classified: Classified,
    /** Microsoft's `error` field, e.g. `invalid_grant`. Never shown raw. */
    public readonly oauthCode: string | null,
  ) {
    super(`Microsoft token request failed (${status} ${oauthCode ?? classified.code})`);
    this.name = 'OAuthError';
  }
}

const TOKEN_TIMEOUT_MS = 15_000;

export function authorizeUrl(
  ep: MailEndpoints,
  args: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint?: string },
): string {
  const q = new URLSearchParams({
    client_id: args.clientId,
    response_type: 'code',
    redirect_uri: args.redirectUri,
    response_mode: 'query',
    scope: MAIL_SCOPE_PARAM,
    state: args.state,
    code_challenge: args.challenge,
    code_challenge_method: 'S256',
    // Always let the person pick: the browser may already be signed in to a
    // different Microsoft account than the mailbox they mean to connect.
    prompt: 'select_account',
  });
  if (args.loginHint) q.set('login_hint', args.loginHint);
  return `${ep.authorize}?${q.toString()}`;
}

async function tokenRequest(
  ep: MailEndpoints,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
  now: number,
): Promise<TokenSet> {
  let res: Response;
  try {
    res = await fetchImpl(ep.token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch {
    throw new OAuthError(0, classifyGraphError({ status: 0 }), null);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON (an HTML error page from a proxy): the status decides.
  }

  if (!res.ok) {
    const code = typeof body.error === 'string' ? body.error : null;
    const message = typeof body.error_description === 'string' ? body.error_description : null;
    throw new OAuthError(
      res.status,
      classifyGraphError({ status: res.status, code, message, retryAfter: res.headers.get('retry-after') }),
      code,
    );
  }

  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  if (!accessToken) {
    throw new OAuthError(res.status, { code: 'unknown', reaction: 'none', detail: 'no_access_token' }, null);
  }
  const expiresIn = Number(body.expires_in);
  return {
    accessToken,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token ? body.refresh_token : null,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    scopes: grantedScopes(typeof body.scope === 'string' ? body.scope : ''),
    idToken: typeof body.id_token === 'string' ? body.id_token : null,
  };
}

export function exchangeCode(
  ep: MailEndpoints,
  creds: ClientCredentials,
  args: { code: string; verifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(
    ep,
    {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'authorization_code',
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.verifier,
      scope: MAIL_SCOPE_PARAM,
    },
    fetchImpl,
    now,
  );
}

export function refreshTokens(
  ep: MailEndpoints,
  creds: ClientCredentials,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
): Promise<TokenSet> {
  return tokenRequest(
    ep,
    {
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: MAIL_SCOPE_PARAM,
    },
    fetchImpl,
    now,
  );
}

export type IdClaims = {
  /** Object id of the Microsoft user — stable across renames. */
  oid: string;
  tid: string;
  preferredUsername: string | null;
  name: string | null;
};

/**
 * Reads the id_token's claims WITHOUT verifying its signature. Safe here and
 * only here: the token came straight back from Microsoft's token endpoint,
 * over TLS, in answer to a request authenticated with our client secret —
 * OpenID Connect Core §3.1.3.7 allows TLS validation in place of signature
 * checking for exactly this case. Never use it on a token a browser handed us.
 */
export function readIdClaims(idToken: string | null): IdClaims | null {
  if (!idToken) return null;
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const c = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof c.oid !== 'string' || typeof c.tid !== 'string') return null;
    return {
      oid: c.oid,
      tid: c.tid,
      preferredUsername: typeof c.preferred_username === 'string' ? c.preferred_username : null,
      name: typeof c.name === 'string' ? c.name : null,
    };
  } catch {
    return null;
  }
}
