/**
 * The daily tick's agreement chores: expire what is past its date (spec
 * §8, "on day 30"), and reconcile every open agreement against the vendor
 * in case a webhook never arrived.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { agreementsConfigured, vendor } from './vendor';
import { applyVendorEvent, dedupeKey, eventTypeForStatus } from './webhook';
import { OPEN_STATUSES } from './store';

export async function expireStaleAgreements(): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc('agreement_expire_stale');
  if (error) throw error;
  return (data as number) ?? 0;
}

/** Each open agreement re-read from the vendor; a status we missed is applied. */
export async function reconcileOpenAgreements(budgetMs = 30_000): Promise<{ checked: number; changed: number }> {
  if (!agreementsConfigured) return { checked: 0, changed: 0 };
  const started = Date.now();
  const { data } = await supabaseAdmin().from('agreements').select('id, vendor_document_id, status').in('status', OPEN_STATUSES).not('vendor_document_id', 'is', null).order('sent_at').limit(50);
  let checked = 0;
  let changed = 0;
  for (const a of (data ?? []) as { id: string; vendor_document_id: string }[]) {
    if (Date.now() - started > budgetMs) break;
    checked++;
    let doc;
    try {
      doc = await vendor().get(a.vendor_document_id);
    } catch {
      continue;
    }
    const type = eventTypeForStatus(doc.status);
    if (!type || type === 'document_sent') continue;
    const signer = type === 'document_declined' ? doc.recipients.find((r) => r.status === 'declined')?.email ?? null : type === 'document_bounced' ? doc.recipients.find((r) => r.bounced)?.email ?? null : null;
    const r = await applyVendorEvent({
      type,
      time: new Date(),
      hash: null,
      documentId: a.vendor_document_id,
      agreementIdHint: a.id,
      signerEmail: signer,
      reason: doc.declineMessage,
      source: 'fetch',
      dedupe: dedupeKey(a.vendor_document_id, `reconcile:${type}`, doc.status, signer),
    });
    if (r?.applied) changed++;
  }
  return { checked, changed };
}
