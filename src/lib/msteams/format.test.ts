import { describe, expect, it } from 'vitest';
import {
  awaitsAnswer,
  chatName,
  conversationRefKey,
  countUnanswered,
  dayBefore,
  firstLink,
  fromGraphRecurrence,
  guidFromEtag,
  isExternal,
  isTeamsFileUrl,
  isUnread,
  linkedChatTitle,
  safeHttps,
  shareIdFor,
  thumbsOf,
  toCalEvent,
  toGraphRecurrence,
  weekdayOf,
} from './format';

const privateEvent = {
  id: 'e1',
  subject: 'Doctor',
  bodyPreview: 'Room 4',
  start: { dateTime: '2026-11-05T09:00:00.0000000' },
  end: { dateTime: '2026-11-05T10:00:00.0000000' },
  sensitivity: 'private',
  organizer: { emailAddress: { name: 'Owner', address: 'owner@x.test' } },
  attendees: [{ emailAddress: { name: 'Dr', address: 'dr@x.test' }, status: { response: 'accepted' } }],
  location: { displayName: 'Clinic' },
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/1' },
};

describe('toCalEvent', () => {
  it('shows a private event as "Private" with nothing else to anyone but its owner', () => {
    const seen = toCalEvent(privateEvent, { identityId: 'i', calendarKey: 'c', isOwner: false, readOnly: true })!;
    expect(seen.subject).toBe('Private');
    expect(seen.isPrivate).toBe(true);
    expect(JSON.stringify(seen)).not.toMatch(/Doctor|Room 4|Clinic|dr@x\.test|owner@x\.test|meetup-join/);
    // The time is kept: the slot is still busy.
    expect(seen.start).toBe('2026-11-05T09:00');
  });

  it('shows the owner everything', () => {
    const own = toCalEvent(privateEvent, { identityId: 'i', calendarKey: 'c', isOwner: true, readOnly: false })!;
    expect(own.subject).toBe('Doctor');
    expect(own.joinUrl).toBe('https://teams.microsoft.com/l/meetup-join/1');
  });

  it('never makes a Join button out of anything but https', () => {
    const e = toCalEvent({ ...privateEvent, sensitivity: 'normal', onlineMeeting: { joinUrl: 'javascript:alert(1)' } }, { identityId: 'i', calendarKey: 'c', isOwner: true, readOnly: false })!;
    expect(e.joinUrl).toBeNull();
    expect(safeHttps('http://x.test')).toBeNull();
  });
});

describe('unanswered invitations', () => {
  it('counts only invitations still waiting, not ones organized or cancelled', () => {
    expect(awaitsAnswer({ responseStatus: { response: 'notResponded' } })).toBe(true);
    expect(awaitsAnswer({ responseStatus: { response: 'notResponded' }, isOrganizer: true })).toBe(false);
    expect(awaitsAnswer({ responseStatus: { response: 'notResponded' }, isCancelled: true })).toBe(false);
    expect(awaitsAnswer({ responseStatus: { response: 'accepted' } })).toBe(false);
    expect(awaitsAnswer({ responseStatus: { response: 'none' } })).toBe(false);
  });

  it('counts a repeating meeting once, however many times it occurs', () => {
    const series = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, seriesMasterId: 'm1', responseStatus: { response: 'notResponded' } }));
    expect(countUnanswered([...series, { id: 'single', responseStatus: { response: 'notResponded' } }])).toBe(2);
  });
});

describe('recurrence', () => {
  it('round-trips each preset and a custom pattern', () => {
    expect(toGraphRecurrence({ kind: 'none' }, '2026-11-04')).toBeNull();
    expect(toGraphRecurrence({ kind: 'weekly' }, '2026-11-04')).toMatchObject({ pattern: { type: 'weekly', daysOfWeek: ['wednesday'] }, range: { type: 'noEnd', startDate: '2026-11-04' } });
    expect(toGraphRecurrence({ kind: 'monthly', until: '2027-01-01' }, '2026-11-04')).toMatchObject({ pattern: { type: 'absoluteMonthly', dayOfMonth: 4 }, range: { type: 'endDate', endDate: '2027-01-01' } });
    const custom = toGraphRecurrence({ kind: 'custom', unit: 'week', interval: 2, days: ['monday', 'friday'] }, '2026-11-04');
    expect(fromGraphRecurrence(custom)).toEqual({ kind: 'custom', unit: 'week', interval: 2, days: ['monday', 'friday'], until: undefined });
    expect(fromGraphRecurrence(toGraphRecurrence({ kind: 'daily' }, '2026-11-04'))).toEqual({ kind: 'daily', until: undefined });
  });

  it('ends the old series the day before for "this and following", across a month', () => {
    expect(dayBefore('2026-12-01')).toBe('2026-11-30');
    expect(dayBefore('2027-03-01')).toBe('2027-02-28');
    expect(weekdayOf('2026-11-08')).toBe('sunday');
  });
});

describe('chat', () => {
  it('marks unread only what someone else wrote after the last read', () => {
    expect(isUnread({ lastAt: '2026-11-04T10:00:00Z', lastFromMe: false, readAt: '2026-11-04T09:00:00Z' })).toBe(true);
    expect(isUnread({ lastAt: '2026-11-04T10:00:00Z', lastFromMe: false, readAt: '2026-11-04T11:00:00Z' })).toBe(false);
    expect(isUnread({ lastAt: '2026-11-04T10:00:00Z', lastFromMe: true, readAt: null })).toBe(false);
    expect(isUnread({ lastAt: null, lastFromMe: false, readAt: null })).toBe(false);
  });

  it('calls a chat External only when someone is from another tenant', () => {
    expect(isExternal('AAA', 'aaa')).toBe(false);
    expect(isExternal('bbb', 'aaa')).toBe(true);
    expect(isExternal(null, 'aaa')).toBe(false);
  });

  it('names a chat without a topic after the others in it', () => {
    expect(chatName(null, ['A', 'B'])).toBe('A, B');
    expect(chatName('', ['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C +2');
    expect(chatName('Deal room', ['A'])).toBe('Deal room');
  });

  it('counts only thumbs-up, and knows whether one is mine', () => {
    const r = thumbsOf([{ reactionType: 'like', user: { user: { id: 'me' } } }, { reactionType: '👍', user: { user: { id: 'x' } } }, { reactionType: 'heart', user: { user: { id: 'y' } } }], 'me');
    expect(r).toEqual({ count: 2, mine: true });
  });

  it('finds the first https link for the preview card', () => {
    expect(firstLink('<p>see <a href="https://a.test/x">here</a> https://b.test</p>')).toBe('https://a.test/x');
    expect(firstLink('<p>none http://c.test</p>')).toBeNull();
  });

  it('reads the GUID Teams wants out of a driveItem eTag', () => {
    expect(guidFromEtag('"{0A1B2C3D-1111-2222-3333-444455556666},1"')).toBe('0A1B2C3D-1111-2222-3333-444455556666');
    expect(guidFromEtag('nope')).toBeNull();
  });

  it('only looks up file links of the kind Teams keeps files behind', () => {
    expect(isTeamsFileUrl('https://tenor.sharepoint.com/sites/x/a.pdf')).toBe(true);
    expect(isTeamsFileUrl('https://tenor-my.sharepoint.com/personal/a.pdf')).toBe(true);
    expect(isTeamsFileUrl('https://evil.test/sharepoint.com')).toBe(false);
    expect(isTeamsFileUrl('https://sharepoint.com.evil.test/a')).toBe(false);
    expect(isTeamsFileUrl('http://tenor.sharepoint.com/a')).toBe(false);
    expect(isTeamsFileUrl('http://127.0.0.1:4555/files/a', '127.0.0.1:4555')).toBe(true);
  });

  it('encodes a share id as Graph expects', () => {
    expect(shareIdFor('https://a.test/?x=1')).toBe(`u!${Buffer.from('https://a.test/?x=1').toString('base64url')}`);
  });
});

describe('a conversation linked to a record', () => {
  it('has no account in its reference, so it is one link whoever made it', () => {
    expect(conversationRefKey({ kind: 'chat', chatId: '19:abc' })).toBe('chat|19:abc');
    expect(conversationRefKey({ kind: 'channel', teamId: 't1', channelId: 'c1' })).toBe('channel|t1|c1');
  });

  it('names everyone when a chat has no topic, and is capped to what the column holds', () => {
    expect(linkedChatTitle(null, ['Olive Owner', 'Mae Mate'])).toBe('Olive Owner, Mae Mate');
    expect(linkedChatTitle('  Acme setup ', ['Olive Owner'])).toBe('Acme setup');
    expect(linkedChatTitle('x'.repeat(300), [])).toHaveLength(200);
    expect(linkedChatTitle(null, [])).toBe('Chat');
  });
});
