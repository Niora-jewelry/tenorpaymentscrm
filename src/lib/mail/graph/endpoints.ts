/**
 * Where the module talks to Microsoft — or, in tests and local runs, to the
 * mock Graph server (`scripts/mail-mock-graph.mjs`), which serves the same
 * paths under one base URL. Production refuses the mock in `env.server.ts`.
 *
 * Authority `organizations`: work and school accounts only. A personal
 * Microsoft account (outlook.com) is turned away by Microsoft at sign-in,
 * and the callback double-checks the tenant.
 */
export type MailEndpoints = {
  authorize: string;
  token: string;
  /** Graph root including the version, no trailing slash. */
  graph: string;
};

const LOGIN = 'https://login.microsoftonline.com/organizations/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

export function endpointsFor(provider: 'graph' | 'mock', mockBaseUrl?: string): MailEndpoints {
  if (provider === 'mock') {
    if (!mockBaseUrl) throw new Error('MAIL_MOCK_BASE_URL is required when MAIL_PROVIDER=mock.');
    const base = mockBaseUrl.replace(/\/+$/, '');
    return {
      authorize: `${base}/oauth2/v2.0/authorize`,
      token: `${base}/oauth2/v2.0/token`,
      graph: `${base}/v1.0`,
    };
  }
  return { authorize: `${LOGIN}/authorize`, token: `${LOGIN}/token`, graph: GRAPH };
}

/** The tenant id Microsoft gives every personal (MSA) account. Never connectable. */
export const CONSUMER_TENANT_ID = '9188040d-6c67-4c5b-b112-36a304b66dad';
