import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: () => ({ rpc: vi.fn() }) }));
vi.mock('./vendor', () => ({ vendor: () => ({}), agreementsConfigured: false, signwellTestMode: true }));
vi.mock('./download', () => ({ storeCompletedPdf: vi.fn() }));

describe('webhook helpers', () => {
  it('maps the vendor status word to the event the database understands', async () => {
    const { eventTypeForStatus } = await import('./webhook');
    expect(eventTypeForStatus('completed')).toBe('document_completed');
    expect(eventTypeForStatus('manually completed')).toBe('document_completed');
    expect(eventTypeForStatus('declined')).toBe('document_declined');
    expect(eventTypeForStatus('expired')).toBe('document_expired');
    expect(eventTypeForStatus('canceled')).toBe('document_canceled');
    expect(eventTypeForStatus('bounced')).toBe('document_bounced');
    expect(eventTypeForStatus('pending')).toBe('document_signed');
    expect(eventTypeForStatus('draft')).toBeNull();
  });

  it('the dedupe key tells two signers apart in the same second', async () => {
    const { dedupeKey } = await import('./webhook');
    expect(dedupeKey('d', 'document_signed', 1, 'a@b.c')).not.toBe(dedupeKey('d', 'document_signed', 1, 'x@y.z'));
    expect(dedupeKey('d', 'document_signed', 1, 'a@b.c')).toBe(dedupeKey('d', 'document_signed', 1, 'a@b.c'));
  });

  it('drops a stale event before touching the database', async () => {
    const { handleVerifiedEvent } = await import('./webhook');
    const old = Math.floor(Date.now() / 1000) - 3600;
    const r = await handleVerifiedEvent({ type: 'document_viewed', time: old, hash: 'h', documentId: 'd', agreementIdHint: null, signer: null, document: null });
    expect(r).toBe('stale');
    expect(await handleVerifiedEvent({ type: 'template_created', time: Math.floor(Date.now() / 1000), hash: 'h', documentId: 'd', agreementIdHint: null, signer: null, document: null })).toBe('ignored');
  });
});
