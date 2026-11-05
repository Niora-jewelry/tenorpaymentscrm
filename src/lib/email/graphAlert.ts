/**
 * Alerts (sign-in codes, invites, voicemail, mentions) through Microsoft Graph,
 * as the CRM itself rather than as a signed-in person.
 *
 * The client, 3 Nov 2026: alerts come from No-Reply@tenorpayments.com.
 *
 * ── WHY NOT JUST SMTP ─────────────────────────────────────────────────────
 * Microsoft is retiring password sign-in for SMTP: off by default from about
 * December 2026, removed for good some time after (MC786329). Sign-in codes go
 * through this path, so the day it stops, nobody can log in. Graph with an
 * application permission has no such date. SMTP stays as the fallback in
 * `send.ts`, so a Graph failure is not a lockout either.
 *
 * ── THE PERMISSION ────────────────────────────────────────────────────────
 * Application permission Mail.Send with admin consent, on the Azure app. On its
 * own that lets the app send as anyone in the tenant, so Microsoft's application
 * access policy should scope it to the No-Reply mailbox; that is done in
 * Microsoft 365, nothing here can enforce it.
 *
 * ── JSON, NOT MIME ────────────────────────────────────────────────────────
 * Graph's MIME form would carry the plain-text part and `Auto-Submitted`, but it
 * always files a copy in Sent Items, and a mailbox full of sign-in codes is the
 * thing to avoid. The JSON form takes `saveToSentItems: false`. Its cost: one
 * body (HTML) and only `x-` headers, which is why the others are dropped here.
 *
 * Nothing logged or returned carries the body, a code, a token or the secret:
 * a failure is reported as a short code such as `graph_403:ErrorAccessDenied`.
 */

export type GraphSender = { tenantId: string; clientId: string; clientSecret: string; from: string };

export type AlertMail = {
  to: string;
  subject: string;
  html: string;
  headers?: Record<string, string>;
  attachments?: { filename: string; content: Buffer }[];
};

export type GraphResult = { ok: true } | { ok: false; code: string };

/**
 * Graph's sendMail takes 4 MB in one request, and base64 adds a third. Anything
 * larger would need a draft and an upload session, which files a copy in Sent
 * Items; a voicemail over this goes by its link instead.
 */
export const GRAPH_ATTACHMENT_BYTES = 3 * 1024 * 1024 - 64 * 1024;

const TIMEOUT_MS = 10_000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `Tenor Payments <No-Reply@tenorpayments.com>` or a bare address; null when neither. */
export function addressOf(from: string): string | null {
  const inner = from.match(/<([^<>]+)>\s*$/)?.[1] ?? from;
  const address = inner.trim();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]{2,}$/.test(address) ? address : null;
}

/** Tenant is a GUID: it goes into the sign-in URL. */
export const plausibleTenant = (tenantId: string) => GUID.test(tenantId.trim());

let cached: { key: string; token: string; until: number } | null = null;

/** Tests only: the cache otherwise outlives a test's fake server. */
export function forgetGraphToken(): void {
  cached = null;
}

async function timed(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function tokenFor(cfg: GraphSender, fetchImpl: typeof fetch): Promise<string | { code: string }> {
  const key = `${cfg.tenantId}:${cfg.clientId}`;
  if (cached?.key === key && cached.until > Date.now()) return cached.token;
  const res = await timed(fetchImpl, `https://login.microsoftonline.com/${encodeURIComponent(cfg.tenantId.trim())}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }).toString(),
  });
  if (!res.ok) return { code: `token_${res.status}` };
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (typeof body?.access_token !== 'string') return { code: 'token_shape' };
  const life = typeof body.expires_in === 'number' ? body.expires_in : 3000;
  // Five minutes early: a token that dies mid-send is a failed sign-in code.
  cached = { key, token: body.access_token, until: Date.now() + Math.max(life - 300, 60) * 1000 };
  return body.access_token;
}

/** Only Graph's own error code, an identifier like ErrorAccessDenied, never its message. */
async function failureCode(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  const code = typeof body?.error?.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(body.error.code) ? `:${body.error.code}` : '';
  return `graph_${res.status}${code}`;
}

export async function sendViaGraph(cfg: GraphSender, mail: AlertMail, fetchImpl: typeof fetch = fetch): Promise<GraphResult> {
  const from = addressOf(cfg.from);
  if (!from) return { ok: false, code: 'bad_from' };
  if (!plausibleTenant(cfg.tenantId)) return { ok: false, code: 'bad_tenant' };
  const size = (mail.attachments ?? []).reduce((n, a) => n + a.content.byteLength, 0);
  if (size > GRAPH_ATTACHMENT_BYTES) return { ok: false, code: 'too_large' };

  const headers = Object.entries(mail.headers ?? {})
    .filter(([name]) => /^x-/i.test(name))
    .map(([name, value]) => ({ name, value }));
  const body = JSON.stringify({
    message: {
      subject: mail.subject,
      body: { contentType: 'HTML', content: mail.html },
      toRecipients: [{ emailAddress: { address: mail.to } }],
      ...(headers.length ? { internetMessageHeaders: headers } : {}),
      ...(mail.attachments?.length
        ? {
            attachments: mail.attachments.map((a) => ({
              '@odata.type': '#microsoft.graph.fileAttachment',
              name: a.filename,
              contentBytes: a.content.toString('base64'),
            })),
          }
        : {}),
    },
    saveToSentItems: false,
  });

  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await tokenFor(cfg, fetchImpl);
      if (typeof token !== 'string') return { ok: false, code: token.code };
      const res = await timed(fetchImpl, `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      });
      if (res.ok) return { ok: true };
      // A token revoked or rotated before its time, or one from before a permission
      // was granted (a held token keeps its old permissions): one fresh try.
      if ((res.status === 401 || res.status === 403) && attempt === 0) {
        cached = null;
        continue;
      }
      return { ok: false, code: await failureCode(res) };
    }
    return { ok: false, code: 'graph_401' };
  } catch {
    return { ok: false, code: 'network' };
  }
}
