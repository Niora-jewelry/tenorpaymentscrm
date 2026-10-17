import { describe, it, expect } from 'vitest';
import { toMessageRow, needsAttachmentList, meetingType, MESSAGE_SELECT, type GraphMessage } from './messageMap';
import { MAX_STORED_HTML } from '../content/sanitize';

const ctx = { mailboxId: 'mb', mailboxAddress: 'Owner@Mock.test', folderId: 'f-in', folderWellKnown: 'inbox', now: '2026-10-17T10:00:00.000Z' };

const base: GraphMessage = {
  id: 'AAMk-1',
  conversationId: 'conv-1',
  subject: 'Quarterly numbers',
  bodyPreview: '  Hi   team,\n see attached ',
  body: { contentType: 'html', content: '<p>Hi team</p><img src="https://t.example/p.gif"><script>x()</script>' },
  from: { emailAddress: { name: 'Ann Client', address: 'Ann@Client.example' } },
  toRecipients: [{ emailAddress: { name: 'Owner', address: 'owner@mock.test' } }, { emailAddress: { name: '', address: '' } }],
  ccRecipients: null,
  receivedDateTime: '2026-10-16T09:00:00Z',
  isRead: false,
  hasAttachments: true,
};

describe('toMessageRow', () => {
  it('maps, lower-cases addresses, sanitises and bounds', () => {
    const r = toMessageRow(base, ctx);
    expect(r).toMatchObject({
      mailbox_id: 'mb',
      folder_id: 'f-in',
      graph_id: 'AAMk-1',
      from_address: 'ann@client.example',
      from_name: 'Ann Client',
      direction: 'inbound',
      is_read: false,
      has_attachments: true,
      preview: 'Hi team, see attached',
      body_state: 'stored',
      deleted_at: null,
    });
    expect(r.to_recipients).toEqual([{ name: 'Owner', address: 'owner@mock.test' }]);
    expect(r.cc_recipients).toEqual([]);
    expect(r.body_html).not.toContain('<script');
    expect(r.body_html).toContain('data-mail-img="0"');
    expect(r.external_images).toEqual(['https://t.example/p.gif']);
    expect(r.recipients_text).toContain('owner@mock.test');
  });

  it('marks mail from the mailbox itself, drafts, and Sent Items as outbound', () => {
    expect(toMessageRow({ ...base, from: { emailAddress: { address: 'OWNER@mock.test' } } }, ctx).direction).toBe('outbound');
    expect(toMessageRow({ ...base, isDraft: true }, ctx).direction).toBe('outbound');
    expect(toMessageRow(base, { ...ctx, folderWellKnown: 'sentitems' }).direction).toBe('outbound');
  });

  it('does not store an oversized body, keeping the preview as text', () => {
    const r = toMessageRow({ ...base, body: { contentType: 'html', content: 'x'.repeat(MAX_STORED_HTML + 1) } }, ctx);
    expect(r.body_state).toBe('evicted');
    expect(r.body_html).toBeNull();
    expect(r.body_text).toContain('Hi');
  });

  it('caps a 5,000-recipient blast at 500 per field', () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ emailAddress: { address: `u${i}@x.example` } }));
    expect(toMessageRow({ ...base, toRecipients: many }, ctx).to_recipients).toHaveLength(500);
  });

  it('recognises meeting messages', () => {
    expect(meetingType('#microsoft.graph.eventMessageRequest')).toBe('meetingRequest');
    expect(meetingType('#microsoft.graph.message')).toBeNull();
  });
});

describe('needsAttachmentList', () => {
  it('lists for files and for inline cid images Graph does not count', () => {
    expect(needsAttachmentList({ id: '1', hasAttachments: true })).toBe(true);
    expect(needsAttachmentList({ id: '1', hasAttachments: false, body: { content: '<img src="cid:logo@x">' } })).toBe(true);
    expect(needsAttachmentList({ id: '1', hasAttachments: false, body: { content: '<p>none</p>' } })).toBe(false);
  });

  it('selects every field the mapper reads', () => {
    for (const f of ['id', 'body', 'parentFolderId', 'changeKey', 'isRead', 'conversationId']) expect(MESSAGE_SELECT.split(',')).toContain(f);
  });
});
