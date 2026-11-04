/**
 * The Email module's resolved server configuration, read once from
 * `env.server.ts`. Everything that needs a Microsoft URL, our client
 * credentials or the token key asks here, so "is the module configured?"
 * has one answer (`mailReady`) and a half-configured deploy fails with
 * a clear error instead of a confusing Microsoft one.
 */
import 'server-only';
import { serverEnv, mailBaseConfigured, mailProvider } from '@/lib/env.server';
import { integrationValues, mailReadyFrom } from '@/lib/integrations/resolve';
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
  redirectUri: string;
  stateSecret: string;
  tokenKey: Buffer;
  /** Change notifications on? Off → the engine polls hot folders every minute. */
  webhooksEnabled: boolean;
  /** Origin Microsoft posts notifications to, no trailing slash. */
  webhookBase: string;
};

let cached: MailConfig | null = null;

export function mailConfig(): MailConfig {
  if (!mailBaseConfigured) throw new MailNotConfiguredError();
  if (cached) return cached;
  cached = {
    endpoints: endpointsFor(mailProvider, serverEnv.MAIL_MOCK_BASE_URL),
    redirectUri:
      serverEnv.MAIL_REDIRECT_URI ?? `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, '')}/api/mail/oauth/callback`,
    stateSecret: serverEnv.MAIL_STATE_SIGNING_SECRET!,
    tokenKey: parseKey(serverEnv.MAIL_TOKEN_ENC_KEY!),
    webhooksEnabled: serverEnv.MAIL_WEBHOOKS_ENABLED === 'true',
    webhookBase: (serverEnv.MAIL_WEBHOOK_BASE_URL ?? env.NEXT_PUBLIC_APP_URL).replace(/\/+$/, ''),
  };
  return cached;
}

export type MailApp = {
  creds: ClientCredentials;
  /** Empty = any work/school tenant that has consented. */
  allowedTenants: ReadonlySet<string>;
};

/** The Azure app, which can be replaced in CRM Settings, so read fresh each time. */
export async function mailApp(): Promise<MailApp> {
  const v = await integrationValues();
  if (!mailReadyFrom(v)) throw new MailNotConfiguredError();
  return {
    creds: {
      // The mock server accepts any client; real Microsoft needs both.
      clientId: v.MAIL_CLIENT_ID ?? 'mock-client',
      clientSecret: v.MAIL_CLIENT_SECRET ?? 'mock-secret',
    },
    allowedTenants: new Set(
      (v.MAIL_ALLOWED_TENANT_IDS ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean),
    ),
  };
}

/** The AAD every token for one Microsoft sign-in is sealed with. */
export function tokenAad(userId: string, microsoftUserId: string): string {
  return `${userId}:${microsoftUserId}`;
}
