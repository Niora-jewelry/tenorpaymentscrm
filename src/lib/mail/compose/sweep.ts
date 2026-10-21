/**
 * Attachments staged for messages that will never go: older than 7 days and
 * not part of a message still waiting to send (`mail_stale_uploads`).
 * Deleted through the Storage API, which removes the bytes as well as the
 * row. Run from the tick a few times an hour.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { OUTBOX_BUCKET } from './send';

export async function sweepUploads(limit = 200): Promise<number> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.rpc('mail_stale_uploads', { p_limit: limit });
  if (error) throw new Error(`mail_stale_uploads failed: ${error.code ?? 'db'}`);
  const paths = ((data ?? []) as unknown[])
    .map((r) => (typeof r === 'string' ? r : (r as { mail_stale_uploads?: string } | null)?.mail_stale_uploads))
    .filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (let i = 0; i < paths.length; i += 100) {
    const { error: rmErr } = await admin.storage.from(OUTBOX_BUCKET).remove(paths.slice(i, i + 100));
    if (rmErr) throw new Error(`storage remove failed: ${rmErr.message.slice(0, 80)}`);
  }
  return paths.length;
}
