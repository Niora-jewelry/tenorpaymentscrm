/**
 * Returned-application PDFs are staged in `incoming/` for the moment between
 * the browser's upload and the server taking them (see `signedPdfUpload`).
 * One that was never taken — a closed tab, a failed request — is a plain PDF
 * holding SSNs, so it is removed after an hour.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';

const MAX_AGE_MS = 60 * 60 * 1000;

export async function pruneStagedUploads(): Promise<number> {
  const bucket = supabaseAdmin().storage.from('application-pdfs');
  const { data, error } = await bucket.list('incoming', { limit: 1000 });
  if (error || !data) return 0;
  const cutoff = Date.now() - MAX_AGE_MS;
  const stale = data
    .filter((o) => o.name.endsWith('.pdf') && new Date(o.created_at ?? 0).getTime() < cutoff)
    .map((o) => `incoming/${o.name}`);
  if (!stale.length) return 0;
  await bucket.remove(stale);
  return stale.length;
}
