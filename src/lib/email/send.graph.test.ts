/**
 * Which road an alert takes. Sign-in codes go this way, so the rule that matters:
 * Graph failing must fall through to SMTP, and with neither the code is not lost
 * silently in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendMail = vi.fn(async () => ({}));
vi.mock('nodemailer', () => ({ default: { createTransport: () => ({ sendMail }) } }));

const graphEnv = { ALERT_MAIL_TENANT_ID: '11111111-2222-3333-4444-555555555555', MAIL_CLIENT_ID: 'c', MAIL_CLIENT_SECRET: 's' };
const smtpEnv = { SMTP_HOST: 'smtp.test', SMTP_PORT: 587, SMTP_USER: 'u', SMTP_PASSWORD: 'p' };

async function load(env: Record<string, unknown>, isProduction = false) {
  vi.resetModules();
  vi.doMock('@/lib/env.server', () => ({
    serverEnv: { NODE_ENV: isProduction ? 'production' : 'development', EMAIL_FROM: 'Tenor Payments <No-Reply@tenorpayments.com>', ...env },
    isProduction,
  }));
  return import('./send');
}

const reply = (url: string, graph: Response) =>
  url.includes('login.microsoftonline.com') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 }), { status: 200 }) : graph;

describe('the road an alert takes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const graphAnswers = (res: () => Response) => fetchMock.mockImplementation(async (url: string) => reply(String(url), res()));
  const graphCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).includes('graph.microsoft.com'));

  beforeEach(() => {
    sendMail.mockClear();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('set up for Graph: goes by Graph, and SMTP is not touched', async () => {
    graphAnswers(() => new Response(null, { status: 202 }));
    const { sendOtpEmail } = await load({ ...graphEnv, ...smtpEnv });
    expect(await sendOtpEmail('jane@example.com', '123456', 'signup')).toEqual({ ok: true });
    expect(graphCalls()).toHaveLength(1);
    expect(String(graphCalls()[0]![0])).toContain('No-Reply%40tenorpayments.com');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('Graph refuses: the code still goes, by SMTP', async () => {
    graphAnswers(() => new Response(JSON.stringify({ error: { code: 'ErrorAccessDenied' } }), { status: 403 }));
    const { sendOtpEmail } = await load({ ...graphEnv, ...smtpEnv });
    expect(await sendOtpEmail('jane@example.com', '123456', 'signup')).toEqual({ ok: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('Microsoft unreachable: the code still goes, by SMTP', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });
    const { sendOtpEmail } = await load({ ...graphEnv, ...smtpEnv });
    expect(await sendOtpEmail('jane@example.com', '123456', 'signup')).toEqual({ ok: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('what it logs when Graph fails holds no code', async () => {
    graphAnswers(() => new Response(null, { status: 500 }));
    const { sendOtpEmail } = await load({ ...graphEnv, ...smtpEnv });
    await sendOtpEmail('jane@example.com', '123456', 'signup');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('123456');
  });

  it('Graph not set up: SMTP alone, as before', async () => {
    const { sendOtpEmail } = await load(smtpEnv);
    expect(await sendOtpEmail('jane@example.com', '123456', 'signup')).toEqual({ ok: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('in production, Graph failing with no SMTP behind it reports the failure', async () => {
    graphAnswers(() => new Response(null, { status: 403 }));
    const { sendOtpEmail } = await load(graphEnv, true);
    expect(await sendOtpEmail('jane@example.com', '123456', 'signup')).toMatchObject({ ok: false });
  });

  it('a voicemail attaches up to what the road can carry', async () => {
    const graphOn = await load({ ...graphEnv, ...smtpEnv });
    expect(graphOn.alertAttachmentLimit(15 * 1024 * 1024)).toBeLessThan(3 * 1024 * 1024);
    const smtpOnly = await load(smtpEnv);
    expect(smtpOnly.alertAttachmentLimit(15 * 1024 * 1024)).toBe(15 * 1024 * 1024);
  });
});
