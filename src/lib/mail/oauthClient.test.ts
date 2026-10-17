import { describe, it, expect } from 'vitest';
import { authorizeUrl, exchangeCode, refreshTokens, readIdClaims, OAuthError } from './oauthClient';
import { endpointsFor } from './graph/endpoints';
import { grantedScopes, missingScopes, GRAPH_SCOPES, MAIL_SCOPE_PARAM } from './scopes';

/** The error a promise rejects with; fails the test if it resolves instead. */
async function rejection<E>(p: Promise<unknown>): Promise<E> {
  return p.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e: E) => e,
  );
}

const ep = endpointsFor('graph');
const creds = { clientId: 'cid', clientSecret: 'sec' };

function jsonFetch(status: number, body: unknown, capture?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (capture) {
      capture.url = url;
      capture.init = init;
    }
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
}

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

describe('scopes', () => {
  it('normalises Graph-prefixed scope strings and diffs what is missing', () => {
    const g = grantedScopes('https://graph.microsoft.com/Mail.ReadWrite  User.Read openid');
    expect(g).toEqual(['Mail.ReadWrite', 'User.Read', 'openid']);
    expect(missingScopes(GRAPH_SCOPES.map((s) => s.toLowerCase()))).toEqual([]);
    expect(missingScopes(['User.Read', 'Mail.ReadWrite'])).toContain('Mail.Send');
    expect(grantedScopes(null)).toEqual([]);
  });

  it('asks for offline_access (no background sync without a refresh token)', () => {
    expect(MAIL_SCOPE_PARAM.split(' ')).toContain('offline_access');
  });
});

describe('authorizeUrl', () => {
  it('carries PKCE S256, the nonce as state, organizations authority and select_account', () => {
    const u = new URL(authorizeUrl(ep, { clientId: 'cid', redirectUri: 'https://x/cb', state: 'n1', challenge: 'ch' }));
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    expect(u.searchParams.get('code_challenge')).toBe('ch');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe('n1');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('prompt')).toBe('select_account');
    expect(u.searchParams.get('scope')).toBe(MAIL_SCOPE_PARAM);
    // The verifier itself never appears in the URL.
    expect(u.toString()).not.toContain('verifier');
  });
});

describe('token requests', () => {
  it('exchanges a code with the verifier and secret, form-encoded', async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const set = await exchangeCode(
      ep,
      creds,
      { code: 'c', verifier: 'v', redirectUri: 'https://x/cb' },
      jsonFetch(200, { access_token: 'at', refresh_token: 'rt', expires_in: 3599, scope: 'Mail.Send User.Read', id_token: 'i' }, cap),
      1_000,
    );
    const form = new URLSearchParams(String(cap.init?.body));
    expect(cap.url).toBe(ep.token);
    expect(form.get('code_verifier')).toBe('v');
    expect(form.get('client_secret')).toBe('sec');
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(set).toMatchObject({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1_000 + 3_599_000, idToken: 'i' });
    expect(set.scopes).toEqual(['Mail.Send', 'User.Read']);
  });

  it('classifies a dead refresh token as reconnect_required', async () => {
    const err = await rejection<OAuthError>(refreshTokens(ep, creds, 'rt', jsonFetch(400, { error: 'invalid_grant', error_description: 'AADSTS70008: expired' })));
    expect(err).toBeInstanceOf(OAuthError);
    expect(err.classified.code).toBe('reconnect_required');
    expect(err.classified.connection).toBe('broken');
    expect(err.oauthCode).toBe('invalid_grant');
  });

  it('classifies our own expired client secret as app_secret_invalid, breaking nobody', async () => {
    const err = await rejection<OAuthError>(refreshTokens(ep, creds, 'rt', jsonFetch(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' })));
    expect(err.classified.code).toBe('app_secret_invalid');
    expect(err.classified.connection).toBeUndefined();
  });

  it('turns a network failure into provider_down', async () => {
    const boom = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const err = await rejection<OAuthError>(refreshTokens(ep, creds, 'rt', boom));
    expect(err.status).toBe(0);
    expect(err.classified.code).toBe('provider_down');
  });

  it('refuses a 200 without an access token', async () => {
    const err = await rejection<OAuthError>(refreshTokens(ep, creds, 'rt', jsonFetch(200, { token_type: 'Bearer' })));
    expect(err).toBeInstanceOf(OAuthError);
  });

  it('keeps refreshToken null when Microsoft did not rotate it', async () => {
    const set = await refreshTokens(ep, creds, 'rt', jsonFetch(200, { access_token: 'a2', expires_in: 60 }));
    expect(set.refreshToken).toBeNull();
  });
});

describe('readIdClaims', () => {
  it('reads oid/tid and refuses tokens without them', () => {
    expect(readIdClaims(jwt({ oid: 'o', tid: 't', preferred_username: 'a@b.com', name: 'A' }))).toEqual({
      oid: 'o',
      tid: 't',
      preferredUsername: 'a@b.com',
      name: 'A',
    });
    expect(readIdClaims(jwt({ tid: 't' }))).toBeNull();
    expect(readIdClaims('garbage')).toBeNull();
    expect(readIdClaims(null)).toBeNull();
  });
});

describe('endpointsFor', () => {
  it('serves the mock under one base and refuses mock without a URL', () => {
    expect(endpointsFor('mock', 'http://127.0.0.1:4555/')).toEqual({
      authorize: 'http://127.0.0.1:4555/oauth2/v2.0/authorize',
      token: 'http://127.0.0.1:4555/oauth2/v2.0/token',
      graph: 'http://127.0.0.1:4555/v1.0',
    });
    expect(() => endpointsFor('mock')).toThrow();
  });
});
