/**
 * Asks each provider whether these keys work, before they are saved.
 *
 * Read-only calls: nothing is sent, nothing is changed at the provider. Messages
 * are written here and never repeat what a provider said, because a provider's
 * error text can quote what it was given.
 */
import type { IntegrationGroup } from './catalog';
import type { IntegrationValues } from './resolve';

const TIMEOUT_MS = 10_000;

export type ProbeResult = {
  ok: boolean;
  /** Plain sentence for the admin. */
  note: string;
  /** Worked, but something else needs doing. Never blocks a save. */
  warning?: string;
};

export type SignwellHook = { id: string; url: string };

export type ProbeDeps = {
  fetchImpl?: typeof fetch;
  /** SMTP sign-in check; injected so this file stays free of the mail library. */
  verifySmtp?: (v: IntegrationValues) => Promise<boolean>;
  /** Origin of this site, no trailing slash. */
  origin: string;
};

async function timed(fetchImpl: typeof fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

/* ── Twilio ──────────────────────────────────────────────────────────────── */

export async function probeTwilio(v: IntegrationValues, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const sid = v.TWILIO_ACCOUNT_SID;
  const token = v.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return { ok: false, note: 'Enter the Account SID and auth token to test Twilio.' };
  const account = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}`;
  try {
    const res = await timed(fetchImpl, `${account}.json`, { headers: { authorization: basic(sid, token) } });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, note: 'Twilio refused the Account SID and auth token.' };
    if (!res.ok) return { ok: false, note: 'Twilio did not answer properly. Try again in a minute.' };

    if (v.TWILIO_API_KEY_SID || v.TWILIO_API_KEY_SECRET) {
      if (!v.TWILIO_API_KEY_SID || !v.TWILIO_API_KEY_SECRET) return { ok: false, note: 'Enter both the API key SID and its secret.' };
      // Not the account itself: Twilio does not let a standard API key read that, so
      // only a 401 means these are wrong.
      const key = await timed(fetchImpl, `${account}/Applications.json?PageSize=1`, { headers: { authorization: basic(v.TWILIO_API_KEY_SID, v.TWILIO_API_KEY_SECRET) } });
      if (key.status === 401) return { ok: false, note: 'Twilio refused the API key SID and secret. Calls from the browser need them.' };
    }

    if (v.TWILIO_TWIML_APP_SID) {
      const app = await timed(fetchImpl, `${account}/Applications/${encodeURIComponent(v.TWILIO_TWIML_APP_SID)}.json`, { headers: { authorization: basic(sid, token) } });
      if (!app.ok) return { ok: false, note: 'Twilio cannot find that TwiML app on this account.' };
    }
  } catch {
    return { ok: false, note: 'Could not reach Twilio. Try again in a minute.' };
  }
  const missing = [!v.TWILIO_API_KEY_SID && 'API key', !v.TWILIO_TWIML_APP_SID && 'TwiML app'].filter(Boolean);
  return missing.length
    ? { ok: true, note: 'Twilio accepted these keys.', warning: `Still needed before calls work: ${missing.join(' and ')}.` }
    : { ok: true, note: 'Twilio accepted these keys.' };
}

/* ── Microsoft ───────────────────────────────────────────────────────────── */

/** Signs in as the app. Reads Microsoft's error numbers only, never its text. */
export async function probeMicrosoftApp(tenant: string, clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const res = await timed(fetchImpl, `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }).toString(),
    });
    if (res.ok) return { ok: true, note: 'Microsoft accepted this app.' };
    const body = (await res.json().catch(() => null)) as { error_codes?: unknown } | null;
    const codes = Array.isArray(body?.error_codes) ? (body.error_codes as unknown[]) : [];
    if (codes.includes(7000215) || codes.includes(7000222)) return { ok: false, note: 'Microsoft refused the client secret. Use the secret’s Value from Azure, not its ID, and check it has not expired.' };
    if (codes.includes(700016)) return { ok: false, note: 'Microsoft cannot find that client ID in this tenant.' };
    if (codes.includes(90002)) return { ok: false, note: 'Microsoft cannot find that tenant ID.' };
    return { ok: false, note: 'Microsoft refused these details.' };
  } catch {
    return { ok: false, note: 'Could not reach Microsoft. Try again in a minute.' };
  }
}

export async function probeMicrosoft(v: IntegrationValues, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  if (!v.MAIL_CLIENT_ID || !v.MAIL_CLIENT_SECRET) return { ok: false, note: 'Enter the client ID and client secret to test Microsoft.' };
  if (!v.ALERT_MAIL_TENANT_ID) return { ok: false, note: 'Enter the Directory (tenant) ID. Microsoft needs it to test the app.' };
  return probeMicrosoftApp(v.ALERT_MAIL_TENANT_ID, v.MAIL_CLIENT_ID, v.MAIL_CLIENT_SECRET, fetchImpl);
}

/* ── SignWell ────────────────────────────────────────────────────────────── */

const signwellHookUrl = (origin: string) => `${origin}/api/agreements/webhooks/signwell`;

export async function signwellHooks(apiKey: string, fetchImpl: typeof fetch = fetch): Promise<SignwellHook[] | { refused: boolean }> {
  try {
    const res = await timed(fetchImpl, 'https://www.signwell.com/api/v1/hooks', { headers: { 'X-Api-Key': apiKey, accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) return { refused: true };
    if (!res.ok) return { refused: false };
    const body = (await res.json().catch(() => null)) as unknown;
    const list = Array.isArray(body) ? body : ((body as { hooks?: unknown } | null)?.hooks ?? []);
    if (!Array.isArray(list)) return [];
    return list.flatMap((h: { id?: unknown; callback_url?: unknown }) => (typeof h?.id === 'string' && typeof h?.callback_url === 'string' ? [{ id: h.id, url: h.callback_url }] : []));
  } catch {
    return { refused: false };
  }
}

export async function probeSignwell(v: IntegrationValues, deps: ProbeDeps): Promise<ProbeResult> {
  if (!v.SIGNWELL_API_KEY) return { ok: false, note: 'Enter the API key to test SignWell.' };
  const hooks = await signwellHooks(v.SIGNWELL_API_KEY, deps.fetchImpl);
  if (!Array.isArray(hooks)) return { ok: false, note: hooks.refused ? 'SignWell refused that API key.' : 'Could not reach SignWell. Try again in a minute.' };

  const target = signwellHookUrl(deps.origin);
  const ours = hooks.filter((h) => h.url === target);
  const ids = (v.SIGNWELL_WEBHOOK_ID ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (ours.length === 0) return { ok: true, note: 'SignWell accepted this key.', warning: 'SignWell is not sending signing events to this site yet. Press “Connect this site”.' };
  if (!ours.some((h) => ids.includes(h.id))) return { ok: true, note: 'SignWell accepted this key.', warning: 'SignWell sends events here, but the Webhook ID saved here does not match. Press “Connect this site”.' };
  return { ok: true, note: 'SignWell accepted this key, and signing events reach this site.' };
}

/** Registers this site for signing events, or finds it already registered. */
export async function connectSignwellHook(apiKey: string, origin: string, fetchImpl: typeof fetch = fetch): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  if (!origin.startsWith('https://')) return { ok: false, message: 'This can only be done from the live site.' };
  const target = signwellHookUrl(origin);
  const hooks = await signwellHooks(apiKey, fetchImpl);
  if (!Array.isArray(hooks)) return { ok: false, message: hooks.refused ? 'SignWell refused that API key.' : 'Could not reach SignWell. Try again in a minute.' };
  const existing = hooks.find((h) => h.url === target);
  if (existing) return { ok: true, id: existing.id };
  try {
    const res = await timed(fetchImpl, 'https://www.signwell.com/api/v1/hooks', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ callback_url: target }),
    });
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (!res.ok || typeof body?.id !== 'string') return { ok: false, message: 'SignWell did not accept this site’s address.' };
    return { ok: true, id: body.id };
  } catch {
    return { ok: false, message: 'Could not reach SignWell. Try again in a minute.' };
  }
}

/* ── Alert email ─────────────────────────────────────────────────────────── */

export async function probeAlerts(v: IntegrationValues, deps: ProbeDeps): Promise<ProbeResult> {
  const tenant = v.ALERT_MAIL_TENANT_ID;
  const clientId = v.ALERT_MAIL_CLIENT_ID ?? v.MAIL_CLIENT_ID;
  const secret = v.ALERT_MAIL_CLIENT_SECRET ?? v.MAIL_CLIENT_SECRET;
  const graphOn = Boolean(tenant && clientId && secret);
  const smtpOn = Boolean(v.SMTP_HOST);
  if (!graphOn && !smtpOn) return { ok: false, note: 'No way to send alerts yet. Set up Microsoft 365 above, or enter an SMTP server.' };

  const worked: string[] = [];
  if (graphOn) {
    const r = await probeMicrosoftApp(tenant!, clientId!, secret!, deps.fetchImpl);
    if (!r.ok) return r;
    worked.push('Microsoft');
  }
  if (smtpOn) {
    if (!v.SMTP_USER || !v.SMTP_PASSWORD) return { ok: false, note: 'Enter the SMTP username and password too.' };
    const accepted = await (deps.verifySmtp?.(v) ?? Promise.resolve(false)).catch(() => false);
    if (!accepted) return { ok: false, note: 'The SMTP server refused that username and password, or could not be reached.' };
    worked.push('the SMTP server');
  }
  return {
    ok: true,
    note: `${worked.join(' and ')} accepted these details.`.replace(/^./, (c) => c.toUpperCase()),
    warning: graphOn ? 'Send yourself a test alert to confirm the app may send from that mailbox.' : undefined,
  };
}

/* ── Maverick Payments ───────────────────────────────────────────────────── */

/**
 * Maverick's API documentation is not in yet, so there is no call to make that
 * proves a key. The key's shape is checked and it is saved; Test connection
 * says plainly that it could not be verified.
 */
export async function probeMaverick(v: IntegrationValues): Promise<ProbeResult> {
  if (!v.MAVERICK_API_KEY) return { ok: false, note: 'Enter the Maverick API key first.' };
  return { ok: true, note: 'The key is stored.', warning: 'It could not be checked with Maverick yet: the connection is switched on once their API documentation is in.' };
}

export function probeGroup(group: IntegrationGroup, v: IntegrationValues, deps: ProbeDeps): Promise<ProbeResult> {
  switch (group) {
    case 'twilio':
      return probeTwilio(v, deps.fetchImpl);
    case 'microsoft':
      return probeMicrosoft(v, deps.fetchImpl);
    case 'signwell':
      return probeSignwell(v, deps);
    case 'alerts':
      return probeAlerts(v, deps);
    case 'maverick':
      return probeMaverick(v);
  }
}
