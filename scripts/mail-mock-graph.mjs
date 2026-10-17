/**
 * A stand-in for Microsoft — the identity platform's authorize/token
 * endpoints and the slice of Graph the Email module calls — so the real
 * routes, RPCs, token encryption and UI can be driven end to end without a
 * tenant.
 *
 *   node scripts/mail-mock-graph.mjs            (port 4555, or MOCK_PORT)
 *
 * Run the app against it with:
 *   MAIL_PROVIDER=mock MAIL_MOCK_BASE_URL=http://127.0.0.1:4555
 *   MAIL_STATE_SIGNING_SECRET=<≥32 chars> MAIL_TOKEN_ENC_KEY=<32 bytes b64>
 * (`env.server.ts` refuses MAIL_PROVIDER=mock in production.)
 *
 * It is strict where Microsoft is strict, because a lenient mock proves
 * nothing: the PKCE verifier must hash to the challenge, a code works once
 * and only with its redirect_uri, tokens are bound to one account, and a
 * shared mailbox answers only for its delegates.
 *
 * Accounts on the sign-in page:
 *   owner@mock.test     work account; delegate of team@mock.test
 *   other@mock.test     work account in ANOTHER tenant
 *   nobox@mock.test     work account with no Exchange mailbox
 *   person@outlook.test personal Microsoft account (consumer tenant)
 * Shared mailboxes: team@mock.test (owner has access), vault@mock.test (nobody).
 *
 * Fault injection: POST /__mock/fault {"refresh":"invalid_grant"|"secret"|null}
 * Inspection:      GET  /__mock/state
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 4555);
const CONSUMER = '9188040d-6c67-4c5b-b112-36a304b66dad';

const ACCOUNTS = {
  'owner@mock.test': { oid: 'oid-owner', tid: 'tid-tapdash', name: 'Olive Owner', mailbox: true },
  'other@mock.test': { oid: 'oid-other', tid: 'tid-elsewhere', name: 'Otto Other', mailbox: true },
  'nobox@mock.test': { oid: 'oid-nobox', tid: 'tid-tapdash', name: 'Nora Nobox', mailbox: false },
  'person@outlook.test': { oid: 'oid-person', tid: CONSUMER, name: 'Pat Person', mailbox: true },
};
const SHARED = {
  'team@mock.test': { delegates: ['oid-owner'] },
  'vault@mock.test': { delegates: [] },
};

const FOLDERS = [
  ['inbox', 'Inbox', null, 12, 3],
  ['drafts', 'Drafts', null, 1, 0],
  ['sentitems', 'Sent Items', null, 30, 0],
  ['deleteditems', 'Deleted Items', null, 4, 0],
  ['junkemail', 'Junk Email', null, 0, 0],
  ['archive', 'Archive', null, 50, 0],
  ['outbox', 'Outbox', null, 0, 0],
  ['clients', 'Clients', 'inbox', 6, 1],
  ['acme', 'Acme', 'clients', 2, 0],
];
const folderId = (mailbox, key) => `fld-${mailbox}-${key}`;

const codes = new Map(); // code → { email, challenge, redirectUri, used }
const access = new Map(); // access token → email
const refresh = new Map(); // refresh token → email
let fault = { refresh: null };
const log = [];

const b64url = (b) => Buffer.from(b).toString('base64url');
const idToken = (email) => {
  const a = ACCOUNTS[email];
  return `${b64url(JSON.stringify({ alg: 'none' }))}.${b64url(JSON.stringify({ oid: a.oid, tid: a.tid, preferred_username: email, name: a.name }))}.`;
};
function mint(email) {
  const at = `mock-at-${randomBytes(12).toString('hex')}`;
  const rt = `mock-rt-${randomBytes(12).toString('hex')}`;
  access.set(at, email);
  refresh.set(rt, email);
  return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'Bearer', scope: GRANTED, id_token: idToken(email) };
}
const GRANTED = [
  'https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Mail.ReadWrite', 'https://graph.microsoft.com/Mail.ReadWrite.Shared',
  'https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/Mail.Send.Shared', 'https://graph.microsoft.com/MailboxSettings.ReadWrite',
  'https://graph.microsoft.com/Calendars.ReadWrite', 'https://graph.microsoft.com/Calendars.ReadWrite.Shared', 'https://graph.microsoft.com/Contacts.Read',
  'openid', 'profile', 'email', 'offline_access',
].join(' ');

function send(res, status, body, headers = {}) {
  const isHtml = typeof body === 'string';
  res.writeHead(status, { 'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'application/json', ...headers });
  res.end(isHtml ? body : body === undefined ? '' : JSON.stringify(body));
}
const graphErr = (status, code, message = code) => ({ status, body: { error: { code, message } } });

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// ── identity platform ──────────────────────────────────────────────────────
function authorizePage(url) {
  const p = url.searchParams;
  const missing = ['client_id', 'redirect_uri', 'state', 'code_challenge', 'scope'].filter((k) => !p.get(k));
  if (missing.length || p.get('code_challenge_method') !== 'S256' || p.get('response_type') !== 'code') {
    return `<h1>Bad authorize request</h1><p>${missing.join(', ') || 'method/response_type'}</p>`;
  }
  const back = (extra) => {
    const u = new URL(p.get('redirect_uri'));
    for (const [k, v] of Object.entries({ ...extra, state: p.get('state') })) u.searchParams.set(k, v);
    return u.toString();
  };
  const links = Object.keys(ACCOUNTS).map((email) => {
    const code = `mock-code-${randomBytes(10).toString('hex')}`;
    codes.set(code, { email, challenge: p.get('code_challenge'), redirectUri: p.get('redirect_uri'), used: false });
    return `<li><a data-account="${email}" href="${back({ code })}">${email}</a></li>`;
  });
  return `<!doctype html><title>Mock Microsoft sign-in</title><h1>Pick an account</h1><ul>${links.join('')}</ul>
    <p><a data-account="cancel" href="${back({ error: 'access_denied', error_description: 'AADSTS65004: User declined to consent' })}">Cancel</a></p>`;
}

function token(form) {
  if (!form.get('client_id') || !form.get('client_secret')) return { status: 401, body: { error: 'invalid_client' } };
  if (form.get('grant_type') === 'authorization_code') {
    const c = codes.get(form.get('code') ?? '');
    if (!c || c.used) return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS70008: code expired or used' } };
    c.used = true;
    if (c.redirectUri !== form.get('redirect_uri')) return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS50011: redirect mismatch' } };
    const verifier = form.get('code_verifier') ?? '';
    if (b64url(createHash('sha256').update(verifier).digest()) !== c.challenge) {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS501481: PKCE verification failed' } };
    }
    return { status: 200, body: mint(c.email) };
  }
  if (form.get('grant_type') === 'refresh_token') {
    if (fault.refresh === 'secret') return { status: 401, body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' } };
    const email = refresh.get(form.get('refresh_token') ?? '');
    if (!email || fault.refresh === 'invalid_grant') {
      return { status: 400, body: { error: 'invalid_grant', error_description: 'AADSTS700082: The refresh token has expired' } };
    }
    return { status: 200, body: mint(email) };
  }
  return { status: 400, body: { error: 'unsupported_grant_type' } };
}

// ── Graph ──────────────────────────────────────────────────────────────────
/** Which mailbox a /users/{x} segment names, and whether this caller may open it. */
function resolveMailbox(caller, segment) {
  const seg = decodeURIComponent(segment).toLowerCase();
  const me = ACCOUNTS[caller];
  const own = seg === caller || seg === me.oid;
  if (own) return me.mailbox ? { address: caller } : graphErr(404, 'MailboxNotEnabledForRESTAPI', 'REST API is not yet supported for this mailbox.');
  const shared = SHARED[seg];
  if (!shared) return graphErr(404, 'ErrorInvalidUser', 'The requested user is invalid.');
  if (!shared.delegates.includes(me.oid)) return graphErr(403, 'ErrorAccessDenied', 'Access is denied. Check credentials and try again.');
  return { address: seg };
}

function folderJson(address, [key, name, parent, total, unread]) {
  return {
    id: folderId(address, key),
    displayName: name,
    parentFolderId: parent ? folderId(address, parent) : `root-${address}`,
    totalItemCount: total,
    unreadItemCount: unread,
    childFolderCount: FOLDERS.filter((f) => f[2] === key).length,
  };
}

function graph(caller, method, pathAndQuery) {
  const url = new URL(pathAndQuery, 'http://mock');
  const parts = url.pathname.replace(/^\/v1\.0/, '').split('/').filter(Boolean);
  if (method === 'GET' && parts.length === 1 && parts[0] === 'me') {
    const a = ACCOUNTS[caller];
    return { status: 200, body: { id: a.oid, displayName: a.name, mail: a.mailbox ? caller : null, userPrincipalName: caller } };
  }
  if (parts[0] !== 'users' || !parts[1]) return graphErr(400, 'BadRequest', 'Unsupported path');
  const mb = resolveMailbox(caller, parts[1]);
  if (mb.status) return mb;
  const rest = parts.slice(2);
  if (method === 'GET' && rest[0] === 'mailFolders' && rest[1] === 'delta' && rest.length === 2) {
    // Two pages, the way Graph pages a real tree.
    const all = FOLDERS.map((f) => folderJson(mb.address, f));
    const page = url.searchParams.get('$skiptoken') === '2' ? 2 : 1;
    if (page === 1) {
      return { status: 200, body: { value: all.slice(0, 5), '@odata.nextLink': `http://127.0.0.1:${PORT}/v1.0/users/${parts[1]}/mailFolders/delta?$skiptoken=2` } };
    }
    return { status: 200, body: { value: all.slice(5), '@odata.deltaLink': `http://127.0.0.1:${PORT}/v1.0/users/${parts[1]}/mailFolders/delta?$deltatoken=x` } };
  }
  if (method === 'GET' && rest[0] === 'mailFolders' && rest.length === 2) {
    const f = FOLDERS.find((x) => x[0] === rest[1].toLowerCase());
    return f ? { status: 200, body: { id: folderId(mb.address, f[0]) } } : graphErr(404, 'ErrorFolderNotFound');
  }
  return graphErr(400, 'BadRequest', `Mock does not serve ${method} ${url.pathname}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/__mock/state') return send(res, 200, { codes: codes.size, access: access.size, refresh: refresh.size, fault, log: log.slice(-50) });
    if (url.pathname === '/__mock/fault' && req.method === 'POST') {
      fault = { refresh: null, ...JSON.parse((await readBody(req)) || '{}') };
      return send(res, 200, fault);
    }
    if (url.pathname === '/oauth2/v2.0/authorize') return send(res, 200, authorizePage(url));
    if (url.pathname === '/oauth2/v2.0/token' && req.method === 'POST') {
      const r = token(new URLSearchParams(await readBody(req)));
      log.push(`token ${r.status}`);
      return send(res, r.status, r.body);
    }
    if (url.pathname.startsWith('/v1.0/')) {
      const caller = access.get((req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (!caller) return send(res, 401, { error: { code: 'InvalidAuthenticationToken', message: 'Access token is empty or invalid.' } });
      const prefer = String(req.headers.prefer ?? '');
      if (!prefer.includes('IdType="ImmutableId"')) return send(res, 400, { error: { code: 'MockStrict', message: 'Prefer IdType="ImmutableId" missing' } });
      if (url.pathname === '/v1.0/$batch' && req.method === 'POST') {
        const { requests = [] } = JSON.parse(await readBody(req));
        if (requests.length > 20) return send(res, 400, { error: { code: 'BadRequest', message: 'More than 20 requests' } });
        const responses = requests.map((r) => {
          const out = graph(caller, r.method, `/v1.0${r.url.startsWith('/') ? '' : '/'}${r.url}`);
          return { id: r.id, status: out.status, headers: {}, body: out.body };
        });
        log.push(`batch ${requests.length}`);
        return send(res, 200, { responses });
      }
      const out = graph(caller, req.method, url.pathname + url.search);
      log.push(`${req.method} ${url.pathname} ${out.status}`);
      return send(res, out.status, out.body);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock Microsoft on http://127.0.0.1:${PORT}`));
