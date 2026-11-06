/**
 * Files on an Update (client, 6 Nov 2026: "Unable to add files").
 *
 * The same idea as a case attachment (`caseAttachments.ts`): an attachment point
 * is an ordinary `file_rows` row, so the five-file cap, the 25MB ceiling, the
 * signed download and the Recycle Bin are the ones every file has. It answers to
 * the Updates tab, and only the update's author or an admin adds to it
 * (`ensure_update_file_row`, migration 9920).
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { recordIdOf, requireTabEdit, requireTabView } from './tabAccess';
import { uploadFile, type FileEntry } from './files';

/** Every file on these updates, by update id, in two queries. */
export async function attachmentsForUpdates(ctx: AuthContext, recordId: string, updateIds: string[]): Promise<Record<string, FileEntry[]>> {
  const out: Record<string, FileEntry[]> = {};
  if (!updateIds.length) return out;
  await requireTabView(ctx, recordId, 'updates');

  const supabase = await createSupabaseServerClient();
  const { data: rows, error: rowError } = await supabase
    .from('file_rows')
    .select('id, update_id')
    .eq('record_id', recordId)
    .eq('kind', 'update_post')
    .is('deleted_at', null);
  if (rowError) throw rowError;
  if (!rows?.length) return out;

  const { data: files, error: fileError } = await supabase
    .from('files')
    .select('*')
    .in('file_row_id', rows.map((r) => r.id))
    .is('deleted_at', null)
    .order('uploaded_at', { ascending: true });
  if (fileError) throw fileError;

  const updateOf = new Map(rows.map((r) => [r.id as string, r.update_id as string]));
  const wanted = new Set(updateIds);
  for (const f of files ?? []) {
    const updateId = updateOf.get(f.file_row_id);
    if (!updateId || !wanted.has(updateId)) continue;
    (out[updateId] ??= []).push({
      id: f.id, fileRowId: f.file_row_id, name: f.name,
      sizeBytes: f.size_bytes, version: f.version, uploadedBy: f.uploaded_by, uploadedAt: f.uploaded_at,
    });
  }
  return out;
}

export async function attachToUpdate(
  ctx: AuthContext,
  updateId: string,
  file: { name: string; bytes: Uint8Array; contentType: string },
): Promise<{ ok: true; file: FileEntry | null } | { ok: false; error: 'too_large' | 'row_full' }> {
  const recordId = await recordIdOf('updates', updateId);
  await requireTabEdit(ctx, recordId, 'updates');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('ensure_update_file_row', { p_update_id: updateId });
  if (error) throw error;

  return uploadFile(ctx, recordId, { id: data as string, kind: 'update_post' }, file);
}
