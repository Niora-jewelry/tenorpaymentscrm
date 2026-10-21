import { describe, it, expect } from 'vitest';
import { isEmail, isUploadHost, likeEscape, parseRecipients, replyRecipients, subjectFor } from './recipients';

const A = (address: string, name = '') => ({ name, address });

describe('parseRecipients', () => {
  it('reads pasted lists in the shapes people paste', () => {
    const r = parseRecipients('Ann Client <Ann@Client.com>, bob@y.io; "Lee, Carol" <c@z.io>\nnot an address, bob@y.io');
    expect(r.valid).toEqual([A('ann@client.com', 'Ann Client'), A('bob@y.io'), A('c@z.io', 'Lee, Carol')]);
    expect(r.invalid).toEqual(['not an address']);
  });
  it('rejects what Exchange would', () => {
    for (const bad of ['a@b', 'a b@c.com', '@c.com', 'a@@c.com', 'x'.repeat(250) + '@c.com']) expect(isEmail(bad), bad).toBe(false);
    expect(isEmail('first.last+tag@sub.example.co.uk')).toBe(true);
  });
});

describe('replyRecipients', () => {
  const src = {
    from: A('ann@client.com', 'Ann'),
    replyTo: [],
    to: [A('me@tapdash.co'), A('ops@client.com')],
    cc: [A('ben@client.com'), A('ME@tapdash.co'), A('ann@client.com')],
    outbound: false,
  };
  it('reply → the sender only', () => {
    expect(replyRecipients(src, 'me@tapdash.co', 'reply')).toEqual({ to: [A('ann@client.com', 'Ann')], cc: [] });
  });
  it('reply all → everyone but me, nobody twice', () => {
    const r = replyRecipients(src, 'me@tapdash.co', 'replyAll');
    expect(r.to.map((a) => a.address)).toEqual(['ann@client.com', 'ops@client.com']);
    expect(r.cc.map((a) => a.address)).toEqual(['ben@client.com']);
  });
  it('honours Reply-To, and replying to my own sent mail goes to its recipients', () => {
    expect(replyRecipients({ ...src, replyTo: [A('desk@client.com')] }, 'me@tapdash.co', 'reply').to).toEqual([A('desk@client.com')]);
    expect(replyRecipients({ ...src, outbound: true, from: A('me@tapdash.co') }, 'me@tapdash.co', 'reply').to.map((a) => a.address)).toEqual(['ops@client.com']);
  });
  it('forward and new start empty', () => {
    expect(replyRecipients(src, 'me@tapdash.co', 'forward')).toEqual({ to: [], cc: [] });
  });
});

describe('subjectFor', () => {
  it('prefixes once, never stacks', () => {
    expect(subjectFor('reply', 'Invoice')).toBe('RE: Invoice');
    expect(subjectFor('replyAll', 'RE: RE: Fw: Invoice')).toBe('RE: Invoice');
    expect(subjectFor('forward', 're: Invoice')).toBe('FW: Invoice');
    expect(subjectFor('new', 'RE: kept')).toBe('RE: kept');
  });
});

describe('isUploadHost', () => {
  it('only Microsoft hosts (or the mock) receive attachment bytes', () => {
    expect(isUploadHost('https://outlook.office.com/api/v2.0/Users/x/Messages/y/AttachmentSessions/z?authtoken=t')).toBe(true);
    expect(isUploadHost('https://outlook.office365.com/upload')).toBe(true);
    expect(isUploadHost('https://evil.example/outlook.office.com')).toBe(false);
    expect(isUploadHost('https://outlook.office.com.evil.example/x')).toBe(false);
    expect(isUploadHost('http://outlook.office.com/x')).toBe(false);
    expect(isUploadHost('http://127.0.0.1:4555/upload/x', 'http://127.0.0.1:4555')).toBe(true);
  });
});

describe('likeEscape', () => {
  it('neutralises LIKE wildcards', () => {
    expect(likeEscape('50%_off\\')).toBe('50\\%\\_off\\\\');
  });
});
