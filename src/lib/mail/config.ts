/**
 * The Email module's resolved server configuration, read once from
 * `env.server.ts`. Everything that needs a Microsoft URL, our client
 * credentials or the token key asks here, so "is the module configured?"
 * has one answer (`mailConfigured`) and a half-configured deploy fails with
 * a clear error instead of a confusing Microsoft one.
 */
import 'server-only';
import { serverEnv, mailConfigured, mailProvider } from '@/lib/env.server';
import { env } from '@/lib/env';
import { endpointsFor, type MailEndpoints } from './graph/endpoints';
import { parseKey } from './crypto';
import type { ClientCredentials } from './oauthClient';

export class MailNotConfiguredError extends Error {
  constructor() {
    super('The Email module is not configured.');
    this.name = 'MailNotConfiguredError';
  }
}

export type MailConfig = {
  endpoints: MailEndpoints;
  creds: ClientCredentials;
  redirectUri: string;
  stateSecret: string;
  tokenKey: Buffer;
  /** Empty = any work/school tenant that has consented. */
  allowedTenants: ReadonlySet<string>;
  /** Change notifications on? Off → the engine polls hot folders every minute. */
  webhooksEnabled: boolean;
  /** Origin Microsoft posts notifications to, no trailing slash. */
  webhookBase: string;
};

let cached: MailConfig | null = null;

export function mailConfig(): MailConfig {
  if (!mailConfigured) throw new MailNotConfiguredError();
  if (cached) return cached;
  cached = {
    endpoints: endpointsFor(mailProvider, serverEnv.MAIL_MOCK_BASE_URL),
    creds: {
      // The mock server accepts any client; real Microsoft needs both.
      clientId: serverEnv.MAIL_CLIENT_ID ?? 'mock-client',
      clientSecret: serverEnv.MAIL_CLIENT_SECRET ?? 'mock-secret',
    },
    redirectUri:
      serverEnv.MAIL_REDIRECT_URI ?? `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/api/mail/oauth/callback`,
    stateSecret: serverEnv.MAIL_STATE_SIGNING_SECRET!,
    tokenKey: parseKey(serverEnv.MAIL_TOKEN_ENC_KEY!),
    allowedTenants: new Set(
      (serverEnv.MAIL_ALLOWED_TENANT_IDS ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
    webhooksEnabled: serverEnv.MAIL_WEBHOOKS_ENABLED === 'true',
    webhookBase: (serverEnv.MAIL_WEBHOOK_BASE_URL ?? env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, ''),
  };
  return cached;
}

/** The AAD every token for one Microsoft sign-in is sealed with. */
export function tokenAad(userId: string, microsoftUserId: string): string {
  return `${userId}:${microsoftUserId}`;
}
