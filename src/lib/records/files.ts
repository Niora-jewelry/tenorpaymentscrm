/**
 * Files. Two subtabs (Application locked rows, Other free-form), 5 files per
 * row, 25MB each, replacement keeps the prior version. The bytes go to
 * Supabase Storage first (migration 15's `records` bucket, RLS on the path);
 * `record_file_upload`/`delete_file` (migration 13) record the metadata row
 * and its history entry together once the upload itself has succeeded — the
 * two steps cannot be one database transaction (the upload isn't a database
 * operation at all), so this is as atomic as the operation can actually be.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { requireTabEdit, requireTabEditVia } from './tabAccess';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_ROW = 5;

/** The 5 locked rows every record's Application Files subtab has —
 * "defined as a system structure," per the prototype's own framing, not
 * something a user adds or removes. */
const APPLICATION_ROWS = ['Owner ID', 'Bank statements', 'Processing statements', 'Corp docs', 'Voided check'] as const;

export type FileRow = {
  id: string;
  recordId: string;
  kind: 'application' | 'other';
  name: string;
  locked: boolean;
  note: string | null;
  position: number;
};

export type FileEntry = {
  id: string;
  fileRowId: string;
  storagePath: string;
  name: string;
  sizeBytes: number;
  version: number;
  uploadedBy: string;
  uploadedAt: string;
};

function mapFileRow(r: Record<string, unknown>): FileRow {
  return {
    id: r.id as string, recordId: r.record_id as string, kind: r.kind as 'application' | 'other',
    name: r.name as string, locked: r.locked as boolean, note: (r.note as string | null) ?? null,
    position: r.position as number,
  };
}

function mapFile(r: Record<string, unknown>): FileEntry {
  return {
    id: r.id as string, fileRowId: r.file_row_id as string, storagePath: r.storage_path as string,
    name: r.name as string, sizeBytes: r.size_bytes as number, version: r.version as number,
    uploadedBy: r.uploaded_by as string, uploadedAt: r.uploaded_at as string,
  };
}

export async function fileRowsFor(
  _ctx: AuthContext,
  recordId: string,
  kind: 'application' | 'other',
): Promise<FileRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('file_rows')
    .select('*')
    .eq('record_id', recordId)
    .eq('kind', kind)
    .is('deleted_at', null)
    .order('position');
  if (error) throw error;
  return (data ?? []).map(mapFileRow);
}

export async function filesFor(_ctx: AuthContext, fileRowId: string): Promise<FileEntry[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .eq('file_row_id', fileRowId)
    .is('deleted_at', null)
    .order('uploaded_at', { ascending: false });
  if (error) throw error;
  return (data ?? []).map(mapFile);
}

/**
 * Every file under a SET of rows, grouped by row, in one query.
 *
 * The drawer needs exactly this and used to build it by mapping `filesFor`
 * over each row — never fewer than 5 queries, because `ensureApplicationRows`
 * guarantees the 5 locked Application rows exist, plus one more per "other"
 * row. `.in()` collapses that to one. Every row id asked for is present in the
 * result, mapped to an empty array if it has no files, so callers can index
 * without a null check.
 *
 * Ordering matches `filesFor` exactly (newest upload first) — the version
 * history in the Files tab reads top-down and would silently invert otherwise.
 */
export async function filesForRows(
  _ctx: AuthContext,
  fileRowIds: string[],
): Promise<Record<string, FileEntry[]>> {
  const out: Record<string, FileEntry[]> = {};
  for (const id of fileRowIds) out[id] = [];
  if (!fileRowIds.length) return out;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('files')
    .select('*')
    .in('file_row_id', fileRowIds)
    .is('deleted_at', null)
    .order('uploaded_at', { ascending: false });
  if (error) throw error;

  for (const row of data ?? []) {
    const entry = mapFile(row);
    (out[row.file_row_id as string] ??= []).push(entry);
  }
  return out;
}

/**
 * Creates any of the 5 locked Application rows this record doesn't have yet.
 * Lazy rather than seeded at record-creation time — the row structure is a
 * system default the Files tab itself is responsible for, so a record
 * created before this code existed still gets them the first time its Files
 * tab is opened, with no backfill migration needed.
 */
export async function ensureApplicationRows(_ctx: AuthContext, recordId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();

  // One statement, down from a SELECT plus a conditional INSERT.
  //
  // The old pair was not just two round trips on every single drawer open — it
  // was also a read-then-write with nothing between the halves, so two requests
  // opening the same new record at once both saw zero rows and both inserted
  // all five, producing ten locked rows that the Files tab rendered twice.
  //
  // The first attempt at a fix was a PostgREST `.upsert(..., { onConflict })`
  // against the partial unique index from migration 43. That could never work:
  // Postgres will only infer a PARTIAL index as an ON CONFLICT target if the
  // statement repeats the index predicate, and PostgREST's `on_conflict` can
  // only send column names. Every first-open of a record failed outright with
  // 42P10. The predicate has to be written in SQL, which is what migration 44's
  // `ensure_application_file_rows` does — and because ON CONFLICT DO NOTHING is
  // evaluated per row, a request that loses the race on two names still inserts
  // the other three, rather than a statement-level "ignore" abandoning them.
  //
  // SECURITY INVOKER, so the `file_rows_all` RLS policy still authorises this
  // exactly as it did when the insert came from here.
  const { error } = await supabase.rpc('ensure_application_file_rows', {
    p_record_id: recordId,
    // `APPLICATION_ROWS` stays the one definition of the five rows and their
    // order; the function is deliberately given the list rather than repeating
    // it, so there is no second copy to drift.
    p_names: [...APPLICATION_ROWS],
    p_positions: APPLICATION_ROWS.map((_, i) => i * 10),
  });
  if (error) throw error;
}

export async function addOtherFileRow(ctx: AuthContext, recordId: string, name: string): Promise<FileRow> {
  await requireTabEdit(ctx, recordId, 'files');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('file_rows')
    .insert({ record_id: recordId, kind: 'other', name, locked: false })
    .select('*')
    .single();
  if (error) throw error;
  return mapFileRow(data);
}

/**
 * Uploads to Storage, then records the metadata row + activity entry as one
 * transaction. "Replacement keeps the prior version" — this never deletes an
 * existing file, it only adds a new one; the row's file LIST is the version
 * history, ordered by `uploaded_at desc`.
 */
export async function uploadFile(
  ctx: AuthContext,
  recordId: string,
  /**
   * `kind` decides two things: the storage path prefix, and WHICH TAB'S GRANT
   * is checked. A case attachment (migration 60) is an ordinary file under an
   * ordinary file row, but it lives in the Cases tab and is governed by the
   * Cases grant — checking `files` for it would let the Files tab's permission
   * decide who can attach to a case, which is a different question with a
   * different answer.
   */
  fileRow: { id: string; kind: 'application' | 'other' | 'case' },
  file: { name: string; bytes: Uint8Array; contentType: string },
): Promise<{ ok: true; file: FileEntry } | { ok: false; error: 'too_large' | 'row_full' }> {
  await requireTabEdit(ctx, recordId, fileRow.kind === 'case' ? 'cases' : 'files');
  if (file.bytes.byteLength > MAX_FILE_BYTES) return { ok: false, error: 'too_large' };

  const existing = await filesFor(ctx, fileRow.id);
  if (existing.length >= MAX_FILES_PER_ROW) return { ok: false, error: 'row_full' };

  const supabase = await createSupabaseServerClient();
  const path = `${recordId}/${fileRow.kind}/${fileRow.id}/${Date.now()}-${file.name}`;

  const { error: uploadError } = await supabase.storage.from('records').upload(path, file.bytes, {
    contentType: file.contentType,
    upsert: false,
  });
  if (uploadError) throw uploadError;

  const { data, error } = await supabase
    .rpc('record_file_upload', {
      p_file_row_id: fileRow.id,
      p_storage_path: path,
      p_name: file.name,
      p_size_bytes: file.bytes.byteLength,
    })
    .single();
  if (error) throw error;

  const fileId = data as string;
  const [entry] = (await filesFor(ctx, fileRow.id)).filter((f) => f.id === fileId);
  return { ok: true, file: entry! };
}

export async function deleteFile(ctx: AuthContext, fileId: string): Promise<void> {
  await requireTabEditVia(ctx, 'files', fileId, 'files', 'file_row_id');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_file', { p_file_id: fileId });
  if (error) throw error;
}

/** Short-TTL signed URL — files are never public, never a bare storage path
 * sent to the browser without going through this. */
export async function signedUrlFor(_ctx: AuthContext, storagePath: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.storage.from('records').createSignedUrl(storagePath, 60);
  if (error) throw error;
  return data.signedUrl;
}
