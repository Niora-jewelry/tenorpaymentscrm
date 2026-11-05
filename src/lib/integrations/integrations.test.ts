import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/env.server', () => ({
  serverEnv: { NODE_ENV: 'test', LOGIN_ENC_KEY: 'x'.repeat(40) },
  integrationEnv: { TWILIO_AUTH_TOKEN: 'env-token', TWILIO_ACCOUNT_SID: 'env-sid', SMTP_PORT: 587, SMTP_HOST: '', EMAIL_FROM: 'A <a@b.co>' },
  mailBaseConfigured: true,
  mailProvider: 'graph',
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({}) }));

const { sealSetting, openSetting } = await import('./crypto');
const { cleanValue, hintFor, settingDef, SETTINGS, SETTING_KEYS, validFrom } = await import('./catalog');
const { agreementsReadyFrom, applySwitches, envValues, mailReadyFrom, merge, phoneReadyFrom, signwellTestModeFrom } = await import('./resolve');
const { connectSignwellHook, probeAlerts, probeMaverick, probeMicrosoft, probeSignwell, probeTwilio } = await import('./probe');

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
const fetchOf = (fn: (url: string, init?: RequestInit) => Response) => vi.fn(async (url: string | URL | Request, init?: RequestInit) => fn(String(url), init)) as unknown as typeof fetch;

describe('sealing a key', () => {
  it('opens to what went in, and the stored form does not contain it', () => {
    const s = sealSetting('TWILIO_AUTH_TOKEN', 'real-secret-value');
    expect(openSetting('TWILIO_AUTH_TOKEN', s)).toBe('real-secret-value');
    expect(Buffer.from(s.sealed, 'base64').toString('latin1')).not.toContain('real-secret-value');
  });

  it('seals the same value differently each time', () => {
    expect(sealSetting('K', 'v').sealed).not.toBe(sealSetting('K', 'v').sealed);
  });

  it('refuses to open under another setting’s name', () => {
    const s = sealSetting('SMTP_PASSWORD', 'v');
    expect(() => openSetting('TWILIO_AUTH_TOKEN', s)).toThrow();
  });

  it('refuses to open if it was changed', () => {
    const s = sealSetting('K', 'value');
    const bytes = Buffer.from(s.sealed, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    expect(() => openSetting('K', { ...s, sealed: bytes.toString('base64') })).toThrow();
  });
});

describe('which value wins', () => {
  const open = (_k: string, r: { sealed: string }) => r.sealed;

  it('with nothing saved, the environment applies', () => {
    const snap = merge([], envValues(), open);
    expect(snap.values.TWILIO_AUTH_TOKEN).toBe('env-token');
    expect(snap.fromCrm.size).toBe(0);
  });

  it('a saved value wins over the environment', () => {
    const snap = merge([{ key: 'TWILIO_AUTH_TOKEN', sealed: 'saved', iv: '' }], envValues(), open);
    expect(snap.values.TWILIO_AUTH_TOKEN).toBe('saved');
    expect(snap.values.TWILIO_ACCOUNT_SID).toBe('env-sid');
    expect(snap.fromCrm.has('TWILIO_AUTH_TOKEN')).toBe(true);
  });

  it('a value that will not open leaves the environment’s in place, and logs no value', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const snap = merge([{ key: 'TWILIO_AUTH_TOKEN', sealed: 'saved-secret', iv: '' }], envValues(), () => {
      throw new Error('bad');
    });
    expect(snap.values.TWILIO_AUTH_TOKEN).toBe('env-token');
    expect(snap.unreadable).toEqual(['TWILIO_AUTH_TOKEN']);
    expect(JSON.stringify(err.mock.calls)).not.toContain('saved-secret');
    err.mockRestore();
  });

  it('a row that is not a known setting is ignored', () => {
    const snap = merge([{ key: 'SUPABASE_SERVICE_ROLE_KEY', sealed: 'x', iv: '' }], {}, open);
    expect(snap.values).toEqual({});
  });

  it('an empty environment value counts as unset, and a number becomes text', () => {
    const v = envValues();
    expect(v.SMTP_HOST).toBeUndefined();
    expect(v.SMTP_PORT).toBe('587');
  });

  it('infrastructure secrets can never be entered here', () => {
    for (const k of ['SUPABASE_SERVICE_ROLE_KEY', 'OTP_PEPPER', 'LOGIN_ENC_KEY', 'MAIL_TOKEN_ENC_KEY', 'MAIL_STATE_SIGNING_SECRET', 'CRON_SECRET']) {
      expect(SETTING_KEYS).not.toContain(k);
    }
  });
});

describe('a service switched off', () => {
  const open = (_k: string, r: { sealed: string }) => r.sealed;
  const base = () =>
    merge(
      [
        { key: 'SIGNWELL_API_KEY', sealed: 'sw-key', iv: '' },
        { key: 'MAIL_CLIENT_ID', sealed: '11111111-2222-3333-4444-555555555555', iv: '' },
      ],
      envValues(),
      open,
    );

  it('drops out of what the CRM reads, but the screen still sees its keys', () => {
    const snap = applySwitches(base(), new Set(['twilio', 'signwell'] as const));
    expect(snap.values.TWILIO_AUTH_TOKEN).toBeUndefined();
    expect(snap.values.SIGNWELL_API_KEY).toBeUndefined();
    expect(snap.all.TWILIO_AUTH_TOKEN).toBe('env-token');
    expect(snap.all.SIGNWELL_API_KEY).toBe('sw-key');
    expect(snap.off.has('signwell')).toBe(true);
  });

  it('Microsoft keeps its keys: alert email may borrow its app for sign-in codes', () => {
    const snap = applySwitches(base(), new Set(['microsoft'] as const));
    expect(snap.values.MAIL_CLIENT_ID).toBe('11111111-2222-3333-4444-555555555555');
    expect(snap.off.has('microsoft')).toBe(true);
  });

  it('switching back on restores everything', () => {
    const snap = applySwitches(applySwitches(base(), new Set(['twilio'] as const)), new Set());
    expect(snap.values.TWILIO_AUTH_TOKEN).toBe('env-token');
  });
});

describe('nothing goes around the lookup', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
    });

  it('only env.server.ts reads a provider key from process.env', () => {
    // serverEnv's type already refuses these. process.env is the one way round it.
    const pattern = new RegExp(`process\\.env(\\.|\\[['"])(${SETTING_KEYS.join('|')})\\b`);
    const offenders = walk('src').filter((f) => !f.replace(/\\/g, '/').endsWith('lib/env.server.ts') && pattern.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the Edge proxy never reaches for these keys', () => {
    const proxy = readFileSync('src/proxy.ts', 'utf8');
    expect(proxy).not.toContain('integrations/');
    expect(proxy).not.toContain('env.server');
  });
});

describe('what counts as ready', () => {
  const twilio = { TWILIO_ACCOUNT_SID: 'a', TWILIO_AUTH_TOKEN: 'b', TWILIO_API_KEY_SID: 'c', TWILIO_API_KEY_SECRET: 'd', TWILIO_TWIML_APP_SID: 'e' };

  it('the phone needs all five', () => {
    expect(phoneReadyFrom(twilio)).toBe(true);
    for (const k of Object.keys(twilio)) expect(phoneReadyFrom({ ...twilio, [k]: undefined })).toBe(false);
  });

  it('signing needs both, email needs the app', () => {
    expect(agreementsReadyFrom({ SIGNWELL_API_KEY: 'a' })).toBe(false);
    expect(agreementsReadyFrom({ SIGNWELL_API_KEY: 'a', SIGNWELL_WEBHOOK_ID: 'b' })).toBe(true);
    expect(mailReadyFrom({ MAIL_CLIENT_ID: 'a' })).toBe(false);
    expect(mailReadyFrom({ MAIL_CLIENT_ID: 'a', MAIL_CLIENT_SECRET: 'b' })).toBe(true);
  });

  it('outside production signing is always test mode', () => {
    expect(signwellTestModeFrom({ SIGNWELL_TEST_MODE: 'false' })).toBe(true);
  });
});

describe('checking what was typed', () => {
  const twilioSid = settingDef('TWILIO_ACCOUNT_SID')!;

  it('trims what was pasted', () => {
    expect(cleanValue(twilioSid, `  AC${'a'.repeat(32)}\n`)).toEqual({ ok: true, value: `AC${'a'.repeat(32)}` });
  });

  it('refuses the wrong shape, empty and too long', () => {
    expect(cleanValue(twilioSid, 'SK123').ok).toBe(false);
    expect(cleanValue(twilioSid, '   ').ok).toBe(false);
    expect(cleanValue(settingDef('SMTP_PASSWORD')!, 'x'.repeat(2001)).ok).toBe(false);
  });

  it('a complaint about the shape never repeats the value', () => {
    const r = cleanValue(settingDef('TWILIO_AUTH_TOKEN')!, 'my secret token');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('my secret token');
  });

  it('reads a From line with or without a name', () => {
    expect(validFrom('Tenor Payments <No-Reply@tenorpayments.com>')).toBeNull();
    expect(validFrom('No-Reply@tenorpayments.com')).toBeNull();
    expect(validFrom('Tenor Payments')).not.toBeNull();
  });

  it('a secret shows its last four only, and a short one shows nothing', () => {
    const def = settingDef('SMTP_PASSWORD')!;
    expect(hintFor(def, 'abcdefghijklmnop1234')).toBe('ending in 1234');
    expect(hintFor(def, 'short')).toBe('saved');
    expect(hintFor(twilioSid, 'ACabc')).toBe('ACabc');
  });

  it('every secret is marked secret', () => {
    for (const s of SETTINGS) if (/(SECRET|TOKEN|PASSWORD|API_KEY)$/.test(s.key)) expect(s.kind).toBe('secret');
  });
});

describe('asking Twilio', () => {
  const sid = `AC${'a'.repeat(32)}`;
  const full = { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: 'tok', TWILIO_API_KEY_SID: `SK${'b'.repeat(32)}`, TWILIO_API_KEY_SECRET: 'sec', TWILIO_TWIML_APP_SID: `AP${'c'.repeat(32)}` };

  it('all accepted', async () => {
    const f = fetchOf(() => json(200, {}));
    expect(await probeTwilio(full, f)).toEqual({ ok: true, note: 'Twilio accepted these keys.' });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('only reads: every call is a GET', async () => {
    const f = fetchOf(() => json(200, {}));
    await probeTwilio(full, f);
    for (const call of vi.mocked(f).mock.calls) expect(call[1]?.method ?? 'GET').toBe('GET');
  });

  it('a wrong token, a wrong API key and a missing app are told apart', async () => {
    expect((await probeTwilio(full, fetchOf(() => json(401, {})))).note).toContain('Account SID and auth token');
    let n = 0;
    expect((await probeTwilio(full, fetchOf(() => json(++n === 2 ? 401 : 200, {})))).note).toContain('API key');
    expect((await probeTwilio(full, fetchOf((u) => json(u.includes('Applications') ? 404 : 200, {})))).note).toContain('TwiML app');
  });

  it('a standard API key that may not read the account still counts as good', async () => {
    const r = await probeTwilio(full, fetchOf((u, init) => json(u.includes('Applications.json') ? 200 : String((init?.headers as Record<string, string>).authorization) === `Basic ${Buffer.from(`${full.TWILIO_API_KEY_SID}:sec`).toString('base64')}` ? 403 : 200, {})));
    expect(r.ok).toBe(true);
  });

  it('a 403 on the API key check is not called a wrong key', async () => {
    const r = await probeTwilio(full, fetchOf((u) => json(u.includes('Applications.json') ? 403 : 200, {})));
    expect(r.ok).toBe(true);
  });

  it('never repeats what Twilio said', async () => {
    const r = await probeTwilio(full, fetchOf(() => json(401, { message: 'token tok is bad' })));
    expect(JSON.stringify(r)).not.toContain('tok is bad');
  });

  it('unreachable is a failure, not a crash', async () => {
    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await probeTwilio(full, down)).toMatchObject({ ok: false });
  });

  it('accepted with parts missing says what is still needed', async () => {
    const r = await probeTwilio({ TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: 'tok' }, fetchOf(() => json(200, {})));
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('API key');
  });
});

describe('asking Microsoft', () => {
  const v = { MAIL_CLIENT_ID: 'c', MAIL_CLIENT_SECRET: 's3cret-value', ALERT_MAIL_TENANT_ID: 't' };

  it('needs the tenant to test', async () => {
    const f = fetchOf(() => json(200, {}));
    expect(await probeMicrosoft({ MAIL_CLIENT_ID: 'c', MAIL_CLIENT_SECRET: 's' }, f)).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });

  it('explains a wrong secret, and repeats nothing Microsoft said', async () => {
    const r = await probeMicrosoft(v, fetchOf(() => json(401, { error_codes: [7000215], error_description: 'bad s3cret-value' })));
    expect(r.note).toContain('client secret');
    expect(JSON.stringify(r)).not.toContain('s3cret-value');
  });

  it('explains an unknown app and tenant', async () => {
    expect((await probeMicrosoft(v, fetchOf(() => json(400, { error_codes: [700016] })))).note).toContain('client ID');
    expect((await probeMicrosoft(v, fetchOf(() => json(400, { error_codes: [90002] })))).note).toContain('tenant');
  });
});

describe('asking SignWell', () => {
  const origin = 'https://crm.example.com';
  const url = `${origin}/api/agreements/webhooks/signwell`;

  it('a refused key is a failure', async () => {
    expect(await probeSignwell({ SIGNWELL_API_KEY: 'k' }, { origin, fetchImpl: fetchOf(() => json(401, {})) })).toMatchObject({ ok: false });
  });

  it('events going to another site is a warning, not a failure', async () => {
    const r = await probeSignwell({ SIGNWELL_API_KEY: 'k', SIGNWELL_WEBHOOK_ID: 'h1' }, { origin, fetchImpl: fetchOf(() => json(200, [{ id: 'h1', callback_url: 'https://other.example.com/api/agreements/webhooks/signwell' }])) });
    expect(r.ok).toBe(true);
    expect(r.warning).toContain('not sending signing events to this site');
  });

  it('events coming here under an unknown id is a warning', async () => {
    const r = await probeSignwell({ SIGNWELL_API_KEY: 'k', SIGNWELL_WEBHOOK_ID: 'old' }, { origin, fetchImpl: fetchOf(() => json(200, [{ id: 'h1', callback_url: url }])) });
    expect(r.warning).toContain('does not match');
  });

  it('all good, among several saved ids', async () => {
    const r = await probeSignwell({ SIGNWELL_API_KEY: 'k', SIGNWELL_WEBHOOK_ID: 'old, h1' }, { origin, fetchImpl: fetchOf(() => json(200, [{ id: 'h1', callback_url: url }])) });
    expect(r).toEqual({ ok: true, note: 'SignWell accepted this key, and signing events reach this site.' });
  });

  it('connecting registers this site once', async () => {
    const posts: unknown[] = [];
    const f = fetchOf((_u, init) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(init.body as string));
        return json(201, { id: 'new-hook' });
      }
      return json(200, []);
    });
    expect(await connectSignwellHook('k', origin, f)).toEqual({ ok: true, id: 'new-hook' });
    expect(posts).toEqual([{ callback_url: url }]);
  });

  it('connecting again reuses the hook instead of adding a duplicate', async () => {
    const f = fetchOf(() => json(200, [{ id: 'h1', callback_url: url }]));
    expect(await connectSignwellHook('k', origin, f)).toEqual({ ok: true, id: 'h1' });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('a local address is never registered with SignWell', async () => {
    const f = fetchOf(() => json(200, []));
    expect(await connectSignwellHook('k', 'http://localhost:3000', f)).toMatchObject({ ok: false });
    expect(f).not.toHaveBeenCalled();
  });
});

describe('asking about alerts', () => {
  const deps = (smtp: boolean) => ({ origin: 'https://x', fetchImpl: fetchOf(() => json(200, { access_token: 't' })), verifySmtp: async () => smtp });

  beforeEach(() => vi.restoreAllMocks());

  it('with no route at all, says so', async () => {
    expect(await probeAlerts({}, deps(true))).toMatchObject({ ok: false });
  });

  it('SMTP refused is a failure, and needs its login', async () => {
    expect((await probeAlerts({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }, deps(false))).ok).toBe(false);
    expect((await probeAlerts({ SMTP_HOST: 'h' }, deps(true))).note).toContain('username');
  });

  it('a verify that throws is a failure, not a crash', async () => {
    const r = await probeAlerts({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }, { origin: 'https://x', verifySmtp: async () => { throw new Error('boom'); } });
    expect(r.ok).toBe(false);
  });

  it('Microsoft and SMTP both accepted', async () => {
    const r = await probeAlerts({ ALERT_MAIL_TENANT_ID: 't', MAIL_CLIENT_ID: 'c', MAIL_CLIENT_SECRET: 's', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASSWORD: 'p' }, deps(true));
    expect(r.ok).toBe(true);
    expect(r.note).toBe('Microsoft and the SMTP server accepted these details.');
    expect(r.warning).toContain('test alert');
  });
});

describe('probeMaverick', () => {
  const key = { MAVERICK_API_KEY: 'k' };
  const answer = (status: number, headers: Record<string, string> = {}, body = '{}') => vi.fn(async () => new Response(body, { status, headers })) as unknown as typeof fetch;

  it('asks for a key first, without calling anyone', async () => {
    const f = answer(200);
    expect((await probeMaverick({}, f)).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('calls the campaign list with the bearer token and says who is calling', async () => {
    const f = answer(200);
    expect(await probeMaverick(key, f)).toEqual({ ok: true, note: 'Maverick accepted this key.' });
    const [url, init] = (f as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe('https://dashboard.maverickpayments.com/api/boarding-application/campaigns');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer k', 'User-Agent': 'TenorPaymentsCRM/1.0' });
  });

  it('uses a saved address without doubling the slash', async () => {
    const f = answer(200);
    await probeMaverick({ ...key, MAVERICK_API_URL: 'https://sandbox-dashboard.maverickpayments.com/' }, f);
    expect((f as unknown as { mock: { calls: [string][] } }).mock.calls[0]![0]).toBe('https://sandbox-dashboard.maverickpayments.com/api/boarding-application/campaigns');
  });

  it('saves with a warning when the firewall answers, because that says nothing about the key', async () => {
    const r = await probeMaverick(key, answer(403, { 'cf-mitigated': 'challenge', server: 'cloudflare', 'content-type': 'text/html' }, '<html>'));
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/firewall/);
  });

  it('treats a Cloudflare block page the same way', async () => {
    const r = await probeMaverick(key, answer(403, { server: 'cloudflare', 'content-type': 'text/html; charset=utf-8' }, '<html>'));
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/firewall/);
  });

  it('refuses a key Maverick itself turned down', async () => {
    expect((await probeMaverick(key, answer(401, { server: 'cloudflare', 'content-type': 'application/json' }))).ok).toBe(false);
  });

  it('refuses a key with no platform access, and names the fix', async () => {
    const r = await probeMaverick(key, answer(403, { server: 'cloudflare', 'content-type': 'application/json' }));
    expect(r.ok).toBe(false);
    expect(r.note).toMatch(/agent API token/);
  });

  it('keeps the key when Maverick is down or unreachable', async () => {
    expect((await probeMaverick(key, answer(503))).warning).toMatch(/503/);
    const down = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const r = await probeMaverick(key, down);
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/Could not reach/);
  });
});
