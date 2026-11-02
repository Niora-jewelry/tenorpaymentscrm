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
import { supabaseAdmin } from '@/lib/supabase/admin';
import { requireTabAdd, requireTabEdit, requireTabEditVia, requireTabView } from './tabAccess';
import { APPLICATION_ROWS } from './fileRowNames';

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES_PER_ROW = 5;

export { APPLICATION_ROWS } from './fileRowNames';

/** Which section of the Files tab a row belongs to. */
export type FileRowKind = 'application' | 'other';

export type FileRow = {
  id: string;
  recordId: string;
  kind: FileRowKind;
  name: string;
  locked: boolean;
  note: string | null;
  position: number;
  required: boolean;
  /** 1 to 5, kept while a row is unticked, so ticking it again starts there. */
  filesNeeded: number;
  /** Required, and holding at least `filesNeeded` files. */
  received: boolean;
};

export type FileEntry = {
  id: string;
  fileRowId: string;
  name: string;
  sizeBytes: number;
  version: number;
  uploadedBy: string;
  uploadedAt: string;
};

/** All an Add only viewer gets of the Files tab. `hasFile` is only ever true on
 *  a preset row. */
export type FileRowForAdding = { id: string; kind: FileRowKind; name: string; hasFile: boolean; canSee: boolean };

function mapFileRow(r: Record<string, unknown>): FileRow {
  return {
    id: r.id as string, recordId: r.record_id as string, kind: r.kind as 'application' | 'other',
    name: r.name as string, locked: r.locked as boolean, note: (r.note as string | null) ?? null,
    position: r.position as number,
    required: r.required === true,
    filesNeeded: (r.files_needed as number | null) ?? 1,
    received: r.received === true,
  };
}

function mapFile(r: Record<string, unknown>): FileEntry {
  return {
    id: r.id as string, fileRowId: r.file_row_id as string, 
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

/** The Files tab for someone on Add only. Makes the preset rows if this is the
 *  record's first open, as `ensureApplicationRows` does for an editor. */
export async function fileRowsForAdding(_ctx: AuthContext, recordId: string): Promise<FileRowForAdding[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('file_rows_for_adding', {
    p_record: recordId,
    p_names: [...APPLICATION_ROWS],
    p_positions: APPLICATION_ROWS.map((_, i) => i * 10),
  });
  if (error) throw error;
  return ((data ?? []) as { row_id: string; row_name: string; row_kind: FileRowKind; has_file: boolean; can_see: boolean }[]).map((r) => ({
    id: r.row_id, kind: r.row_kind, name: r.row_name, hasFile: r.has_file, canSee: r.can_see,
  }));
}

/**
 * Adds a file row to either section.
 *
 * ── WHY `kind` IS A PARAMETER NOW ────────────────────────────────────────
 * This was `addOtherFileRow` with `kind: 'other'` written into the insert, so
 * the Application section could only ever hold the five rows
 * `ensureApplicationRows` seeds. The client asked for another row there, and
 * there was no way to add one.
 *
 * ── `locked` IS NOT THE SAME CLAIM AS `kind` ─────────────────────────────
 * The seeded Application rows are locked because they ARE the system
 * structure — a fixed checklist whose names other people rely on. A row
 * somebody adds afterwards is an ordinary row that happens to live in the
 * Application section, so it is unlocked: it did not come from the structure
 * and nothing is keyed to its name.
 *
 * Writing `locked: true` here instead would have been the easy way to make a
 * new row look like its neighbours, and it would have quietly made a
 * user's own typo permanent.
 */
export async function addFileRow(
  ctx: AuthContext,
  recordId: string,
  name: string,
  kind: FileRowKind = 'other',
): Promise<void> {
  await requireTabAdd(ctx, recordId, 'files');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('add_file_row', { p_record: recordId, p_name: name, p_kind: kind });
  if (error) throw error;
}

/**
 * Every upload to the Files tab. Someone on Add only, or adding under a lock or a
 * hide, may not be able to read the row, and Storage reads a new object back to
 * write it, so the bytes go in with the service role once the row has been
 * checked. `record_file_upload` is still called as the viewer, and it is what
 * decides.
 */
async function uploadForAdding(
  ctx: AuthContext,
  recordId: string,
  fileRowId: string,
  file: { name: string; bytes: Uint8Array; contentType: string },
): Promise<{ ok: true; file: null } | { ok: false; error: 'too_large' | 'row_full' }> {
  const row = (await fileRowsForAdding(ctx, recordId)).find((r) => r.id === fileRowId);
  if (!row) throw new Error('Not found');
  const supabase = await createSupabaseServerClient();
  const { data: full, error: fullError } = await supabase.rpc('file_row_full', { p_file_row: row.id });
  if (fullError) throw fullError;
  if (full) return { ok: false, error: 'row_full' };

  const path = `${recordId}/${row.kind}/${row.id}/${Date.now()}-${file.name}`;
  const bucket = supabaseAdmin().storage.from('records');
  const { error: uploadError } = await bucket.upload(path, file.bytes, { contentType: file.contentType, upsert: false });
  if (uploadError) throw uploadError;

  const { error } = await supabase.rpc('record_file_upload', {
    p_file_row_id: row.id,
    p_storage_path: path,
    p_name: file.name,
    p_size_bytes: file.bytes.byteLength,
  });
  if (error) {
    await bucket.remove([path]);
    throw error;
  }
  return { ok: true, file: null };
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
  fileRow: { id: string; kind: 'application' | 'other' | 'case' } | { id: string; kind: 'field'; fieldKey: string },
  file: { name: string; bytes: Uint8Array; contentType: string },
): Promise<{ ok: true; file: FileEntry | null } | { ok: false; error: 'too_large' | 'row_full' }> {
  // A Files FIELD is governed by the field's own grant (migration 9807), and
  // its path carries the field key so the bucket policy can ask the same.
  if (fileRow.kind === 'field') await requireFieldFilesEdit(recordId, fileRow.fieldKey);
  else if (fileRow.kind === 'case') await requireTabEdit(ctx, recordId, 'cases');
  else {
    // The Files tab: Edit, Add only, or either under an automation's lock or
    // hide. Adding is the normal permission's; what the row is like after is
    // the database's to say.
    await requireTabAdd(ctx, recordId, 'files');
    if (file.bytes.byteLength > MAX_FILE_BYTES) return { ok: false, error: 'too_large' };
    return uploadForAdding(ctx, recordId, fileRow.id, file);
  }
  if (file.bytes.byteLength > MAX_FILE_BYTES) return { ok: false, error: 'too_large' };

  const existing = await filesFor(ctx, fileRow.id);
  if (existing.length >= MAX_FILES_PER_ROW) return { ok: false, error: 'row_full' };

  const supabase = await createSupabaseServerClient();
  const path = fileRow.kind === 'field'
    ? `${recordId}/field/${fileRow.fieldKey}/${fileRow.id}/${Date.now()}-${file.name}`
    : `${recordId}/${fileRow.kind}/${fileRow.id}/${Date.now()}-${file.name}`;

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

/** Ticks or unticks Required. Its own permission, decided in the database: this
 *  does not need Edit on the Files tab. */
export async function setFileRowRequired(_ctx: AuthContext, rowId: string, required: boolean, needed: number): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_file_row_required', { p_row: rowId, p_required: required, p_needed: needed });
  if (error) throw error;
}

/** A row someone added. The preset rows are the system's and refuse this. */
export async function renameFileRow(_ctx: AuthContext, rowId: string, name: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('rename_file_row', { p_row: rowId, p_name: name });
  if (error) throw error;
}

/** To the Recycle Bin, with its files and its Required setting. */
export async function deleteFileRow(_ctx: AuthContext, rowId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('delete_file_row', { p_row: rowId });
  if (error) throw error;
}

/** One file to another row. Name, uploader, date and versions go with it. */
export async function moveFile(_ctx: AuthContext, fileId: string, toRowId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('move_file', { p_file: fileId, p_to_row: toRowId });
  if (error) throw error;
}

/**
 * A new version in the same place. The file's row stays put, so nothing that
 * counts files can change, and what it replaces moves to `file_versions`.
 */
export async function replaceFile(
  _ctx: AuthContext,
  fileId: string,
  file: { name: string; bytes: Uint8Array; contentType: string },
): Promise<{ ok: true } | { ok: false; error: 'too_large' }> {
  if (file.bytes.byteLength > MAX_FILE_BYTES) return { ok: false, error: 'too_large' };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('files')
    .select('file_row_id, file_rows!inner(record_id, kind)')
    .eq('id', fileId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  const row = data as { file_row_id: string; file_rows: { record_id: string; kind: string } } | null;
  if (!row) throw new Error('Not found');

  const path = `${row.file_rows.record_id}/${row.file_rows.kind}/${row.file_row_id}/${Date.now()}-${file.name}`;
  const bucket = supabase.storage.from('records');
  const { error: uploadError } = await bucket.upload(path, file.bytes, { contentType: file.contentType, upsert: false });
  if (uploadError) throw uploadError;

  const { error: replaceError } = await supabase.rpc('replace_file', {
    p_file: fileId, p_storage_path: path, p_name: file.name, p_size_bytes: file.bytes.byteLength,
  });
  if (replaceError) {
    await bucket.remove([path]);
    throw replaceError;
  }
  return { ok: true };
}

export type FileVersion = { id: string; version: number; name: string; uploadedAt: string };

/** What a file replaced, newest first. RLS answers to the file's own tab. */
export async function fileVersionsFor(_ctx: AuthContext, fileId: string): Promise<FileVersion[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('file_versions')
    .select('id, version, name, uploaded_at')
    .eq('file_id', fileId)
    .order('version', { ascending: false });
  if (error) throw error;
  return (data ?? []).map((v) => ({ id: v.id as string, version: v.version as number, name: v.name as string, uploadedAt: v.uploaded_at as string }));
}

/** A 60-second download link for an earlier version, by its id. */
export async function signedVersionUrlFor(_ctx: AuthContext, versionId: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('file_versions').select('storage_path, name').eq('id', versionId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('Not found');
  const { data: signed, error: signError } = await supabase.storage
    .from('records')
    .createSignedUrl(data.storage_path as string, 60, { download: data.name as string });
  if (signError) throw signError;
  return signed.signedUrl;
}

export async function deleteFile(ctx: AuthContext, fileId: string): Promise<void> {
  // A Files field's upload answers to the field, not the Files tab — the
  // database's `delete_file` asks `file_row_access` for every kind, so it is
  // the check for field files; the tab check stays for the rest.
  const supabase = await createSupabaseServerClient();
  const { data: row } = await supabase
    .from('files')
    .select('file_rows!inner(kind)')
    .eq('id', fileId)
    .maybeSingle();
  const kind = (row as { file_rows: { kind: string } } | null)?.file_rows.kind;
  if (kind !== 'field') await requireTabEditVia(ctx, 'files', fileId, 'files', 'file_row_id');
  const { error } = await supabase.rpc('delete_file', { p_file_id: fileId });
  if (error) throw error;
}

/** Short-TTL signed URL — files are never public, never a bare storage path
 * sent to the browser without going through this. */
/**
 * A 60-second download link for one file — addressed BY ITS ID.
 *
 * ── WHY NOT THE STORAGE PATH ──────────────────────────────────────────────
 * This took a `storagePath` straight from the browser and signed it, with the
 * `ctx` it was handed marked `_ctx` because nothing read it. The only thing
 * standing between a caller and a file was the bucket's RLS policy, which
 * checks `can_see_record()` on the first path segment and nothing else.
 *
 * That made the Files, Cases and Statements TAB GRANTS unenforceable on
 * downloads. Someone holding Files = Hidden on a record they can otherwise see
 * still got a working link to every file on it, because the tab grant was
 * consulted where the list is rendered and nowhere near the bytes — which is
 * UI-level hiding, and the spec says in as many words that UI-level hiding is
 * never the security boundary. The path being caller-supplied made it worse
 * than a missing check: the caller chose which file, across every kind, with
 * no list to have been filtered.
 *
 * Taking the ID instead makes the grant checkable, because the id is what
 * resolves to a record and a tab. Every caller already had it on hand.
 *
 * ── WHICH TAB ─────────────────────────────────────────────────────────────
 * A case attachment is an ordinary `files` row, but it is governed by the
 * Cases tab — the same distinction `uploadFile` above draws. The row's own
 * `kind` is what decides, not the caller.
 *
 * ── VIEW AND DOWNLOAD ARE THE SAME GRANT, NOT THE SAME URL ────────────────
 * `download` asks Storage to sign the URL with a `Content-Disposition:
 * attachment` carrying the file's ORIGINAL name. Without it a click either
 * renders the file in the tab (a PDF) or navigates to it (a .docx), and in
 * both cases what lands on disk is the storage path's opaque name — a
 * timestamp and a slug — rather than "Owner-ID.pdf".
 *
 * The name comes from the row, never from the caller: it is what the
 * `Content-Disposition` header will say, and a caller-supplied value there is
 * a header-injection sink.
 */
export async function signedUrlFor(
  ctx: AuthContext,
  fileId: string,
  opts: { download?: boolean } = {},
): Promise<string> {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from('files')
    .select('storage_path, name, file_rows!inner(record_id, kind, field_key)')
    .eq('id', fileId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;

  // A row this viewer cannot see comes back empty, so "does not exist" and
  // "not yours" give the same answer and neither is distinguishable.
  const row = data as
    | { storage_path: string; name: string; file_rows: { record_id: string; kind: string; field_key: string | null } }
    | null;
  if (!row) throw new Error('Not found');

  if (row.file_rows.kind === 'field') {
    const { data: level, error: accessError } = await supabase.rpc('file_row_access', {
      p_record: row.file_rows.record_id, p_kind: 'field', p_field_key: row.file_rows.field_key,
    });
    if (accessError) throw accessError;
    if (level === 'hidden') throw new Error('Not found');
  } else {
    await requireTabView(ctx, row.file_rows.record_id, row.file_rows.kind.startsWith('case') ? 'cases' : 'files');
    const { data: allowed, error: allowError } = await supabase.rpc('file_download_allowed', { p_file: fileId });
    if (allowError) throw allowError;
    if (allowed === false) throw new Error('Download is off for this file.');
  }

  const { data: signed, error: signError } = await supabase.storage
    .from('records')
    .createSignedUrl(row.storage_path, 60, opts.download ? { download: row.name } : undefined);
  if (signError) throw signError;
  return signed.signedUrl;
}

/* -------------------------------------------------------------------------- */
/* Files FIELDS (UI/UX spec §4) — one file row per (record, field)            */
/* -------------------------------------------------------------------------- */

/** Edit on the field itself, asked of the database — the same helper the
 *  policies use, so this can never disagree with them. */
async function requireFieldFilesEdit(recordId: string, fieldKey: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('file_row_access', {
    p_record: recordId, p_kind: 'field', p_field_key: fieldKey,
  });
  if (error) throw error;
  if (data !== 'edit') throw new Error('You do not have edit access to this field.');
}

/**
 * Every Files field's uploads on one record, keyed by field key, newest first.
 * RLS returns only the fields this viewer may see — a hidden field's files are
 * absent from the query, not filtered afterwards.
 */
export async function fieldFilesFor(_ctx: AuthContext, recordId: string): Promise<Record<string, FileEntry[]>> {
  const supabase = await createSupabaseServerClient();
  const { data: rows, error } = await supabase
    .from('file_rows')
    .select('id, field_key')
    .eq('record_id', recordId)
    .eq('kind', 'field')
    .is('deleted_at', null);
  if (error) throw error;
  const keyOf = new Map((rows ?? []).map((r) => [r.id as string, String(r.field_key)]));
  const byRow = await filesForRows(_ctx, [...keyOf.keys()]);
  const out: Record<string, FileEntry[]> = {};
  for (const [rowId, files] of Object.entries(byRow)) out[keyOf.get(rowId)!] = files;
  return out;
}

/** Uploads to a Files field, creating its file row the first time. */
export async function uploadFieldFile(
  ctx: AuthContext,
  recordId: string,
  fieldKey: string,
  file: { name: string; bytes: Uint8Array; contentType: string },
): Promise<{ ok: true; file: FileEntry | null } | { ok: false; error: 'too_large' | 'row_full' }> {
  await requireFieldFilesEdit(recordId, fieldKey);
  const supabase = await createSupabaseServerClient();
  const { data: existing, error } = await supabase
    .from('file_rows')
    .select('id')
    .eq('record_id', recordId)
    .eq('kind', 'field')
    .eq('field_key', fieldKey)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  let rowId = existing?.id as string | undefined;
  if (!rowId) {
    const { data: created, error: insertError } = await supabase
      .from('file_rows')
      .insert({ record_id: recordId, kind: 'field', field_key: fieldKey, name: fieldKey, locked: true })
      .select('id')
      .single();
    if (insertError) throw insertError;
    rowId = created.id as string;
  }
  return uploadFile(ctx, recordId, { id: rowId, kind: 'field', fieldKey }, file);
}
