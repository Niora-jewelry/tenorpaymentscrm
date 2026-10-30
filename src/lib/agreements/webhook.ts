/**
 * SignWell's webhook, applied. The body is verified by its hash (type and
 * time only — SignWell signs nothing else), so:
 *
 *   · an event older than 15 minutes is dropped (a bounded replay window);
 *   · the dedupe key (document + type + time + signer) makes a repeat a
 *     no-op in the database;
 *   · a TERMINAL event (completed, declined, expired, canceled, bounced) is
 *     applied from the document as the API returns it, not from the posted
 *     body, so a forged body cannot complete or decline an agreement.
 *
 * `agreement_apply_event` does the rest in one transaction: status, signer
 * status, activity, the Updates post, the sender's notification.
 */
import 'server-only';
import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { storeCompletedPdf } from './download';
import { vendor } from './vendor';
import type { VendorDocument, VerifiedEvent } from './vendor/types';

const SKEW_SECONDS = 15 * 60;
const TERMINAL = new Set(['document_completed', 'document_declined', 'document_expired', 'document_canceled', 'document_bounced']);

/** The vendor's document status, as an event type `agreement_apply_event` understands. */
export function eventTypeForStatus(status: string): string | null {
  switch (status) {
    case 'completed':
    case 'manually completed':
      return 'document_completed';
    case 'declined':
      return 'document_declined';
    case 'expired':
      return 'document_expired';
    case 'canceled':
      return 'document_canceled';
    case 'bounced':
      return 'document_bounced';
    case 'viewed':
      return 'document_viewed';
    case 'pending':
      return 'document_signed';
    case 'sent':
      return 'document_sent';
    default:
      return null;
  }
}

export const dedupeKey = (documentId: string, type: string, time: number | string, signer: string | null) =>
  createHash('sha256').update(`${documentId}|${type}|${time}|${signer ?? ''}`).digest('hex');

export type ApplyResult = { applied: boolean; agreement_id: string; record_id: string; status_after: string; completed_now: boolean };

export async function applyVendorEvent(input: {
  type: string;
  time: Date;
  hash: string | null;
  documentId: string;
  agreementIdHint: string | null;
  signerEmail: string | null;
  reason: string | null;
  source: 'webhook' | 'fetch' | 'housekeeping';
  dedupe: string;
}): Promise<ApplyResult | null> {
  const { data, error } = await supabaseAdmin().rpc('agreement_apply_event', {
    p_vendor: 'signwell',
    p_vendor_document_id: input.documentId,
    p_agreement_hint: input.agreementIdHint,
    p_dedupe_key: input.dedupe,
    p_event_type: input.type,
    p_event_time: input.time.toISOString(),
    p_event_hash: input.hash,
    p_signer_email: input.signerEmail,
    p_reason: input.reason,
    p_source: input.source,
  });
  if (error) {
    if (error.code === 'P0002') return null; // not one of ours
    throw error;
  }
  const row = (Array.isArray(data) ? data[0] : data) as ApplyResult | undefined;
  if (!row) return null;
  if (row.completed_now) await storeCompletedPdf(row.agreement_id).catch(() => undefined);
  return row;
}

/** A verified webhook, applied. Returns what happened, for the log line only. */
export async function handleVerifiedEvent(ev: VerifiedEvent, now = new Date()): Promise<'applied' | 'replay' | 'stale' | 'unknown' | 'ignored'> {
  if (!Number.isFinite(ev.time) || Math.abs(now.getTime() / 1000 - ev.time) > SKEW_SECONDS) return 'stale';
  if (ev.type.startsWith('template_') || ev.type.startsWith('document_sms') || ev.type === 'document_created' || ev.type === 'document_error' || ev.type === 'document_in_progress' || ev.type === 'document_recipients_updated') return 'ignored';

  let signerEmail = ev.signer?.email ?? null;
  let reason: string | null = null;
  let type = ev.type;
  if (TERMINAL.has(ev.type)) {
    // The API's word, not the body's.
    let doc: VendorDocument;
    try {
      doc = await vendor().get(ev.documentId);
    } catch {
      return 'ignored';
    }
    const fromStatus = eventTypeForStatus(doc.status);
    if (ev.type === 'document_bounced') {
      const bounced = doc.recipients.find((r) => r.bounced);
      signerEmail = bounced?.email ?? signerEmail;
    } else if (fromStatus !== ev.type) {
      // The document is not in the state the webhook claims: apply what it IS.
      if (!fromStatus || !TERMINAL.has(fromStatus)) return 'ignored';
      type = fromStatus;
    }
    reason = doc.declineMessage;
    if (type === 'document_declined' && !signerEmail) signerEmail = doc.recipients.find((r) => r.status === 'declined')?.email ?? null;
  }

  const r = await applyVendorEvent({
    type,
    time: new Date(ev.time * 1000),
    hash: ev.hash,
    documentId: ev.documentId,
    agreementIdHint: ev.agreementIdHint,
    signerEmail,
    reason,
    source: 'webhook',
    dedupe: dedupeKey(ev.documentId, ev.type, ev.time, ev.signer?.email ?? null),
  });
  if (!r) return 'unknown';
  return r.applied ? 'applied' : 'replay';
}
