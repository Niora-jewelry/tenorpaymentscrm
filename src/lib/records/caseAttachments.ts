/**
 * Files on a case's Issue, Solution and individual replies — Modules §3.7.
 *
 * "Files can be attached to the Issue, to the Solution, and to individual
 * replies. Standard file limits apply (up to 5 files per attachment point, 25MB
 * per file), stored and versioned like all files."
 *
 * ── THIS MODULE IS THIN ON PURPOSE ───────────────────────────────────────
 * "Stored and versioned like all files" is implemented by BEING all files: a
 * case attachment point is an ordinary `file_rows` row (migration 60) and the
 * files under it are ordinary `files` rows. So the upload path here calls the
 * same `uploadFile` the Files tab does, and the delete path is `deleteFile`
 * unchanged. What this module adds is exactly two things — resolving an
 * attachment point, and reading a whole case's attachments in one query.
 *
 * Everything else is inherited rather than re-implemented: the five-per-point
 * cap, the 25MB ceiling, version history, the signed download URL, the Recycle
 * Bin, and the activity-log entry §3.7 asks for.
 *
 * ── PERMISSION IS THE CASES TAB, NOT THE FILES TAB ───────────────────────
 * These files live in Cases. `requireTabEdit(ctx, recordId, 'cases')` is the
 * gate, and it is here rather than in the action for CLAUDE.md rule 2's reason:
 * a second caller must not be able to forget it. A user with the Files tab
 * hidden and the Cases tab editable can attach to a case, which is correct — the
 * two tabs are separate grants over separate content.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { requireTabEdit, requireTabView, recordIdOf } from './tabAccess';
import { uploadFile, type FileEntry } from './files';

/** Where on a case a file is attached. `reply` carries the reply's own id. */
export type CaseAttachmentPoint =
  | { kind: 'issue' }
  | { kind: 'solution' }
  | { kind: 'reply'; replyId: string };

const ROW_KIND: Record<CaseAttachmentPoint['kind'], string> = {
  issue: 'case_issue',
  solution: 'case_solution',
  reply: 'case_reply',
};

/** Files on one case, keyed by attachment point — `issue`, `solution`, or
 *  `reply:<replyId>`. Every key the caller asks about is present, mapped to an
 *  empty array when nothing is attached, so the panel can index without a null
 *  check. */
export type CaseAttachments = Record<string, FileEntry[]>;

/** The key a point is stored under in `CaseAttachments`. One function so the
 *  reader and the writer cannot disagree about the string. */
export function attachmentKey(point: CaseAttachmentPoint): string {
  return point.kind === 'reply' ? `reply:${point.replyId}` : point.kind;
}

/**
 * Every attachment on a set of cases, in ONE round trip.
 *
 * Two queries, not one per attachment point: a record with six cases and four
 * replies each would otherwise be thirty round trips to render a tab. The same
 * shape `filesForRows` already uses for the Files tab, and for the same reason.
 *
 * Read-gated on the Cases tab. A viewer who may not see Cases gets nothing
 * rather than an empty object that looks like "no attachments".
 */
export async function attachmentsForCases(
  ctx: AuthContext,
  recordId: string,
  caseIds: string[],
): Promise<Record<string, CaseAttachments>> {
  const out: Record<string, CaseAttachments> = {};
  for (const id of caseIds) out[id] = {};
  if (!caseIds.length) return out;

  await requireTabView(ctx, recordId, 'cases');

  const supabase = await createSupabaseServerClient();
  const { data: rows, error: rowError } = await supabase
    .from('file_rows')
    .select('id, kind, case_id, case_reply_id')
    .in('case_id', caseIds)
    .is('deleted_at', null);
  if (rowError) throw rowError;
  if (!rows?.length) return out;

  const { data: files, error: fileError } = await supabase
    .from('files')
    .select('*')
    .in('file_row_id', rows.map((r) => r.id))
    .is('deleted_at', null)
    // Newest first, matching `filesFor` exactly — the version history reads
    // top-down and would silently invert otherwise.
    .order('uploaded_at', { ascending: false });
  if (fileError) throw fileError;

  const byRow = new Map<string, FileEntry[]>();
  for (const f of files ?? []) {
    const entry: FileEntry = {
      id: f.id, fileRowId: f.file_row_id, storagePath: f.storage_path, name: f.name,
      sizeBytes: f.size_bytes, version: f.version, uploadedBy: f.uploaded_by, uploadedAt: f.uploaded_at,
    };
    const list = byRow.get(f.file_row_id);
    if (list) list.push(entry);
    else byRow.set(f.file_row_id, [entry]);
  }

  for (const r of rows) {
    const caseId = r.case_id as string;
    if (!out[caseId]) continue;
    const key =
      r.kind === 'case_reply' ? `reply:${r.case_reply_id as string}`
      : r.kind === 'case_solution' ? 'solution'
      : 'issue';
    out[caseId][key] = byRow.get(r.id as string) ?? [];
  }
  return out;
}

/**
 * Attach a file to one point on a case.
 *
 * The attachment point is created on demand — most cases never carry a file, and
 * a row per reply per case created up front would be thousands of empty rows.
 * The upload itself then goes through `uploadFile` unchanged, which is what
 * makes "stored and versioned like all files" true rather than merely claimed.
 *
 * The upload is gated on the CASES tab, not the Files tab — `uploadFile` picks
 * the tab from the row's kind, so a viewer with Files hidden and Cases editable
 * can attach to a case, which is correct: they are separate grants over
 * separate content.
 */
export async function attachToCase(
  ctx: AuthContext,
  caseId: string,
  point: CaseAttachmentPoint,
  file: { name: string; bytes: Uint8Array; contentType: string },
): Promise<{ ok: true; file: FileEntry } | { ok: false; error: 'too_large' | 'row_full' }> {
  // Resolved through the request's own RLS-bound client, so a case the viewer
  // cannot see throws here and the two answers "does not exist" and "not yours"
  // stay indistinguishable.
  const recordId = await recordIdOf('cases', caseId);
  await requireTabEdit(ctx, recordId, 'cases');

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('ensure_case_file_row', {
    p_case_id: caseId,
    p_kind: ROW_KIND[point.kind],
    p_reply_id: point.kind === 'reply' ? point.replyId : null,
  });
  if (error) throw error;

  return uploadFile(ctx, recordId, { id: data as string, kind: 'case' }, file);
}
