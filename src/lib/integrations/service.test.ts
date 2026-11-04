import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const state = vi.hoisted(() => ({
  superAdmin: true,
  impersonating: false,
  probe: { ok: true, note: 'Twilio accepted these keys.' } as { ok: boolean; note: string },
  rpc: vi.fn(async () => ({ error: null as { code: string } | null })),
  values: { TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'current-token' } as Record<string, string>,
  fromCrm: new Set<string>(),
  forget: vi.fn(),
}));

vi.mock('@/lib/env.server', () => ({
  serverEnv: { NODE_ENV: 'test', LOGIN_ENC_KEY: 'x'.repeat(40) },
  integrationEnv: {},
  mailBaseConfigured: true,
  mailProvider: 'graph',
}));
vi.mock('@/lib/env', () => ({ env: { NEXT_PUBLIC_APP_URL: 'https://crm.example.com/' } }));
vi.mock('@/lib/auth/impersonation', () => ({ currentImpersonation: async () => (state.impersonating ? { adminEmail: 'a', targetEmail: 'b' } : null) }));
vi.mock('@/lib/email/send', () => ({ sendAlertTest: async () => ({ ok: true }), verifySmtpLogin: async () => true }));
vi.mock('@/lib/records/permissions', () => ({ permissionsFor: async () => ({ superAdmin: state.superAdmin }), canOpenAdminPage: async () => true }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc: state.rpc }) }));
vi.mock('./probe', () => ({ probeGroup: async () => state.probe, connectSignwellHook: async () => ({ ok: true, id: 'hook' }) }));
vi.mock('./resolve', () => ({
  integrationSnapshot: async () => ({ values: state.values, all: state.values, fromCrm: state.fromCrm, unreadable: [], off: new Set() }),
  forgetIntegrationValues: state.forget,
  phoneReadyFrom: () => true,
  mailReadyFrom: () => true,
  agreementsReadyFrom: () => true,
  maverickReadyFrom: () => true,
}));

const { IntegrationError, removeIntegrationSetting, saveIntegrationGroup, testIntegrationGroup, sendTestAlert, connectSignwell, setIntegrationEnabled } = await import('./service');
const { openSetting } = await import('./crypto');

const ctx = { userId: 'user-1' } as never;
const token = 'a-brand-new-token-1234';

const sent = () => (state.rpc.mock.calls[0] as unknown as [string, { p_set: { key: string; sealed: string; iv: string; hint: string }[]; p_remove: string[]; p_test_ok: boolean | null }])[1];

beforeEach(() => {
  state.superAdmin = true;
  state.impersonating = false;
  state.probe = { ok: true, note: 'Twilio accepted these keys.' };
  state.rpc.mockReset();
  state.rpc.mockImplementation(async () => ({ error: null }));
  state.forget.mockReset();
  state.fromCrm = new Set();
});

describe('who may change a key', () => {
  const attempts: [string, () => Promise<unknown>][] = [
    ['save', () => saveIntegrationGroup(ctx, 'twilio', { TWILIO_AUTH_TOKEN: token })],
    ['remove', () => removeIntegrationSetting(ctx, 'TWILIO_AUTH_TOKEN')],
    ['test', () => testIntegrationGroup(ctx, 'twilio')],
    ['connect', () => connectSignwell(ctx)],
    ['test alert', () => sendTestAlert(ctx)],
  ];

  it.each(attempts)('an ordinary admin cannot %s', async (_name, run) => {
    state.superAdmin = false;
    await expect(run()).rejects.toThrow('Only a super admin');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it.each(attempts)('nobody can %s while borrowing an account', async (_name, run) => {
    state.impersonating = true;
    await expect(run()).rejects.toThrow('Stop viewing');
    expect(state.rpc).not.toHaveBeenCalled();
  });
});

describe('saving', () => {
  it('a refused key is not saved, and the old one stays', async () => {
    state.probe = { ok: false, note: 'Twilio refused the Account SID and auth token.' };
    const r = await saveIntegrationGroup(ctx, 'twilio', { TWILIO_AUTH_TOKEN: token });
    expect(r.saved).toBe(false);
    expect(state.rpc).not.toHaveBeenCalled();
    expect(state.forget).not.toHaveBeenCalled();
  });

  it('what reaches the database is sealed, and the plain value is nowhere in the call', async () => {
    const r = await saveIntegrationGroup(ctx, 'twilio', { TWILIO_AUTH_TOKEN: token });
    expect(r.saved).toBe(true);
    expect(JSON.stringify(state.rpc.mock.calls)).not.toContain(token);
    const [row] = sent().p_set;
    expect(row!.hint).toBe('ending in 1234');
    expect(openSetting('TWILIO_AUTH_TOKEN', row!)).toBe(token);
  });

  it('a save takes effect here at once', async () => {
    await saveIntegrationGroup(ctx, 'twilio', { TWILIO_AUTH_TOKEN: token });
    expect(state.forget).toHaveBeenCalledOnce();
  });

  it('records the test with the change', async () => {
    await saveIntegrationGroup(ctx, 'twilio', { TWILIO_AUTH_TOKEN: token });
    expect(sent().p_test_ok).toBe(true);
  });

  it('a key from another service cannot be slipped into this one', async () => {
    await expect(saveIntegrationGroup(ctx, 'twilio', { SMTP_PASSWORD: 'x' })).rejects.toBeInstanceOf(IntegrationError);
    await expect(saveIntegrationGroup(ctx, 'twilio', { SUPABASE_SERVICE_ROLE_KEY: 'x' })).rejects.toBeInstanceOf(IntegrationError);
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('a value in the wrong shape never reaches the provider or the database', async () => {
    await expect(saveIntegrationGroup(ctx, 'twilio', { TWILIO_ACCOUNT_SID: 'nonsense' })).rejects.toThrow('starts with AC');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('saving what is already saved changes nothing', async () => {
    state.fromCrm = new Set(['TWILIO_AUTH_TOKEN']);
    await expect(saveIntegrationGroup(ctx, 'twilio', { TWILIO_AUTH_TOKEN: 'current-token' })).rejects.toThrow('Nothing has changed');
  });

  it('copying the environment’s value in here does save it', async () => {
    const r = await saveIntegrationGroup(ctx, 'twilio', { TWILIO_AUTH_TOKEN: 'current-token' });
    expect(r.saved).toBe(true);
  });

  it('a database failure says not saved, with no detail', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.rpc.mockImplementation(async () => ({ error: { code: '42501' } }));
    await expect(saveIntegrationGroup(ctx, 'twilio', { TWILIO_AUTH_TOKEN: token })).rejects.toThrow('not saved');
    expect(JSON.stringify(err.mock.calls)).not.toContain(token);
    err.mockRestore();
  });
});

describe('removing', () => {
  it('names the key to remove and tests nothing', async () => {
    await removeIntegrationSetting(ctx, 'TWILIO_AUTH_TOKEN');
    expect(sent().p_remove).toEqual(['TWILIO_AUTH_TOKEN']);
    expect(sent().p_set).toEqual([]);
    expect(sent().p_test_ok).toBeNull();
  });

  it('an unknown key is refused', async () => {
    await expect(removeIntegrationSetting(ctx, 'OTP_PEPPER')).rejects.toBeInstanceOf(IntegrationError);
  });
});

describe('connecting SignWell', () => {
  it('adds the id and keeps the ones already there', async () => {
    state.values = { SIGNWELL_API_KEY: 'k', SIGNWELL_WEBHOOK_ID: 'old-id' };
    await connectSignwell(ctx);
    const [row] = sent().p_set;
    expect(openSetting('SIGNWELL_WEBHOOK_ID', row!)).toBe('old-id,hook');
  });

  it('needs the API key first', async () => {
    state.values = {};
    await expect(connectSignwell(ctx)).rejects.toThrow('API key first');
  });
});

describe('switching a service on or off', () => {
  it('writes the switch through the one function, and forgets the cached values', async () => {
    await setIntegrationEnabled(ctx, 'twilio', false);
    expect(state.rpc).toHaveBeenCalledWith('integration_set_enabled', { p_actor: 'user-1', p_group: 'twilio', p_enabled: false });
    expect(state.forget).toHaveBeenCalledOnce();
  });

  it('alert email has no switch: sign-in codes depend on it', async () => {
    await expect(setIntegrationEnabled(ctx, 'alerts', false)).rejects.toThrow('sign-in codes');
    expect(state.rpc).not.toHaveBeenCalled();
  });

  it('only a super admin may switch', async () => {
    state.superAdmin = false;
    await expect(setIntegrationEnabled(ctx, 'signwell', false)).rejects.toBeInstanceOf(IntegrationError);
    expect(state.rpc).not.toHaveBeenCalled();
  });
});
