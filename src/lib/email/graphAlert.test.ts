import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addressOf, forgetGraphToken, GRAPH_ATTACHMENT_BYTES, sendViaGraph, type GraphSender } from './graphAlert';

const cfg: GraphSender = {
  tenantId: '11111111-2222-3333-4444-555555555555',
  clientId: 'client-id',
  clientSecret: 'super-secret-value',
  from: 'Tenor Payments <No-Reply@tenorpayments.com>',
};
const mail = { to: 'jane@example.com', subject: 'Your code', html: '<p>Your code: 123456</p>' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake Microsoft: answers the token call, then whatever `graph` says. */
function microsoft(graph: () => Response, token: () => Response = () => json(200, { access_token: 'tok-1', expires_in: 3600 })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return String(url).includes('login.microsoftonline.com') ? token() : graph();
  });
  return { impl: impl as unknown as typeof fetch, calls, sends: () => calls.filter((c) => c.url.includes('graph.microsoft.com')), tokens: () => calls.filter((c) => c.url.includes('login.microsoftonline.com')) };
}

describe('alerts through Microsoft Graph', () => {
  beforeEach(() => forgetGraphToken());

  it('reads the address out of the From line', () => {
    expect(addressOf('Tenor Payments <No-Reply@tenorpayments.com>')).toBe('No-Reply@tenorpayments.com');
    expect(addressOf('No-Reply@tenorpayments.com')).toBe('No-Reply@tenorpayments.com');
    expect(addressOf('Tenor Payments')).toBeNull();
    expect(addressOf('')).toBeNull();
  });

  it('signs in as the app, for this tenant, and sends from the No-Reply mailbox', async () => {
    const m = microsoft(() => new Response(null, { status: 202 }));
    expect(await sendViaGraph(cfg, mail, m.impl)).toEqual({ ok: true });
    const [t] = m.tokens();
    expect(t!.url).toBe(`https://login.microsoftonline.com/${cfg.tenantId}/oauth2/v2.0/token`);
    const form = new URLSearchParams(t!.init.body as string);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('scope')).toBe('https://graph.microsoft.com/.default');
    const [s] = m.sends();
    expect(s!.url).toBe('https://graph.microsoft.com/v1.0/users/No-Reply%40tenorpayments.com/sendMail');
    expect((s!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    const body = JSON.parse(s!.init.body as string);
    expect(body.message.toRecipients).toEqual([{ emailAddress: { address: 'jane@example.com' } }]);
    expect(body.message.body).toEqual({ contentType: 'HTML', content: mail.html });
  });

  it('files no copy in Sent Items: that mailbox must not fill with sign-in codes', async () => {
    const m = microsoft(() => new Response(null, { status: 202 }));
    await sendViaGraph(cfg, mail, m.impl);
    expect(JSON.parse(m.sends()[0]!.init.body as string).saveToSentItems).toBe(false);
  });

  it('keeps x- headers and drops the rest, which Graph would refuse', async () => {
    const m = microsoft(() => new Response(null, { status: 202 }));
    await sendViaGraph(cfg, { ...mail, headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'All' } }, m.impl);
    expect(JSON.parse(m.sends()[0]!.init.body as string).message.internetMessageHeaders).toEqual([{ name: 'X-Auto-Response-Suppress', value: 'All' }]);
  });

  it('sends an attachment as base64', async () => {
    const m = microsoft(() => new Response(null, { status: 202 }));
    await sendViaGraph(cfg, { ...mail, attachments: [{ filename: 'voicemail.mp3', content: Buffer.from('abc') }] }, m.impl);
    expect(JSON.parse(m.sends()[0]!.init.body as string).message.attachments).toEqual([
      { '@odata.type': '#microsoft.graph.fileAttachment', name: 'voicemail.mp3', contentBytes: Buffer.from('abc').toString('base64') },
    ]);
  });

  it('refuses an attachment too big for one request, without calling Microsoft', async () => {
    const m = microsoft(() => new Response(null, { status: 202 }));
    const big = Buffer.alloc(GRAPH_ATTACHMENT_BYTES + 1);
    expect(await sendViaGraph(cfg, { ...mail, attachments: [{ filename: 'v.mp3', content: big }] }, m.impl)).toEqual({ ok: false, code: 'too_large' });
    expect(m.calls).toHaveLength(0);
    // What fits in the limit stays under Graph's 4 MB once it is base64.
    expect(Math.ceil((GRAPH_ATTACHMENT_BYTES * 4) / 3)).toBeLessThan(4 * 1024 * 1024);
  });

  it('reuses its token rather than signing in for every email', async () => {
    const m = microsoft(() => new Response(null, { status: 202 }));
    await sendViaGraph(cfg, mail, m.impl);
    await sendViaGraph(cfg, mail, m.impl);
    expect(m.tokens()).toHaveLength(1);
    expect(m.sends()).toHaveLength(2);
  });

  it('a token that dies early gets one fresh try', async () => {
    let n = 0;
    const m = microsoft(() => (++n === 1 ? json(401, { error: { code: 'InvalidAuthenticationToken' } }) : new Response(null, { status: 202 })));
    expect(await sendViaGraph(cfg, mail, m.impl)).toEqual({ ok: true });
    expect(m.tokens()).toHaveLength(2);
    expect(m.sends()).toHaveLength(2);
  });

  it('a second 401 is a failure, not a loop', async () => {
    const m = microsoft(() => json(401, { error: { code: 'InvalidAuthenticationToken' } }));
    expect(await sendViaGraph(cfg, mail, m.impl)).toEqual({ ok: false, code: 'graph_401:InvalidAuthenticationToken' });
    expect(m.sends()).toHaveLength(2);
  });

  it('no permission yet reports the reason as a code, and nothing private', async () => {
    const m = microsoft(() => json(403, { error: { code: 'ErrorAccessDenied', message: 'Access is denied for jane@example.com 123456' } }));
    const r = await sendViaGraph(cfg, mail, m.impl);
    expect(r).toEqual({ ok: false, code: 'graph_403:ErrorAccessDenied' });
    expect(JSON.stringify(r)).not.toContain('123456');
  });

  it('a refused sign-in reports the status and never the secret', async () => {
    const m = microsoft(() => new Response(null, { status: 202 }), () => json(401, { error: 'invalid_client', error_description: 'super-secret-value is wrong' }));
    const r = await sendViaGraph(cfg, mail, m.impl);
    expect(r).toEqual({ ok: false, code: 'token_401' });
    expect(JSON.stringify(r)).not.toContain('super-secret-value');
    expect(m.sends()).toHaveLength(0);
  });

  it('Microsoft unreachable is reported, not thrown: the fallback has to get its turn', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    expect(await sendViaGraph(cfg, mail, down)).toEqual({ ok: false, code: 'network' });
  });

  it('a From line with no address, or a bad tenant, never reaches Microsoft', async () => {
    const m = microsoft(() => new Response(null, { status: 202 }));
    expect(await sendViaGraph({ ...cfg, from: 'Tenor Payments' }, mail, m.impl)).toEqual({ ok: false, code: 'bad_from' });
    expect(await sendViaGraph({ ...cfg, tenantId: 'x/../evil' }, mail, m.impl)).toEqual({ ok: false, code: 'bad_tenant' });
    expect(m.calls).toHaveLength(0);
  });
});
