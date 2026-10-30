/**
 * The signed PDF, fetched from the vendor once an agreement completes and
 * sealed into the record's private bucket (spec §8). A failed fetch retries
 * with a growing gap for about an hour, then tells the sender and leaves a
 * Retry button.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { agreementFileName } from './pdf';
import { kindFor } from './kinds';
import { agrLabel, type AgreementRow } from './store';
import { vendor } from './vendor';
import { VendorError } from './vendor/types';
import { recordForApplication, merchantName } from '@/lib/applications/store';

/** Minutes between attempts: 1, 2, 4, 8, 16, 29 ≈ one hour in all. */
const BACKOFF_MIN = [1, 2, 4, 8, 16, 29];

export async function storeCompletedPdf(agreementId: string): Promise<'stored' | 'retry' | 'failed' | 'skipped'> {
  const { data } = await supabaseAdmin().from('agreements').select('*').eq('id', agreementId).maybeSingle();
  const a = data as AgreementRow | null;
  if (!a || a.status !== 'completed' || !a.vendor_document_id || a.download_status === 'stored') return 'skipped';
  const { storeAgreementFile } = await import('./service');
  try {
    const bytes = await vendor().downloadCompleted(a.vendor_document_id);
    const rec = await recordForApplication(a.record_id);
    const kind = kindFor(a.kind);
    const name = agreementFileName(rec ? merchantName(rec.values, rec.dealName) : 'Merchant', kind?.fileLabel ?? 'Agreement', new Date(a.completed_at ?? Date.now()));
    await storeAgreementFile(a.id, a.record_id, 'completed', name, bytes);
    await supabaseAdmin().from('agreements').update({ download_status: 'stored', next_attempt_at: null, download_note: null }).eq('id', a.id);
    await supabaseAdmin().rpc('agreement_log', { p_agreement: a.id, p_actor: null, p_summary: `Signed PDF saved for ${agrLabel(a.number)}`, p_update_body: null });
    return 'stored';
  } catch (e) {
    const attempts = a.download_attempts + 1;
    const note = e instanceof VendorError ? e.kind : 'error';
    const gap = BACKOFF_MIN[attempts - 1];
    if (gap === undefined) {
      await supabaseAdmin().from('agreements').update({ download_status: 'failed', download_attempts: attempts, next_attempt_at: null, download_note: note }).eq('id', a.id);
      await supabaseAdmin().rpc('agreement_notify', {
        p_agreement: a.id,
        p_body: `The signed PDF for agreement ${agrLabel(a.number)} could not be fetched from the signing service. Open the record and press Retry download.`,
        p_preview: null,
      });
      return 'failed';
    }
    await supabaseAdmin().from('agreements').update({ download_status: 'pending', download_attempts: attempts, next_attempt_at: new Date(Date.now() + gap * 60_000).toISOString(), download_note: note }).eq('id', a.id);
    return 'retry';
  }
}

/** Called from the per-minute tick: every download that is due, within a time budget. */
export async function retryPendingDownloads(budgetMs = 20_000): Promise<{ stored: number; retry: number; failed: number }> {
  const started = Date.now();
  const out = { stored: 0, retry: 0, failed: 0 };
  const { data } = await supabaseAdmin().rpc('agreement_claim_downloads', { p_limit: 5 });
  for (const row of (data ?? []) as AgreementRow[]) {
    if (Date.now() - started > budgetMs) break;
    const r = await storeCompletedPdf(row.id);
    if (r === 'stored') out.stored++;
    else if (r === 'retry') out.retry++;
    else if (r === 'failed') out.failed++;
  }
  return out;
}
