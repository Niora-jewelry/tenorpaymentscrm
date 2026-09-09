/**
 * Statements. Month grid, July 2024 → December 2032, global `statement_periods`
 * (~102 rows, seeded once) with files created lazily per record per period —
 * extending a year is 12 inserts into the global table, not 12 × every record.
 * One dataset, rendered in both Records List and Residuals.
 *
 * Upload/delete go through `statement_file_upload`/`delete_statement_file`
 * (migration 25/26) rather than a raw table write — the same combined
 * write+activity-log RPC shape `files.ts` uses for `record_file_upload`/
 * `delete_file`, so a statement upload shows up in the record's activity log
 * exactly like every other mutation does.
 */
import 'server-only';
import { unstable_cache } from 'next/cache';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from './permissions';
import { requireTabEdit, requireTabEditVia } from './tabAccess';

export type StatementPeriod = { id: string; year: number; month: number };
export type StatementFile = {
  id: string;
  recordId: string;
  periodId: string;
  storagePath: string;
  name: string;
  sizeBytes: number;
  uploadedBy: string;
  uploadedAt: string;
};

/**
 * Global lookup, no per-user scoping — takes no context, and that is exactly
 * what makes it safe to cache ACROSS requests and users the way `loadConfig`
 * is. These ~102 rows are a seeded calendar (July 2024 → December 2032); they
 * change only when someone extends the range by a year, which is 12 inserts
 * run by hand. Fetching them fresh on every drawer open was a full round trip
 * per open for data that had not changed since the seed.
 *
 * `unstable_cache` needs a client that reads no request state — `cookies()`
 * cannot be read inside it — so this uses the service-role client. That is not
 * a widening of access: the table has no per-user dimension to filter on, and
 * every caller has already been through `authorize()`. Same reasoning, spelled
 * out at length, in `config.ts`'s header.
 *
 * ⚠️ TAGGED, AND THE TAG IS LOAD-BEARING.
 *
 * This used to be an hour with no tag, on the stated grounds that "nothing in
 * the app writes `statement_periods`". That stopped being true when Admin →
 * Presets → Statements gained the Add-a-year control (Modules Amendment 4,
 * migration 56). Without the tag an admin adds 2033, the rows land, the
 * database is correct, and the year selector in every drawer keeps saying 2032
 * for up to an hour — a write that appears to have done nothing, which is the
 * exact failure `CONFIG_CACHE_TAG` exists to prevent one table over.
 *
 * The hour stays as a floor for anything that changes the table outside the
 * app (a hand-run SQL extension), which is what the original note was really
 * covering.
 */
/**
 * The tag `allPeriods` is cached under, and the one thing that must invalidate
 * it. Exported rather than repeated as a bare string for the reason
 * `CONFIG_CACHE_TAG` is: a typo'd tag makes the write succeed and never appear.
 */
export const STATEMENT_PERIODS_TAG = 'statement-periods';

export const allPeriods = unstable_cache(
  async (): Promise<StatementPeriod[]> => {
    const { data, error } = await supabaseAdmin()
      .from('statement_periods')
      .select('id, year, month')
      .order('year')
      .order('month');
    if (error) throw error;
    return data ?? [];
  },
  ['statement-periods'],
  { revalidate: 3600, tags: [STATEMENT_PERIODS_TAG] },
);

export async function filesForRecord(_ctx: AuthContext, recordId: string): Promise<StatementFile[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('statement_files')
    .select('*')
    .eq('record_id', recordId)
    .is('deleted_at', null);
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id, recordId: r.record_id, periodId: r.period_id, storagePath: r.storage_path,
    name: r.name, sizeBytes: r.size_bytes, uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at,
  }));
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;

export async function uploadStatement(
  ctx: AuthContext,
  recordId: string,
  period: { id: string; year: number; month: number },
  file: { name: string; bytes: Uint8Array; contentType: string },
): Promise<{ ok: true; file: StatementFile } | { ok: false; error: 'too_large' }> {
  await requireTabEdit(ctx, recordId, 'statements');
  if (file.bytes.byteLength > MAX_FILE_BYTES) return { ok: false, error: 'too_large' };

  const supabase = await createSupabaseServerClient();
  const yyyymm = `${period.year}-${String(period.month).padStart(2, '0')}`;
  const path = `${recordId}/statements/${yyyymm}/${Date.now()}-${file.name}`;

  const { error: uploadError } = await supabase.storage.from('records').upload(path, file.bytes, {
    contentType: file.contentType,
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .rpc('statement_file_upload', {
      p_record_id: recordId,
      p_period_id: period.id,
      p_storage_path: path,
      p_name: file.name,
      p_size_bytes: file.bytes.byteLength,
    })
    .single();
  if (error) throw error;

  const fileId = data as string;
  const [entry] = (await filesForRecord(ctx, recordId)).filter((f) => f.id === fileId);
  return { ok: true, file: entry! };
}

export async function deleteStatement(ctx: AuthContext, statementFileId: string): Promise<void> {
  await requireTabEditVia(ctx, 'statement_files', statementFileId, 'statements');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_statement_file', { p_file_id: statementFileId });
  if (error) throw error;
}

export async function signedStatementUrlFor(_ctx: AuthContext, storagePath: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage.from('records').createSignedUrl(storagePath, 60);
  if (error) throw error;
  return data.signedUrl;
}
