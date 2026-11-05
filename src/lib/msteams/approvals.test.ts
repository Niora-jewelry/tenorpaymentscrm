import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env.server', () => ({ serverEnv: {} }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/mail/config', () => ({
  mailApp: async () => ({ creds: { clientId: 'app-id-1' } }),
  mailConfig: () => ({ endpoints: { authorize: 'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize' }, redirectUri: 'https://crm.example/api/mail/oauth/callback' }),
}));

const { adminApprovalUrl, adminRequestText } = await import('./approvals');

describe('the request for a Microsoft admin', () => {
  it('sends another company to where it can act, not to App registrations', async () => {
    const text = await adminRequestText();
    expect(text).toContain('Admin consent settings');
    expect(text).toContain('Admin consent requests');
    expect(text).toContain('app-id-1');
    expect(text).not.toContain('App registrations');
    expect(text).not.toContain('Grant admin consent');
  });

  it('the link names what a connection uses, and never asks for everything the app lists', async () => {
    const url = new URL(await adminApprovalUrl());
    expect(url.pathname).toBe('/organizations/v2.0/adminconsent');
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('https://graph.microsoft.com/Mail.ReadWrite');
    expect(scope).not.toContain('.default');
    expect(scope).not.toContain('Mail.Send.All');
  });
});
