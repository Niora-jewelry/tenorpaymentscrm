/**
 * The Calendar and Chat slice of the mock Microsoft (`mail-mock-graph.mjs` mounts it).
 *
 * One shared world, as in a real tenant: an event the organizer creates appears in each
 * mock attendee's calendar as an invitation, a message one account sends is in the other
 * account's chat, and a file uploaded by one can be downloaded by the others. Strict
 * where Microsoft is strict: only the organizer changes an event, only the author edits
 * a message, only a team owner adds a channel, a new team is not ready for members for
 * a couple of seconds, and the upload host refuses an Authorization header.
 *
 * Hooks (POST JSON):
 *   /__mock/teams-seed    {}            two chats, a group chat with an outside tenant, a
 *                                       meeting chat, a team with a channel, an invitation,
 *                                       a repeating meeting, a private event, older messages
 *   /__mock/teams-message {chatId?, teamId?, channelId?, from, html}   someone else writes
 *   /__mock/teams-event   {organizer, subject, start, end, attendees?, sensitivity?}
 *   /__mock/teams-share   {owner, with}  owner's calendar becomes readable by `with`
 *   /__mock/teams-fault   {uploadLimit?: bytes, chatSendFail?: "message", down?: bool}
 *   GET /__mock/teams     everything, for assertions
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export function createTeamsMock({ PORT, ACCOUNTS, graphErr }) {
  const BASE = `http://127.0.0.1:${PORT}`;
  const byOid = (oid) => Object.entries(ACCOUNTS).find(([, a]) => a.oid === oid)?.[0] ?? null;
  const oidOf = (email) => ACCOUNTS[email]?.oid ?? null;
  const memberOf = (email) => ({ userId: ACCOUNTS[email].oid, displayName: ACCOUNTS[email].name, email, tenantId: ACCOUNTS[email].tid });
  const now = () => new Date().toISOString();
  const id = (p) => `${p}-${randomBytes(6).toString('hex')}`;

  let calEvents = new Map();
  let chats = new Map();
  let teams = new Map();
  let files = new Map();
  let uploads = new Map();
  let shares = new Map(); // owner -> Set(viewer)
  let invites = [];
  let fault = {};

  const reset = () => {
    calEvents = new Map();
    chats = new Map();
    teams = new Map();
    files = new Map();
    uploads = new Map();
    shares = new Map();
    invites = [];
    fault = {};
  };

  /* ── calendar ───────────────────────────────────────────────────────── */

  const calendarsOf = (email) => [
    { id: `cal-${oidOf(email)}`, name: 'Calendar', hexColor: '', isDefaultCalendar: true, canEdit: true, owner: { address: email } },
    { id: `cal-${oidOf(email)}-holidays`, name: 'United States holidays', hexColor: '#0b6b5d', isDefaultCalendar: false, canEdit: false, owner: { address: email } },
  ];
  const wall = (s) => {
    const t = String(s).slice(0, 19);
    return t.length === 16 ? `${t}:00` : t;
  };
  const asGraphTime = (s) => ({ dateTime: `${wall(s)}.0000000`, timeZone: 'mock' });
  const localMs = (s) => new Date(wall(s)).getTime();
  const ymdAdd = (ymd, n) => {
    const d = new Date(`${ymd}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const DOW = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function occurrenceDates(ev, fromMs, toMs) {
    const r = ev.recurrence;
    const out = [];
    const startYmd = r.range.startDate;
    const endYmd = r.range.type === 'endDate' ? r.range.endDate : '2099-12-31';
    const interval = r.pattern.interval || 1;
    for (let i = 0, ymd = startYmd; ymd <= endYmd && i < 1500; i += 1, ymd = ymdAdd(startYmd, i)) {
      const d = new Date(`${ymd}T12:00:00Z`);
      const days = i;
      let hit = false;
      if (r.pattern.type === 'daily') hit = days % interval === 0;
      else if (r.pattern.type === 'weekly') hit = (r.pattern.daysOfWeek ?? []).includes(DOW[d.getUTCDay()]) && Math.floor(days / 7) % interval === 0;
      else if (r.pattern.type === 'absoluteMonthly') hit = d.getUTCDate() === r.pattern.dayOfMonth;
      if (!hit) continue;
      const s = `${ymd}T${wall(ev.start).slice(11)}`;
      if (localMs(s) >= toMs) break;
      const len = localMs(ev.end) - localMs(ev.start);
      const e = new Date(localMs(s) + len);
      const pad = (n) => String(n).padStart(2, '0');
      const endWall = `${e.getFullYear()}-${pad(e.getMonth() + 1)}-${pad(e.getDate())}T${pad(e.getHours())}:${pad(e.getMinutes())}:00`;
      if (localMs(endWall) > fromMs) out.push({ ymd, start: s, end: endWall });
    }
    return out;
  }

  /** What one account sees of an event. */
  function eventFor(email, ev, occ) {
    const organizer = ev.organizer === email;
    const attendee = ev.attendees.find((a) => a.email.toLowerCase() === email);
    const key = occ ? `${ev.id}~${occ.ymd}` : ev.id;
    const over = occ ? (ev.overrides?.[occ.ymd] ?? {}) : {};
    const base = { ...ev, ...over };
    return {
      id: key,
      subject: base.subject,
      bodyPreview: String(base.body ?? '').replace(/<[^>]+>/g, '').slice(0, 100),
      body: { contentType: 'html', content: base.body ?? '' },
      start: asGraphTime(over.start ?? occ?.start ?? ev.start),
      end: asGraphTime(over.end ?? occ?.end ?? ev.end),
      isAllDay: Boolean(base.isAllDay),
      isCancelled: Boolean(base.isCancelled),
      isOrganizer: organizer,
      sensitivity: base.sensitivity ?? 'normal',
      showAs: 'busy',
      type: occ ? (ev.overrides?.[occ.ymd] ? 'exception' : 'occurrence') : ev.recurrence ? 'seriesMaster' : 'singleInstance',
      seriesMasterId: occ ? ev.id : null,
      recurrence: occ ? null : (ev.recurrence ?? null),
      responseStatus: { response: organizer ? 'organizer' : (attendee?.response ?? 'none') },
      organizer: { emailAddress: { name: ACCOUNTS[ev.organizer]?.name ?? ev.organizer, address: ev.organizer } },
      attendees: base.attendees.map((a) => ({ type: 'required', status: { response: a.response ?? 'none' }, emailAddress: { name: a.name ?? a.email, address: a.email } })),
      location: { displayName: base.location ?? '' },
      isOnlineMeeting: Boolean(base.isOnlineMeeting),
      onlineMeeting: base.isOnlineMeeting ? { joinUrl: `https://teams.microsoft.com/l/meetup-join/mock-${ev.id}` } : null,
    };
  }

  const visibleTo = (email, ev, calendarId) => {
    const inMine = ev.organizer === email ? ev.calendarId === calendarId || !calendarId : ev.attendees.some((a) => a.email.toLowerCase() === email) && (!calendarId || calendarId === `cal-${oidOf(email)}`);
    return inMine;
  };

  function calendarView(email, url, calendarId) {
    const fromMs = Date.parse(url.searchParams.get('startDateTime'));
    const toMs = Date.parse(url.searchParams.get('endDateTime'));
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return graphErr(400, 'ErrorInvalidParameter', 'startDateTime and endDateTime are required.');
    const out = [];
    for (const ev of calEvents.values()) {
      if (!visibleTo(email, ev, calendarId)) continue;
      if (ev.organizer === email && ev.isCancelled) continue;
      if (ev.recurrence) {
        for (const occ of occurrenceDates(ev, fromMs, toMs)) {
          if (ev.cancelledDates?.includes(occ.ymd)) continue;
          out.push(eventFor(email, ev, occ));
        }
      } else if (localMs(ev.start) < toMs && localMs(ev.end) > fromMs) {
        out.push(eventFor(email, ev, null));
      }
    }
    out.sort((a, b) => a.start.dateTime.localeCompare(b.start.dateTime));
    return { status: 200, body: { value: out } };
  }

  function findEvent(key) {
    const [mid, ymd] = decodeURIComponent(key).split('~');
    const ev = calEvents.get(mid);
    return ev ? { ev, ymd: ymd ?? null } : null;
  }

  function createEvent(email, calendarId, body) {
    if (calendarId && !calendarsOf(email).some((c) => c.id === calendarId && c.canEdit)) return graphErr(403, 'ErrorAccessDenied', 'You cannot create events on this calendar.');
    if (body.transactionId) {
      const dup = [...calEvents.values()].find((e) => e.transactionId === body.transactionId);
      if (dup) return { status: 201, body: eventFor(email, dup, null) };
    }
    const ev = {
      id: id('ev'),
      transactionId: body.transactionId ?? null,
      calendarId: calendarId ?? `cal-${oidOf(email)}`,
      organizer: email,
      subject: body.subject ?? '',
      body: body.body?.content ?? '',
      start: body.start?.dateTime,
      end: body.end?.dateTime,
      isAllDay: Boolean(body.isAllDay),
      location: body.location?.displayName ?? '',
      isOnlineMeeting: Boolean(body.isOnlineMeeting),
      sensitivity: body.sensitivity ?? 'normal',
      attendees: (body.attendees ?? []).map((a) => ({ email: String(a.emailAddress?.address ?? '').toLowerCase(), name: a.emailAddress?.name, response: 'notResponded' })),
      recurrence: body.recurrence ?? null,
      overrides: {},
      cancelledDates: [],
    };
    calEvents.set(ev.id, ev);
    return { status: 201, body: eventFor(email, ev, null) };
  }

  function eventApi(email, method, rest, url, body) {
    // rest: ['events', id, action?]
    const found = rest[1] ? findEvent(rest[1]) : null;
    if (method === 'POST' && rest.length === 1) return createEvent(email, null, body);
    if (!found || !visibleTo(email, found.ev, null)) return graphErr(404, 'ErrorItemNotFound', 'The specified object was not found in the store.');
    const { ev, ymd } = found;
    const occ = ymd ? { ymd, start: `${ymd}T${wall(ev.start).slice(11)}`, end: `${ymdAdd(ymd, Math.round((localMs(ev.end.slice(0, 10) + 'T12:00:00') - localMs(ev.start.slice(0, 10) + 'T12:00:00')) / 86400000))}T${wall(ev.end).slice(11)}` } : null;
    if (method === 'GET' && rest.length === 2) return { status: 200, body: eventFor(email, ev, occ) };
    if (method === 'GET' && rest[2] === 'calendar') return { status: 200, body: { id: ev.organizer === email ? ev.calendarId : `cal-${oidOf(email)}` } };
    const action = rest[2];
    if (method === 'POST' && ['accept', 'tentativelyAccept', 'decline'].includes(action)) {
      const a = ev.attendees.find((x) => x.email === email);
      if (!a) return graphErr(400, 'ErrorInvalidRequest', 'You are not an attendee of this meeting.');
      a.response = { accept: 'accepted', tentativelyAccept: 'tentativelyAccepted', decline: 'declined' }[action];
      return { status: 202, body: undefined };
    }
    if (ev.organizer !== email) return graphErr(403, 'ErrorAccessDenied', 'Only the organizer can change this meeting.');
    if (method === 'POST' && action === 'cancel') {
      if (ymd) ev.cancelledDates.push(ymd);
      else ev.isCancelled = true;
      return { status: 202, body: undefined };
    }
    if (method === 'PATCH' && rest.length === 2) {
      const patch = {};
      if (body.subject !== undefined) patch.subject = body.subject;
      if (body.body) patch.body = body.body.content;
      if (body.start) patch.start = body.start.dateTime;
      if (body.end) patch.end = body.end.dateTime;
      if (body.location) patch.location = body.location.displayName;
      if (body.isAllDay !== undefined) patch.isAllDay = body.isAllDay;
      if (body.attendees) patch.attendees = body.attendees.map((a) => ({ email: String(a.emailAddress?.address ?? '').toLowerCase(), name: a.emailAddress?.name, response: ev.attendees.find((x) => x.email === String(a.emailAddress?.address ?? '').toLowerCase())?.response ?? 'notResponded' }));
      if (body.isOnlineMeeting) patch.isOnlineMeeting = true;
      if (ymd) {
        ev.overrides[ymd] = { ...(ev.overrides[ymd] ?? {}), ...patch };
      } else {
        Object.assign(ev, patch);
        if ('recurrence' in body) ev.recurrence = body.recurrence;
      }
      return { status: 200, body: eventFor(email, ev, occ) };
    }
    return null;
  }

  /* ── chat ───────────────────────────────────────────────────────────── */

  function messageJson(m, expandReplies) {
    return {
      id: m.id,
      messageType: m.system ? 'systemEventMessage' : 'message',
      createdDateTime: m.createdDateTime,
      lastEditedDateTime: m.lastEditedDateTime ?? null,
      deletedDateTime: m.deletedDateTime ?? null,
      from: m.system ? null : { user: { id: m.from, displayName: ACCOUNTS[byOid(m.from)]?.name ?? 'Someone', userIdentityType: 'aadUser' } },
      body: m.deletedDateTime ? { contentType: 'html', content: '' } : { contentType: m.contentType ?? 'html', content: m.content },
      attachments: m.deletedDateTime ? [] : (m.attachments ?? []),
      mentions: m.mentions ?? [],
      reactions: (m.reactions ?? []).map((r) => ({ reactionType: r.type, createdDateTime: r.at, user: { user: { id: r.user } } })),
      ...(expandReplies ? { replies: (m.replies ?? []).map((r) => messageJson(r, false)) } : {}),
    };
  }

  function newMessage(fromOid, body, path) {
    if (fault.chatSendFail) return graphErr(403, 'Forbidden', fault.chatSendFail);
    let content = String(body?.body?.content ?? '');
    const id = Date.now() + randomBytes(2).toString('hex');
    const hosted = {};
    for (const h of body?.hostedContents ?? []) {
      const temp = String(h['@microsoft.graph.temporaryId'] ?? '');
      const local = '../hostedContents/' + temp + '/$value';
      if (!temp || !content.includes(local)) return graphErr(400, 'BadRequest', 'Each hosted content must be referenced in the message body.');
      if (!/^image\/(png|jpeg|gif)$/.test(String(h.contentType ?? ''))) return graphErr(400, 'BadRequest', 'Unsupported hosted content type.');
      const bytes = Buffer.from(String(h.contentBytes ?? ''), 'base64');
      if (bytes.length === 0) return graphErr(400, 'BadRequest', 'Hosted content is empty.');
      const hcid = 'aWQ9' + randomBytes(9).toString('base64url');
      hosted[hcid] = { bytes, type: h.contentType };
      content = content.split(local).join(BASE + '/v1.0' + path + '/' + encodeURIComponent(id) + '/hostedContents/' + hcid + '/$value');
    }
    if (JSON.stringify(body ?? {}).length > 4 * 1024 * 1024) return graphErr(413, 'RequestEntityTooLarge', 'The request is larger than 4 MB.');
    for (const a of body?.attachments ?? []) {
      if (a.contentType === 'reference' && !content.includes(`<attachment id="${a.id}">`)) return graphErr(400, 'BadRequest', 'Each attachment must be referenced in the message body.');
      if (a.contentType === 'messageReference' && !content.includes(`<attachment id="${a.id}">`)) return graphErr(400, 'BadRequest', 'The quoted message must be referenced in the body.');
    }
    for (const m of body?.mentions ?? []) {
      if (!content.includes(`<at id="${m.id}">`)) return graphErr(400, 'BadRequest', 'A mention must appear in the body.');
    }
    return { id, from: fromOid, createdDateTime: now(), content, contentType: body?.body?.contentType ?? 'html', attachments: body?.attachments ?? [], mentions: body?.mentions ?? [], reactions: [], replies: [], hosted };
  }

  function chatJson(c, oid) {
    const live = c.messages.filter((m) => !m.system);
    const last = live[live.length - 1];
    return {
      id: c.id,
      topic: c.topic ?? null,
      chatType: c.chatType,
      webUrl: `https://teams.microsoft.com/l/chat/${encodeURIComponent(c.id)}/0`,
      viewpoint: { isHidden: false, lastMessageReadDateTime: c.readAt[oid] ?? null },
      members: c.members.map((o) => memberOf(byOid(o))),
      lastMessagePreview: last ? { id: last.id, createdDateTime: last.createdDateTime, isDeleted: Boolean(last.deletedDateTime), body: { contentType: last.contentType ?? 'html', content: last.deletedDateTime ? '' : last.content }, from: { user: { id: last.from } } } : null,
    };
  }

  function messageOps(oid, list, method, rest, body, url, opts) {
    // rest begins at the message id (or is empty for the list).
    if (rest.length === 0) {
      if (method === 'GET') {
        let all = list.filter((m) => !m.system || opts.channel).slice().sort((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));
        const f = url.searchParams.get('$filter') ?? '';
        // As Microsoft documents it: a chat's created date takes `lt` only.
        if (!opts.channel && /createdDateTime gt /.test(f)) return { status: 400, body: { error: { code: 'BadRequest', message: 'Filter not supported.' } } };
        const lt = /createdDateTime lt (\S+)/.exec(f)?.[1];
        if (lt) all = all.filter((m) => m.createdDateTime < lt);
        const top = Number(url.searchParams.get('$top') ?? 20);
        const skip = Number(url.searchParams.get('$skiptoken') ?? 0);
        const page = all.slice(skip, skip + top);
        const more = opts.channel && skip + top < all.length;
        const next = new URL(`${BASE}/v1.0${opts.path}`);
        next.searchParams.set('$top', String(top));
        if (url.searchParams.get('$expand')) next.searchParams.set('$expand', url.searchParams.get('$expand'));
        next.searchParams.set('$skiptoken', String(skip + top));
        return { status: 200, body: { value: page.map((m) => messageJson(m, url.searchParams.get('$expand') === 'replies')), ...(more ? { '@odata.nextLink': next.toString() } : {}) } };
      }
      if (method === 'POST') {
        const m = newMessage(oid, body, opts.path);
        if (m.status) return m;
        list.push(m);
        return { status: 201, body: messageJson(m, false) };
      }
      return null;
    }
    const msg = list.find((m) => m.id === decodeURIComponent(rest[0]));
    if (!msg) return graphErr(404, 'NotFound', 'The message was not found.');
    if (rest[1] === 'replies') {
      if (!opts.channel) return graphErr(400, 'BadRequest', 'Only channel messages have replies.');
      return messageOps(oid, msg.replies, method, rest.slice(2), body, url, { ...opts, path: `${opts.path}/${encodeURIComponent(msg.id)}/replies` });
    }
    if (method === 'GET' && rest.length === 1) return { status: 200, body: messageJson(msg, opts.channel) };
    if (method === 'GET' && rest[1] === 'hostedContents' && rest[3] === '$value') {
      const h = (msg.hosted ?? {})[decodeURIComponent(rest[2] ?? '')];
      if (!h || msg.deletedDateTime) return graphErr(404, 'NotFound', 'The hosted content was not found.');
      return { status: 200, raw: h.bytes, type: h.type };
    }
    if (method === 'PATCH' && rest.length === 1) {
      if (msg.from !== oid) return graphErr(403, 'Forbidden', 'Only the sender can edit this message.');
      msg.content = String(body?.body?.content ?? msg.content);
      msg.lastEditedDateTime = now();
      return { status: 204, body: undefined };
    }
    if (method === 'POST' && rest[1] === 'softDelete') {
      if (msg.from !== oid) return graphErr(403, 'Forbidden', 'Only the sender can delete this message.');
      msg.deletedDateTime = now();
      return { status: 204, body: undefined };
    }
    if (method === 'POST' && (rest[1] === 'setReaction' || rest[1] === 'unsetReaction')) {
      const type = body?.reactionType;
      msg.reactions = msg.reactions.filter((r) => !(r.user === oid && r.type === type));
      if (rest[1] === 'setReaction') msg.reactions.push({ user: oid, type, at: now() });
      return { status: 204, body: undefined };
    }
    return null;
  }

  function chatApi(email, method, parts, url, body) {
    const oid = oidOf(email);
    if (parts.length === 1 && method === 'POST') {
      const members = (body?.members ?? []).map((m) => /users\('([^']+)'\)/.exec(m['user@odata.bind'] ?? '')?.[1]).filter(Boolean);
      if (!members.includes(oid)) return graphErr(400, 'BadRequest', 'The caller must be a member of the chat.');
      if (members.some((m) => !byOid(m))) return graphErr(404, 'NotFound', 'A member was not found.');
      if (body.chatType === 'oneOnOne') {
        const existing = [...chats.values()].find((c) => c.chatType === 'oneOnOne' && c.members.length === 2 && members.every((m) => c.members.includes(m)));
        if (existing) return { status: 200, body: chatJson(existing, oid) };
      }
      const c = { id: `19:${randomBytes(8).toString('hex')}@thread.v2`, chatType: body.chatType, topic: body.topic ?? null, members, messages: [], readAt: {} };
      chats.set(c.id, c);
      return { status: 201, body: chatJson(c, oid) };
    }
    const c = chats.get(decodeURIComponent(parts[1] ?? ''));
    if (!c || !c.members.includes(oid)) return graphErr(404, 'NotFound', 'The chat was not found.');
    if (parts.length === 2 && method === 'GET') return { status: 200, body: chatJson(c, oid) };
    if (parts[2] === 'markChatReadForUser' && method === 'POST') {
      if (body?.user?.id !== oid) return graphErr(403, 'Forbidden', 'You can only mark your own chats read.');
      c.readAt[oid] = now();
      return { status: 204, body: undefined };
    }
    if (parts[2] === 'messages') return messageOps(oid, c.messages, method, parts.slice(3), body, url, { channel: false, path: `/chats/${encodeURIComponent(c.id)}/messages` });
    return null;
  }

  function teamApi(email, method, parts, url, body) {
    const oid = oidOf(email);
    if (parts.length === 1 && method === 'POST') {
      const t = { id: randomUUID(), displayName: body?.displayName ?? 'Team', owners: [oid], members: [oid], readyAt: Date.now() + 2500, channels: [] };
      t.channels.push({ id: `19:${randomBytes(6).toString('hex')}@thread.tacv2`, displayName: 'General', messages: [], driveItem: id('folder') });
      teams.set(t.id, t);
      return { status: 202, body: undefined, headers: { Location: `/teams('${t.id}')/operations('${randomUUID()}')`, 'Content-Location': `/teams('${t.id}')` } };
    }
    const t = teams.get(decodeURIComponent(parts[1] ?? ''));
    if (!t) return graphErr(404, 'NotFound', 'The team was not found.');
    if (Date.now() < t.readyAt) return graphErr(404, 'NotFound', 'The team is still being created.');
    if (!t.members.includes(oid)) return graphErr(403, 'Forbidden', 'You are not a member of this team.');
    if (parts[2] === 'members' && parts[3] === 'add' && method === 'POST') {
      const values = (body?.values ?? []).map((v) => {
        const m = /users\('([^']+)'\)/.exec(v['user@odata.bind'] ?? '')?.[1];
        if (!m || !byOid(m)) return { error: { code: 'NotFound', message: 'User not found' } };
        if (!t.members.includes(m)) t.members.push(m);
        return { userId: m };
      });
      return { status: 200, body: { value: values } };
    }
    if (parts.length === 2 && method === 'GET') return { status: 200, body: { id: t.id, displayName: t.displayName } };
    if (parts[2] !== 'channels') return null;
    if (parts.length === 3) {
      if (method === 'GET') return { status: 200, body: { value: t.channels.map((c) => ({ id: c.id, displayName: c.displayName, webUrl: `https://teams.microsoft.com/l/channel/${encodeURIComponent(c.id)}` })) } };
      if (method === 'POST') {
        if (!t.owners.includes(oid)) return graphErr(403, 'Forbidden', 'Only team owners can add channels.');
        if (t.channels.some((c) => c.displayName.toLowerCase() === String(body?.displayName ?? '').toLowerCase())) return graphErr(409, 'NameAlreadyExists', 'Channel name already existed, please use other name.');
        const c = { id: `19:${randomBytes(6).toString('hex')}@thread.tacv2`, displayName: String(body?.displayName ?? ''), messages: [], driveItem: id('folder') };
        t.channels.push(c);
        return { status: 201, body: { id: c.id, displayName: c.displayName } };
      }
    }
    const ch = t.channels.find((c) => c.id === decodeURIComponent(parts[3] ?? ''));
    if (!ch) return graphErr(404, 'NotFound', 'The channel was not found.');
    if (parts.length === 4 && method === 'GET') return { status: 200, body: { id: ch.id, displayName: ch.displayName, webUrl: `https://teams.microsoft.com/l/channel/${encodeURIComponent(ch.id)}/0` } };
    if (parts[4] === 'members' && method === 'GET') return { status: 200, body: { value: t.members.map((o) => ({ ...memberOf(byOid(o)), roles: t.owners.includes(o) ? ['owner'] : [] })) } };
    if (parts[4] === 'filesFolder' && method === 'GET') return { status: 200, body: { id: ch.driveItem, name: ch.displayName, parentReference: { driveId: `drive-${t.id}` } } };
    if (parts[4] === 'messages') return messageOps(oid, ch.messages, method, parts.slice(5), body, url, { channel: true, path: `/teams/${t.id}/channels/${encodeURIComponent(ch.id)}/messages` });
    return null;
  }

  /* ── files ──────────────────────────────────────────────────────────── */

  function uploadSession(email, name, channel = false) {
    const token = randomBytes(12).toString('hex');
    uploads.set(token, { owner: email, name: decodeURIComponent(name), chunks: [], size: null, channel });
    return { status: 200, body: { uploadUrl: `${BASE}/teams-upload/${token}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() } };
  }

  async function handleUpload(req, res, url, readRaw) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'PUT, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Range, Content-Type' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(body));
    };
    const up = uploads.get(url.pathname.split('/')[2]);
    if (!up) return send(404, { error: { code: 'itemNotFound', message: 'The upload session was not found.' } });
    if (req.headers.authorization) return send(401, { error: { code: 'unauthenticated', message: 'Do not send an Authorization header to the upload URL.' } });
    const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(String(req.headers['content-range'] ?? ''));
    if (!m) return send(400, { error: { code: 'invalidRequest', message: 'Content-Range is required.' } });
    const total = Number(m[3]);
    if (fault.uploadLimit && total > fault.uploadLimit) {
      uploads.delete(url.pathname.split('/')[2]);
      return send(413, { error: { code: 'fileTooLarge', message: `The file is larger than the ${Math.round(fault.uploadLimit / 1024)} KB this organization allows.` } });
    }
    const bytes = await readRaw(req);
    up.chunks.push(bytes);
    const got = up.chunks.reduce((n, c) => n + c.length, 0);
    if (got < total) return send(202, { nextExpectedRanges: [`${got}-`] });
    const fileId = id('file');
    const guid = randomUUID().toUpperCase();
    files.set(fileId, { id: fileId, name: up.name, owner: up.owner, bytes: Buffer.concat(up.chunks), sharedWith: [], channel: up.channel });
    return send(201, { id: fileId, name: up.name, size: total, eTag: `"{${guid}},1"`, webUrl: `${BASE}/files/${fileId}`, parentReference: { driveId: `drive-${oidOf(up.owner)}` } });
  }

  function fileFromShare(shareId) {
    const raw = shareId.replace(/^u!/, '');
    let urlText;
    try {
      urlText = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    } catch {
      return null;
    }
    const m = /\/files\/([^/?#]+)$/.exec(urlText);
    return m ? files.get(m[1]) : null;
  }

  /* ── people ─────────────────────────────────────────────────────────── */

  function people(email, url, kind) {
    const q = (kind === 'people' ? /"(.*)"/.exec(url.searchParams.get('$search') ?? '')?.[1] : /'([^']*)'/.exec(url.searchParams.get('$filter') ?? '')?.[1])?.toLowerCase() ?? '';
    const list = Object.entries(ACCOUNTS)
      .filter(([e, a]) => e !== email && a.tid !== '9188040d-6c67-4c5b-b112-36a304b66dad' && (e.includes(q) || a.name.toLowerCase().includes(q)))
      .map(([e, a]) => (kind === 'people' ? { displayName: a.name, scoredEmailAddresses: [{ address: e }], userPrincipalName: e } : { displayName: a.name, emailAddresses: [{ address: e }] }));
    return { status: 200, body: { value: list } };
  }

  /* ── routing ─────────────────────────────────────────────────────────── */

  /** Null when the path is not Calendar or Chat, so the mail mock answers instead. */
  function handle(email, method, url, body) {
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ''));
    const parts = url.pathname.replace(/^\/v1\.0/, '').split('/').filter(Boolean);
    if (fault.down && /^\/(me\/(calendars|calendar|calendarView|events|chats|joinedTeams|people|contacts|onlineMeetings)|chats|teams|shares|drives)/.test(path)) return graphErr(503, 'ServiceUnavailable', 'Service unavailable.');

    // Uploads: /me/drive/root:/Microsoft Teams Chat Files/{name}:/createUploadSession, and a channel's folder.
    let m = /^\/me\/drive\/root:\/Microsoft Teams Chat Files\/(.+):\/createUploadSession$/.exec(path);
    if (m && method === 'POST') return uploadSession(email, m[1]);
    m = /^\/drives\/([^/]+)\/items\/([^/]+):\/(.+):\/createUploadSession$/.exec(path);
    if (m && method === 'POST') return uploadSession(email, m[3], true);
    m = /^\/me\/drive\/items\/([^/]+)\/invite$/.exec(path);
    if (m && method === 'POST') {
      const f = files.get(m[1]);
      if (!f || f.owner !== email) return graphErr(404, 'itemNotFound', 'The item was not found.');
      if (body?.sendInvitation !== false) return graphErr(400, 'invalidRequest', 'Mock: Teams does not email an invitation for a chat file.');
      f.sharedWith.push(...(body?.recipients ?? []).map((r) => String(r.email).toLowerCase()));
      invites.push({ file: f.id, to: body?.recipients });
      return { status: 200, body: { value: [] } };
    }
    if (parts[0] === 'shares' && parts[2] === 'driveItem' && method === 'GET') {
      const f = fileFromShare(decodeURIComponent(parts[1]));
      if (!f || (f.owner !== email && !f.sharedWith.includes(email) && !f.channel)) return graphErr(404, 'itemNotFound', 'The item was not found or you do not have access.');
      return { status: 200, body: { id: f.id, name: f.name, size: f.bytes.length, '@microsoft.graph.downloadUrl': `${BASE}/files/${f.id}/content` } };
    }

    if (parts[0] === 'chats') return chatApi(email, method, parts, url, body);
    if (parts[0] === 'teams') return teamApi(email, method, parts, url, body);

    if (parts[0] === 'users' && parts[1]) {
      const target = decodeURIComponent(parts[1]).toLowerCase();
      const known = ACCOUNTS[target] ?? Object.values(ACCOUNTS).find((a) => a.oid === target);
      const address = ACCOUNTS[target] ? target : byOid(target);
      if (parts.length === 2 && method === 'GET') {
        if (!known) return graphErr(404, 'Request_ResourceNotFound', `Resource '${target}' does not exist.`);
        return { status: 200, body: { id: known.oid, displayName: known.name, mail: address } };
      }
      if (parts[2] === 'calendar' || parts[2] === 'calendars' || (parts[2] === 'events' && method === 'GET' && parts[3] && findEvent(parts[3]))) {
        if (!known) return graphErr(404, 'ErrorInvalidUser', 'The requested user is invalid.');
        if (address !== email && !shares.get(address)?.has(email)) return graphErr(403, 'ErrorAccessDenied', 'Access is denied. Check credentials and try again.');
        if (parts[2] === 'events') return eventApi(address, 'GET', parts.slice(2), url, body);
        if (parts.length === 3) return { status: 200, body: { id: `cal-${known.oid}` } };
        if (parts[3] === 'calendarView') return calendarView(address, url, null);
        if (parts[2] === 'calendars' && parts[4] === 'calendarView') return calendarView(address, url, decodeURIComponent(parts[3]));
      }
      return null;
    }

    if (parts[0] !== 'me') return null;
    const rest = parts.slice(1);
    if (method === 'GET' && rest[0] === 'calendars' && rest.length === 1) return { status: 200, body: { value: calendarsOf(email) } };
    if (rest[0] === 'calendars' && rest[2] === 'calendarView' && method === 'GET') {
      const cid = decodeURIComponent(rest[1]);
      if (cid.endsWith('-holidays')) return { status: 200, body: { value: [] } };
      return calendarView(email, url, cid);
    }
    if (rest[0] === 'calendars' && rest[2] === 'events' && method === 'POST') return createEvent(email, decodeURIComponent(rest[1]), body);
    if (rest[0] === 'calendar' && rest[1] === 'calendarView') return calendarView(email, url, `cal-${oidOf(email)}`);
    if (rest[0] === 'calendarView' && method === 'GET') return calendarView(email, url, null);
    if (rest[0] === 'events') return eventApi(email, method, rest, url, body);
    if (rest[0] === 'onlineMeetings' && method === 'POST') return { status: 201, body: { id: id('om'), joinWebUrl: `https://teams.microsoft.com/l/meetup-join/mock-now-${randomBytes(4).toString('hex')}` } };
    if (rest[0] === 'people' && method === 'GET') return people(email, url, 'people');
    if (rest[0] === 'contacts' && rest.length === 1 && method === 'GET') return people(email, url, 'contacts');
    if (rest[0] === 'chats' && rest.length === 1 && method === 'GET') {
      const oid = oidOf(email);
      const list = [...chats.values()].filter((c) => c.members.includes(oid)).map((c) => chatJson(c, oid));
      list.sort((a, b) => (b.lastMessagePreview?.createdDateTime ?? '').localeCompare(a.lastMessagePreview?.createdDateTime ?? ''));
      return { status: 200, body: { value: list } };
    }
    if (rest[0] === 'joinedTeams' && method === 'GET') {
      const oid = oidOf(email);
      return { status: 200, body: { value: [...teams.values()].filter((t) => t.members.includes(oid) && Date.now() >= t.readyAt).map((t) => ({ id: t.id, displayName: t.displayName })) } };
    }
    return null;
  }

  /* ── hooks ──────────────────────────────────────────────────────────── */

  const daysAgo = (n, h = 10) => {
    const d = new Date(Date.now() - n * 86400000);
    d.setHours(h, 0, 0, 0);
    return d.toISOString();
  };
  const localWall = (dayOffset, hour, minute = 0) => {
    const d = new Date();
    d.setDate(d.getDate() + dayOffset);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(hour)}:${pad(minute)}:00`;
  };

  /** A 40x30 PNG, light blue with a dark band: big enough to see in the bubble. */
  const SEED_PNG = (() => {
    const w = 40, h = 30;
    const raw = Buffer.alloc((w * 3 + 1) * h);
    for (let y = 0; y < h; y++) {
      raw[y * (w * 3 + 1)] = 0;
      for (let x = 0; x < w; x++) {
        const o = y * (w * 3 + 1) + 1 + x * 3;
        const band = y > 10 && y < 20;
        raw[o] = band ? 16 : 190; raw[o + 1] = band ? 35 : 215; raw[o + 2] = band ? 71 : 245;
      }
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  })();

  function seed() {
    reset();
    const O = oidOf('owner@mock.test');
    const M = oidOf('mate@mock.test');
    const X = oidOf('other@mock.test');
    const msg = (from, content, at, extra = {}) => ({ id: `${Date.parse(at)}${randomBytes(2).toString('hex')}`, from, createdDateTime: at, content, contentType: 'html', attachments: [], mentions: [], reactions: [], replies: [], ...extra });

    const direct = { id: '19:direct-owner-mate@unq.gbl.spaces', chatType: 'oneOnOne', topic: null, members: [O, M], messages: [], readAt: { [O]: daysAgo(0, 0) } };
    direct.messages.push(msg(M, '<p>Older note from a month ago</p>', daysAgo(30)));
    direct.messages.push(msg(M, '<p>Older note from three weeks ago</p>', daysAgo(21)));
    direct.messages.push(msg(O, '<p>Morning! Did the merchant sign?</p>', daysAgo(1, 9)));
    direct.messages.push(msg(M, '<p>Yes, all done. Pricing sheet: <a href="https://example.com/">https://example.com/</a></p>', daysAgo(0, 8), { reactions: [{ user: O, type: 'like', at: daysAgo(0, 8) }] }));
    chats.set(direct.id, direct);

    const group = { id: '19:group-external@thread.v2', chatType: 'group', topic: 'Partner onboarding', members: [O, M, X], messages: [], readAt: {} };
    const pictured = msg(M, '', daysAgo(3));
    pictured.hosted = { aWQ9c2VlZC1waWN0dXJl: { bytes: Buffer.from(SEED_PNG, 'base64'), type: 'image/png' } };
    pictured.content = '<p>Screenshot of the statement:</p><p><img src="' + BASE + '/v1.0/chats/' + encodeURIComponent(group.id) + '/messages/' + pictured.id + '/hostedContents/aWQ9c2VlZC1waWN0dXJl/$value" width="40" height="30" alt="image"></p>';
    group.messages.push(pictured);
    group.messages.push(msg(X, '<p>Hello from the partner side.</p>', daysAgo(2)));
    chats.set(group.id, group);

    const meeting = { id: '19:meeting-weekly@thread.v2', chatType: 'meeting', topic: 'Weekly pipeline review', members: [O, M], messages: [], readAt: { [O]: now() } };
    meeting.messages.push(msg(M, '<p>Agenda is in the invite.</p>', daysAgo(3)));
    chats.set(meeting.id, meeting);

    const team = { id: 'team-sales-0001', displayName: 'Sales', owners: [O], members: [O, M], readyAt: 0, channels: [] };
    const general = { id: '19:general-sales@thread.tacv2', displayName: 'General', messages: [], driveItem: 'folder-sales-general' };
    const post = msg(M, '<p>Welcome to the Sales team.</p>', daysAgo(4));
    post.replies.push(msg(O, '<p>Thanks!</p>', daysAgo(4, 11)));
    general.messages.push(post);
    team.channels.push(general);
    teams.set(team.id, team);

    // Owner is invited by mate; a repeating standup organized by owner; a private event.
    calEvents.set('ev-invite', { id: 'ev-invite', calendarId: `cal-${M}`, organizer: 'mate@mock.test', subject: 'Merchant kickoff', body: '<p>Kickoff with the merchant.</p>', start: localWall(1, 10), end: localWall(1, 11), isOnlineMeeting: true, sensitivity: 'normal', location: '', attendees: [{ email: 'owner@mock.test', name: 'Olive Owner', response: 'notResponded' }], recurrence: null, overrides: {}, cancelledDates: [] });
    const today = localWall(0, 9).slice(0, 10);
    calEvents.set('ev-standup', { id: 'ev-standup', calendarId: `cal-${O}`, organizer: 'owner@mock.test', subject: 'Daily standup', body: '', start: `${ymdAdd(today, -14)}T09:00:00`, end: `${ymdAdd(today, -14)}T09:15:00`, isOnlineMeeting: true, sensitivity: 'normal', location: '', attendees: [{ email: 'mate@mock.test', name: 'Mae Mate', response: 'accepted' }], recurrence: { pattern: { type: 'daily', interval: 1 }, range: { type: 'noEnd', startDate: ymdAdd(today, -14) } }, overrides: {}, cancelledDates: [] });
    calEvents.set('ev-private', { id: 'ev-private', calendarId: `cal-${O}`, organizer: 'owner@mock.test', subject: 'Dentist appointment', body: '<p>Room 12</p>', start: localWall(0, 14), end: localWall(0, 15), isOnlineMeeting: false, sensitivity: 'private', location: 'Dental clinic', attendees: [], recurrence: null, overrides: {}, cancelledDates: [] });
    return { ok: true };
  }

  async function hooks(req, res, url, readBody, send) {
    if (url.pathname.startsWith('/teams-upload/')) {
      await handleUpload(req, res, url, async (r) => {
        const chunks = [];
        for await (const c of r) chunks.push(c);
        return Buffer.concat(chunks);
      });
      return true;
    }
    const fm = /^\/files\/([^/]+)\/content$/.exec(url.pathname);
    if (fm) {
      const f = files.get(fm[1]);
      if (!f) send(res, 404, { error: 'gone' });
      else {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${f.name.replace(/"/g, '')}"` });
        res.end(f.bytes);
      }
      return true;
    }
    if (url.pathname === '/__mock/teams' && req.method === 'GET') {
      send(res, 200, { events: [...calEvents.values()], chats: [...chats.values()], teams: [...teams.values()], files: [...files.values()].map((f) => ({ ...f, bytes: f.bytes.length })), invites, shares: [...shares].map(([k, v]) => [k, [...v]]) });
      return true;
    }
    if (url.pathname === '/__mock/teams-seed' && req.method === 'POST') {
      send(res, 200, seed());
      return true;
    }
    if (url.pathname === '/__mock/teams-fault' && req.method === 'POST') {
      fault = { ...JSON.parse((await readBody(req)) || '{}') };
      send(res, 200, fault);
      return true;
    }
    if (url.pathname === '/__mock/teams-share' && req.method === 'POST') {
      const { owner, with: viewer } = JSON.parse(await readBody(req));
      if (!shares.has(owner)) shares.set(owner, new Set());
      shares.get(owner).add(viewer);
      send(res, 200, { ok: true });
      return true;
    }
    if (url.pathname === '/__mock/teams-event' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const r = createEvent(b.organizer, null, { subject: b.subject, start: { dateTime: b.start }, end: { dateTime: b.end }, attendees: (b.attendees ?? []).map((a) => ({ emailAddress: { address: a } })), sensitivity: b.sensitivity, isOnlineMeeting: b.online });
      send(res, 200, r.body);
      return true;
    }
    if (url.pathname === '/__mock/teams-chat' && req.method === 'POST') {
      // A chat the seed does not have: {chatType, topic, members: [emails], from?, html?}.
      const b = JSON.parse(await readBody(req));
      const c = { id: `19:${randomBytes(8).toString('hex')}@thread.v2`, chatType: b.chatType ?? 'group', topic: b.topic ?? null, members: (b.members ?? []).map(oidOf), messages: [], readAt: {} };
      if (b.html) c.messages.push({ id: `${Date.now()}${randomBytes(2).toString('hex')}`, from: oidOf(b.from), createdDateTime: now(), content: b.html, contentType: 'html', attachments: [], mentions: [], reactions: [], replies: [] });
      chats.set(c.id, c);
      send(res, 200, { id: c.id });
      return true;
    }
    if (url.pathname === '/__mock/teams-soft-delete' && req.method === 'POST') {
      // Someone removes a message in Teams itself: {chatId, messageId}.
      const b = JSON.parse(await readBody(req));
      const m = chats.get(b.chatId)?.messages.find((x) => x.id === b.messageId);
      if (m) m.deletedDateTime = now();
      send(res, 200, { ok: Boolean(m) });
      return true;
    }
    if (url.pathname === '/__mock/teams-message' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req));
      const from = oidOf(b.from);
      const m = { id: `${Date.now()}${randomBytes(2).toString('hex')}`, from, createdDateTime: now(), content: b.html, contentType: 'html', attachments: [], mentions: [], reactions: [], replies: [] };
      if (b.chatId) chats.get(b.chatId)?.messages.push(m);
      else teams.get(b.teamId)?.channels.find((c) => c.id === b.channelId)?.messages.push(m);
      send(res, 200, { id: m.id });
      return true;
    }
    return false;
  }

  return { handle, hooks, reset };
}
