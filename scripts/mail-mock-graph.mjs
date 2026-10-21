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
 * Mail: each mailbox has the folders below and a message store with a
 * change sequence. `mailFolders/{id}/messages/delta` pages (Prefer
 * odata.maxpagesize), bakes its cutoff into the nextLink, and returns
 * changes since its cursor -- including `@removed` for messages that LEFT the
 * folder (moved or deleted), exactly the ambiguity Graph has.
 *
 * Test hooks (POST, JSON):
 *   /__mock/message  {mailbox, folder, subject?, body?, from?, isRead?, receivedDaysAgo?, attachments?} -> {id}
 *   /__mock/update   {id, isRead?, folder?, subject?}   (folder = move)
 *   /__mock/delete   {id}
 *   /__mock/fault    {refresh: "invalid_grant"|"secret"|null, expireDelta: bool, throttle: n, revokeAccess: bool}
 *   /__mock/reset    clears mail and faults
 *   /__mock/lifecycle {mailbox, event}  posts a lifecycle notification to that mailbox's subscriptions
 *
 * Subscriptions: POST /v1.0/subscriptions runs Microsoft's validation
 * handshake against notificationUrl before accepting; every message change
 * then POSTs a change notification there (fault notifyBadClientState sends a
 * wrong clientState). PATCH renews, DELETE removes.
 * Writes: PATCH messages/{id} {isRead}, POST messages/{id}/move
 * {destinationId}, DELETE messages/{id}; mailFolders POST / childFolders POST
 * / PATCH {displayName} / POST {id}/move / DELETE — all per mailbox.
 * Fault failOps: n → the next n message writes answer 500 (ErrorInternalServerError).
 * Inspection:        GET /__mock/state
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
const customFolders = new Map(); // address -> [[key, name, parentKey]]
let nextFolder = 1;
function foldersOf(address) {
  const custom = customFolders.get(address) ?? [];
  const overridden = new Set(custom.map((f) => f[0]));
  return [...FOLDERS.filter((f) => !overridden.has(f[0])).map((f) => [f[0], f[1], f[2]]), ...custom];
}
const WELL_KNOWN_KEYS = new Set(['inbox', 'drafts', 'sentitems', 'deleteditems', 'junkemail', 'archive', 'outbox']);

const codes = new Map(); // code → { email, challenge, redirectUri, used }
const access = new Map(); // access token → email
const refresh = new Map(); // refresh token → email
let fault = { refresh: null, expireDelta: false, throttle: 0, notifyBadClientState: false, failOps: 0 };

// -- subscriptions ------------------------------------------------------------
const subs = new Map(); // id -> { id, mailbox, kind, notificationUrl, lifecycleUrl, clientState, expires }
let nextSub = 1;
const deliveries = []; // { url, status }

async function post(url, body) {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    deliveries.push({ url: url.replace(/\?.*$/, ''), status: r.status });
    return r;
  } catch {
    deliveries.push({ url, status: 0 });
    return null;
  }
}

function notify(mailbox, changeType, messageId) {
  for (const sub of subs.values()) {
    if (sub.mailbox !== mailbox || sub.kind !== 'messages') continue;
    void post(sub.notificationUrl, {
      value: [{
        subscriptionId: sub.id,
        clientState: fault.notifyBadClientState ? 'forged-client-state' : sub.clientState,
        changeType,
        resource: `Users/${ACCOUNTS[mailbox]?.oid ?? mailbox}/Messages/${messageId}`,
        resourceData: { '@odata.type': '#Microsoft.Graph.Message', id: messageId },
        tenantId: 'tid-tapdash',
      }],
    });
  }
}

async function createSubscription(caller, body) {
  const m = /^\/?users\/([^/]+)\/(messages|mailFolders)$/i.exec(body.resource ?? '');
  if (!m) return graphErr(400, 'InvalidRequest', 'Unsupported resource');
  const mb = resolveMailbox(caller, m[1]);
  if (mb.status) return mb;
  if (!body.notificationUrl || !body.clientState || !body.changeType) return graphErr(400, 'InvalidRequest', 'Missing fields');
  // Microsoft's handshake: the endpoint must echo the token within 10 s.
  const token = `validation-${randomBytes(6).toString('hex')}`;
  const r = await post(`${body.notificationUrl}?validationToken=${encodeURIComponent(token)}`, {});
  const echoed = r ? await r.text() : '';
  if (!r || r.status !== 200 || echoed !== token) {
    return graphErr(400, 'ValidationError', 'Subscription validation request failed. Response must exactly match validationToken query parameter.');
  }
  const id = `sub-${nextSub++}`;
  const sub = {
    id, mailbox: mb.address, kind: m[2] === 'messages' ? 'messages' : 'mailFolders',
    notificationUrl: body.notificationUrl, lifecycleUrl: body.lifecycleNotificationUrl, clientState: body.clientState,
    expires: body.expirationDateTime,
  };
  subs.set(id, sub);
  return { status: 201, body: { id, resource: body.resource, expirationDateTime: sub.expires, clientState: sub.clientState } };
}

// -- mail store ---------------------------------------------------------------
let seq = 1;
const messages = new Map(); // id -> message
const removals = []; // { mailbox, folder, id, seq }
let nextMsg = 1;

function folderKeyOf(address, id) {
  const f = foldersOf(address).find((x) => folderId(address, x[0]) === id || x[0] === String(id).toLowerCase());
  return f ? f[0] : null;
}

function addMessage({ mailbox, folder = 'inbox', subject = 'Hello', body, from = 'ann@client.example', fromName, to, cc, conversationId, importance = 'normal', isRead = false, receivedDaysAgo = 0, attachments = [] }) {
  const id = `AAMkMock${String(nextMsg++).padStart(6, '0')}`; // immutable: never changes on move
  const received = new Date(Date.now() - receivedDaysAgo * 86_400_000).toISOString();
  messages.set(id, {
    id, mailbox, folder, subject, isRead, received, from, fromName, to, cc, conversationId, importance, seq: seq++,
    body: body ?? `<p>${subject}</p>`,
    attachments: attachments.map((a, i) => ({
      id: `${id}-att-${i}`, name: a.name, contentType: a.contentType ?? 'application/pdf', size: a.size ?? 1234,
      isInline: Boolean(a.isInline), contentId: a.contentId ?? null, bytes: a.bytes ?? null,
    })),
  });
  notify(mailbox, 'created', id);
  return id;
}

function messageJson(m) {
  return {
    id: m.id,
    conversationId: m.conversationId ?? `conv-${m.id}`,
    changeKey: `ck-${m.seq}`,
    subject: m.subject,
    bodyPreview: m.subject,
    body: { contentType: 'html', content: m.body },
    from: { emailAddress: { name: m.fromName ?? m.from.split('@')[0], address: m.from } },
    sender: { emailAddress: { name: m.fromName ?? m.from.split('@')[0], address: m.from } },
    toRecipients: (m.to ?? [{ name: 'Owner', address: m.mailbox }]).map((r) => ({ emailAddress: r })),
    ccRecipients: (m.cc ?? []).map((r) => ({ emailAddress: r })), bccRecipients: [], replyTo: [],
    receivedDateTime: m.received,
    sentDateTime: m.received,
    isRead: m.isRead,
    isDraft: false,
    hasAttachments: m.attachments.some((a) => !a.isInline),
    importance: m.importance,
    parentFolderId: folderId(m.mailbox, m.folder),
    lastModifiedDateTime: new Date().toISOString(),
  };
}

function mutate({ id, isRead, folder, subject }) {
  const m = messages.get(id);
  if (!m) return false;
  if (folder && folder !== m.folder) {
    removals.push({ mailbox: m.mailbox, folder: m.folder, id, seq: seq++ });
    m.folder = folder;
  }
  if (typeof isRead === 'boolean') m.isRead = isRead;
  if (subject) m.subject = subject;
  m.seq = seq++;
  notify(m.mailbox, 'updated', id);
  return true;
}

function remove(id) {
  const m = messages.get(id);
  if (!m) return false;
  removals.push({ mailbox: m.mailbox, folder: m.folder, id, seq: seq++ });
  messages.delete(id);
  notify(m.mailbox, 'deleted', id);
  return true;
}

function messageDelta(address, folderKey, url, pageSize) {
  const p = url.searchParams;
  const base = `http://127.0.0.1:${PORT}${url.pathname}`;
  const token = p.get('$deltatoken');
  if (token) {
    if (fault.expireDelta) {
      fault.expireDelta = false;
      return graphErr(410, 'SyncStateNotFound', 'The sync state generation is not found.');
    }
    const since = Number(token);
    const changed = [...messages.values()].filter((m) => m.mailbox === address && m.folder === folderKey && m.seq >= since).map(messageJson);
    const gone = removals.filter((r) => r.mailbox === address && r.folder === folderKey && r.seq >= since).map((r) => ({ id: r.id, '@removed': { reason: 'deleted' } }));
    return { status: 200, body: { value: [...changed, ...gone], '@odata.deltaLink': `${base}?$deltatoken=${seq}` } };
  }
  // Initial walk: cutoff from $filter (or carried in the skiptoken), paged.
  let cutoff = 0;
  let offset = 0;
  const skip = p.get('$skiptoken');
  if (skip) {
    [offset, cutoff] = skip.split('~').map(Number);
  } else {
    const m = /receivedDateTime ge (\S+)/.exec(p.get('$filter') ?? '');
    cutoff = m ? Date.parse(m[1]) : 0;
    if (!(p.get('$select') ?? '').split(',').includes('body')) return graphErr(400, 'MockStrict', 'delta seed without $select body');
  }
  const all = [...messages.values()]
    .filter((m) => m.mailbox === address && m.folder === folderKey && Date.parse(m.received) >= cutoff)
    .sort((a, b) => b.received.localeCompare(a.received));
  const page = all.slice(offset, offset + pageSize).map(messageJson);
  if (offset + pageSize < all.length) {
    return { status: 200, body: { value: page, '@odata.nextLink': `${base}?$skiptoken=${offset + pageSize}~${cutoff}` } };
  }
  return { status: 200, body: { value: page, '@odata.deltaLink': `${base}?$deltatoken=${seq}` } };
}
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

function folderJson(address, [key, name, parent]) {
  const inFolder = [...messages.values()].filter((m) => m.mailbox === address && m.folder === key);
  return {
    id: folderId(address, key),
    displayName: name,
    parentFolderId: parent ? folderId(address, parent) : `root-${address}`,
    totalItemCount: inFolder.length,
    unreadItemCount: inFolder.filter((m) => !m.isRead).length,
    childFolderCount: foldersOf(address).filter((f) => f[2] === key).length,
  };
}

function graph(caller, method, pathAndQuery, pageSize = 10, body = null) {
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
    const all = foldersOf(mb.address).map((f) => folderJson(mb.address, f));
    const page = url.searchParams.get('$skiptoken') === '2' ? 2 : 1;
    if (page === 1) {
      return { status: 200, body: { value: all.slice(0, 5), '@odata.nextLink': `http://127.0.0.1:${PORT}/v1.0/users/${parts[1]}/mailFolders/delta?$skiptoken=2` } };
    }
    return { status: 200, body: { value: all.slice(5), '@odata.deltaLink': `http://127.0.0.1:${PORT}/v1.0/users/${parts[1]}/mailFolders/delta?$deltatoken=x` } };
  }
  if (method === 'GET' && rest[0] === 'mailFolders' && rest.length === 2) {
    const key = folderKeyOf(mb.address, decodeURIComponent(rest[1]));
    if (!key) return graphErr(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
    const inFolder = [...messages.values()].filter((m) => m.mailbox === mb.address && m.folder === key);
    return {
      status: 200,
      body: { id: folderId(mb.address, key), totalItemCount: inFolder.length, unreadItemCount: inFolder.filter((m) => !m.isRead).length },
    };
  }
  if (method === 'GET' && rest[0] === 'mailFolders' && rest[2] === 'messages' && rest[3] === 'delta') {
    const key = folderKeyOf(mb.address, decodeURIComponent(rest[1]));
    if (!key) return graphErr(404, 'ErrorItemNotFound');
    return messageDelta(mb.address, key, url, pageSize);
  }
  // ── writes ──
  if (rest[0] === 'messages' && rest.length >= 2 && method !== 'GET') {
    const m = messages.get(decodeURIComponent(rest[1]));
    if (!m || m.mailbox !== mb.address) return graphErr(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
    if (fault.failOps > 0) {
      fault.failOps -= 1;
      return graphErr(500, 'ErrorInternalServerError', 'An internal server error occurred.');
    }
    if (method === 'PATCH' && rest.length === 2) {
      mutate({ id: m.id, isRead: body?.isRead });
      return { status: 200, body: messageJson(messages.get(m.id)) };
    }
    if (method === 'POST' && rest[2] === 'move') {
      const key = folderKeyOf(mb.address, String(body?.destinationId ?? ''));
      if (!key) return graphErr(400, 'ErrorInvalidIdMalformed', 'Id is malformed.');
      mutate({ id: m.id, folder: key });
      return { status: 201, body: messageJson(messages.get(m.id)) };
    }
    if (method === 'DELETE' && rest.length === 2) {
      remove(m.id);
      return { status: 204, body: undefined };
    }
  }
  if (rest[0] === 'mailFolders' && method !== 'GET') {
    const list = customFolders.get(mb.address) ?? [];
    customFolders.set(mb.address, list);
    const nameTaken = (parent, name) => foldersOf(mb.address).some((f) => (f[2] ?? null) === (parent ?? null) && f[1].toLowerCase() === String(name).toLowerCase());
    if (method === 'POST' && (rest.length === 1 || rest[2] === 'childFolders')) {
      const parent = rest.length === 1 ? null : folderKeyOf(mb.address, decodeURIComponent(rest[1]));
      if (rest.length > 1 && !parent) return graphErr(404, 'ErrorItemNotFound');
      if (nameTaken(parent, body?.displayName)) return graphErr(409, 'ErrorFolderExists', 'A folder with the specified name already exists.');
      const key = `custom${nextFolder++}`;
      list.push([key, String(body?.displayName ?? 'New folder'), parent]);
      return { status: 201, body: folderJson(mb.address, [key, body?.displayName, parent]) };
    }
    const key = folderKeyOf(mb.address, decodeURIComponent(rest[1] ?? ''));
    if (!key) return graphErr(404, 'ErrorItemNotFound');
    const idx = list.findIndex((f) => f[0] === key);
    if (WELL_KNOWN_KEYS.has(key) || idx === -1) {
      if (!WELL_KNOWN_KEYS.has(key) && idx === -1) {
        // a static custom folder (Clients/Acme): promote to editable
        const stat = FOLDERS.find((f) => f[0] === key);
        if (stat) list.push([stat[0], stat[1], stat[2]]);
      } else {
        return graphErr(403, 'ErrorAccessDenied', 'Cannot modify a default folder.');
      }
    }
    const row = list.find((f) => f[0] === key);
    if (method === 'PATCH') {
      if (nameTaken(row[2], body?.displayName)) return graphErr(409, 'ErrorFolderExists', 'A folder with the specified name already exists.');
      row[1] = String(body?.displayName);
      return { status: 200, body: folderJson(mb.address, row) };
    }
    if (method === 'POST' && rest[2] === 'move') {
      row[2] = folderKeyOf(mb.address, String(body?.destinationId ?? '')) ?? 'deleteditems';
      return { status: 201, body: folderJson(mb.address, row) };
    }
    if (method === 'DELETE') {
      customFolders.set(mb.address, list.filter((f) => f[0] !== key && f[2] !== key));
      return { status: 204, body: undefined };
    }
  }
  if (method === 'GET' && rest[0] === 'messages' && rest.length === 2) {
    const m = messages.get(decodeURIComponent(rest[1]));
    return m && m.mailbox === mb.address ? { status: 200, body: messageJson(m) } : graphErr(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
  }
  if (method === 'GET' && rest[0] === 'messages' && rest[2] === 'attachments' && rest.length === 3) {
    const m = messages.get(decodeURIComponent(rest[1]));
    if (!m || m.mailbox !== mb.address) return graphErr(404, 'ErrorItemNotFound');
    return {
      status: 200,
      // Like Graph's list: no bytes, and no contentId (that needs a per-attachment read).
      body: {
        value: m.attachments.map((a) => ({
          '@odata.type': '#microsoft.graph.fileAttachment', id: a.id, name: a.name, contentType: a.contentType, size: a.size, isInline: a.isInline,
        })),
      },
    };
  }
  if (method === 'GET' && rest[0] === 'messages' && rest[2] === 'attachments' && rest[3] && rest.length <= 5) {
    const m = messages.get(decodeURIComponent(rest[1]));
    const a = m?.attachments.find((x) => x.id === decodeURIComponent(rest[3]));
    if (!m || m.mailbox !== mb.address || !a) return graphErr(404, 'ErrorItemNotFound');
    const bytes = Buffer.from(a.bytes ?? Buffer.from(`%PDF-1.4 mock ${a.name}`).toString('base64'), 'base64');
    if (rest[4] === '$value') return { status: 200, raw: bytes, type: a.contentType };
    return {
      status: 200,
      body: {
        '@odata.type': '#microsoft.graph.fileAttachment', id: a.id, name: a.name, contentType: a.contentType, size: a.size,
        isInline: a.isInline, contentId: a.contentId, contentBytes: bytes.toString('base64'),
      },
    };
  }
  return graphErr(400, 'BadRequest', `Mock does not serve ${method} ${url.pathname}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname === '/__mock/state') {
      return send(res, 200, {
        codes: codes.size, access: access.size, refresh: refresh.size, messages: messages.size, seq, fault,
        // clientState is a secret: never echoed, even by the mock.
        subscriptions: [...subs.values()].map((sub) => ({ ...sub, clientState: undefined })),
        deliveries: deliveries.slice(-50), log: log.slice(-80),
      });
    }
    if (url.pathname === '/__mock/fault' && req.method === 'POST') {
      const next = JSON.parse((await readBody(req)) || '{}');
      // revokeAccess: every access token stops working at once (a revoked session).
      if (next.revokeAccess) access.clear();
      delete next.revokeAccess;
      fault = { refresh: null, expireDelta: false, throttle: 0, notifyBadClientState: false, failOps: 0, ...next };
      return send(res, 200, fault);
    }
    if (url.pathname === '/__mock/reset' && req.method === 'POST') {
      messages.clear();
      removals.length = 0;
      subs.clear();
      deliveries.length = 0;
      customFolders.clear();
      fault = { refresh: null, expireDelta: false, throttle: 0, notifyBadClientState: false, failOps: 0 };
      log.length = 0;
      return send(res, 200, { ok: true });
    }
    if (url.pathname === '/__mock/lifecycle' && req.method === 'POST') {
      const { mailbox, event } = JSON.parse(await readBody(req));
      const sent = [];
      for (const sub of subs.values()) {
        if (sub.mailbox !== mailbox || !sub.lifecycleUrl) continue;
        if (event === 'subscriptionRemoved') subs.delete(sub.id);
        const r = await post(sub.lifecycleUrl, { value: [{ subscriptionId: sub.id, clientState: sub.clientState, lifecycleEvent: event, resource: sub.kind }] });
        sent.push(r?.status ?? 0);
      }
      return send(res, 200, { sent });
    }
    if (url.pathname === '/__mock/inspect' && req.method === 'POST') {
      const { id } = JSON.parse(await readBody(req));
      const m = messages.get(id);
      return send(res, 200, m ? { exists: true, folder: m.folder, isRead: m.isRead } : { exists: false });
    }
    if (url.pathname === '/__mock/folders' && req.method === 'POST') {
      const { mailbox } = JSON.parse(await readBody(req));
      return send(res, 200, { folders: foldersOf(mailbox).map(([key, name, parent]) => ({ key, name, parent })) });
    }
    if (url.pathname === '/__mock/message' && req.method === 'POST') return send(res, 200, { id: addMessage(JSON.parse(await readBody(req))) });
    if (url.pathname === '/__mock/update' && req.method === 'POST') return send(res, 200, { ok: mutate(JSON.parse(await readBody(req))) });
    if (url.pathname === '/__mock/delete' && req.method === 'POST') return send(res, 200, { ok: remove(JSON.parse(await readBody(req)).id) });
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
      if (fault.throttle > 0) {
        fault.throttle -= 1;
        log.push(`429 ${url.pathname}`);
        return send(res, 429, { error: { code: 'TooManyRequests', message: 'Application is over its MailboxConcurrency limit.' } }, { 'Retry-After': '2' });
      }
      const pageSize = Number(/odata\.maxpagesize=(\d+)/.exec(prefer)?.[1] ?? 10);
      if (url.pathname === '/v1.0/subscriptions' && req.method === 'POST') {
        const out = await createSubscription(caller, JSON.parse(await readBody(req)));
        log.push(`subscribe ${out.status}`);
        return send(res, out.status, out.body);
      }
      const subMatch = /^\/v1\.0\/subscriptions\/([^/]+)$/.exec(url.pathname);
      if (subMatch) {
        const sub = subs.get(decodeURIComponent(subMatch[1]));
        if (!sub) return send(res, 404, { error: { code: 'ResourceNotFound', message: 'The object was not found.' } });
        if (req.method === 'DELETE') {
          subs.delete(sub.id);
          log.push('unsubscribe');
          return send(res, 204, undefined);
        }
        if (req.method === 'PATCH') {
          sub.expires = JSON.parse(await readBody(req)).expirationDateTime;
          log.push('renew');
          return send(res, 200, { id: sub.id, expirationDateTime: sub.expires });
        }
      }
      if (url.pathname === '/v1.0/$batch' && req.method === 'POST') {
        const { requests = [] } = JSON.parse(await readBody(req));
        if (requests.length > 20) return send(res, 400, { error: { code: 'BadRequest', message: 'More than 20 requests' } });
        const responses = requests.map((r) => {
          const out = graph(caller, r.method, `/v1.0${r.url.startsWith('/') ? '' : '/'}${r.url}`, pageSize, r.body ?? null);
          log.push(`batch:${r.method} ${r.url.split('?')[0]} ${out.status}`);
          return { id: r.id, status: out.status, headers: {}, body: out.body };
        });
        log.push(`batch ${requests.length}`);
        return send(res, 200, { responses });
      }
      const raw = req.method === 'GET' ? '' : await readBody(req);
      const out = graph(caller, req.method, url.pathname + url.search, pageSize, raw ? JSON.parse(raw) : null);
      log.push(`${req.method} ${url.pathname} ${out.status}`);
      if (out.raw) {
        res.writeHead(out.status, { 'Content-Type': out.type ?? 'application/octet-stream', 'Content-Length': out.raw.length });
        return res.end(out.raw);
      }
      return send(res, out.status, out.body);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    send(res, 500, { error: String(e) });
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock Microsoft on http://127.0.0.1:${PORT}`));
