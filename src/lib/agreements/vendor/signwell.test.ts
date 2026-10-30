import { describe, expect, it, vi } from 'vitest';
import { SignWell, signwellHash } from './signwell';
import { VendorError } from './types';
import type { SendRequest } from './types';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const req: SendRequest = {
  agreementId: 'agr-1',
  recordId: 'rec-1',
  name: 'Maverick merchant agreement — ZZ Pizza',
  fileName: 'ZZ Pizza - Merchant Agreement.pdf',
  pdf: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
  signers: [
    { slot: 1, index: 0, name: 'Jane Doe', first: 'Jane', last: 'Doe', email: 'jane@zz.test', title: 'CEO', percentage: 60 },
    { slot: 2, index: 1, name: 'John Roe', first: 'John', last: 'Roe', email: 'john@zz.test', title: 'CFO', percentage: 40 },
  ],
  spots: [
    { slot: 1, kind: 'signature', page: 4, x: 27, y: 152, w: 136, h: 14, pageWidth: 612, pageHeight: 786 },
    { slot: 1, kind: 'date', page: 4, x: 170, y: 152, w: 134, h: 14, pageWidth: 612, pageHeight: 786 },
    { slot: 2, kind: 'signature', page: 4, x: 310, y: 152, w: 136, h: 13, pageWidth: 612, pageHeight: 786 },
  ],
  subject: 'Your merchant agreement',
  message: 'Please sign.',
  requesterName: 'TapDash',
  requesterEmail: null,
  expiresDays: 30,
  reminders: true,
  testMode: true,
};

describe('SignWell client', () => {
  it('sends the flattened PDF with one recipient per signer and the spots from the top-left', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init! });
      return json(201, { id: 'doc-1', status: 'Sent', recipients: [{ id: 'principal-1', email: 'jane@zz.test', name: 'Jane Doe' }, { id: 'principal-2', email: 'john@zz.test', name: 'John Roe' }] });
    });
    const sw = new SignWell('key', 'wh-1', fetchImpl as unknown as typeof fetch);
    const sent = await sw.send(req);
    expect(sent).toEqual({ documentId: 'doc-1', recipients: [{ slot: 1, vendorId: 'principal-1' }, { slot: 2, vendorId: 'principal-2' }] });
    expect(calls[0]!.url).toBe('https://www.signwell.com/api/v1/documents');
    expect((calls[0]!.init.headers as Record<string, string>)['X-Api-Key']).toBe('key');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.test_mode).toBe(true);
    expect(body.expires_in).toBe(30);
    expect(body.reminders).toBe(true);
    expect(body.allow_decline).toBe(true);
    expect(body.apply_signing_order).toBe(false);
    expect(body.custom_requester_name).toBe('TapDash');
    expect(body.metadata).toEqual({ agreement_id: 'agr-1', record_id: 'rec-1' });
    expect(body.files[0].file_base64).toBe(Buffer.from('%PDF-').toString('base64'));
    expect(body.recipients).toEqual([
      { id: 'principal-1', name: 'Jane Doe', email: 'jane@zz.test' },
      { id: 'principal-2', name: 'John Roe', email: 'john@zz.test' },
    ]);
    // From the top, in CSS pixels: (786 - (152 + 14)) * 4/3 = 827; x 27 pt = 36 px; 136×14 pt = 181×19 px
    expect(body.fields[0][0]).toMatchObject({ type: 'signature', page: 4, x: 36, y: 827, width: 181, height: 19, recipient_id: 'principal-1', required: true });
    expect(body.fields[0][1]).toMatchObject({ type: 'date', lock_sign_date: true, recipient_id: 'principal-1' });
    expect(body.fields[0][2]).toMatchObject({ recipient_id: 'principal-2' });
  });

  it('turns HTTP failures into VendorError kinds, never into vendor text', async () => {
    const sw = (status: number) => new SignWell('key', 'wh', (async () => json(status, { error: 'SSN 123-45-6789 is invalid' })) as unknown as typeof fetch);
    await expect(sw(422).get('d')).rejects.toMatchObject({ kind: 'rejected' });
    await expect(sw(401).get('d')).rejects.toMatchObject({ kind: 'auth' });
    await expect(sw(404).get('d')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(sw(409).cancel('d')).rejects.toMatchObject({ kind: 'conflict' });
    await expect(sw(503).get('d')).rejects.toMatchObject({ kind: 'unreachable' });
    const err = (await sw(422).get('d').catch((e: VendorError) => e)) as VendorError;
    expect(err.message).not.toContain('123-45');
    const down = new SignWell('key', 'wh', (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch);
    await expect(down.get('d')).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('reads a document: status lower-cased, recipients with bounced flags', async () => {
    const sw = new SignWell('key', 'wh', (async () => json(200, { id: 'd', status: 'Bounced', decline_message: null, metadata: { agreement_id: 'agr-1' }, recipients: [{ id: 'r1', email: 'a@b.c', name: 'A', status: 'sent', bounced: true }] })) as unknown as typeof fetch);
    expect(await sw.get('d')).toEqual({ documentId: 'd', status: 'bounced', declineMessage: null, metadata: { agreement_id: 'agr-1' }, recipients: [{ vendorId: 'r1', email: 'a@b.c', name: 'A', status: 'sent', bounced: true }] });
  });

  it('verifies a webhook by its hash and rejects a forged one', () => {
    const sw = new SignWell('key', 'webhook-id');
    const time = 1689332249;
    const good = { event: { type: 'document_signed', time, hash: signwellHash('webhook-id', 'document_signed', time), related_signer: { email: 'jane@zz.test', name: 'Jane Doe' } }, data: { object: { id: 'doc-1', status: 'Pending', metadata: { agreement_id: 'agr-1' }, recipients: [] } } };
    const ev = sw.verifyWebhook(JSON.stringify(good));
    expect(ev).toMatchObject({ type: 'document_signed', time, documentId: 'doc-1', agreementIdHint: 'agr-1', signer: { email: 'jane@zz.test', name: 'Jane Doe' } });
    expect(ev?.document?.status).toBe('pending');
    expect(sw.verifyWebhook(JSON.stringify({ ...good, event: { ...good.event, hash: 'nope' } }))).toBeNull();
    // Two hooks on one URL: an event signed by either verifies.
    const two = new SignWell('key', 'other-id, webhook-id');
    expect(two.verifyWebhook(JSON.stringify(good))?.documentId).toBe('doc-1');
    expect(new SignWell('key', 'other-id').verifyWebhook(JSON.stringify(good))).toBeNull();
    expect(sw.verifyWebhook(JSON.stringify({ ...good, event: { ...good.event, type: 'document_completed' } }))).toBeNull();
    expect(sw.verifyWebhook('not json')).toBeNull();
  });

  it('downloads the completed PDF only when it is a PDF', async () => {
    const ok = new SignWell('key', 'wh', (async () => new Response(Buffer.from('%PDF-1.7 signed'), { status: 200 })) as unknown as typeof fetch);
    expect(Buffer.from(await ok.downloadCompleted('d')).toString('latin1')).toContain('%PDF-');
    const html = new SignWell('key', 'wh', (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch);
    await expect(html.downloadCompleted('d')).rejects.toMatchObject({ kind: 'unreachable' });
  });
});
