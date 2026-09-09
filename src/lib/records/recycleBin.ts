/**
 * The Recycle Bin's contents — everything in the CRM that is soft-deleted.
 *
 * ── WHAT THE CLIENT ASKED FOR ────────────────────────────────────────────
 * Admin Plan §6: "The Recycle Bin contains everything truly soft-deleted across
 * the entire CRM: records (deleted from within the Records List module), files,
 * updates and replies, login rows, and users."
 *
 * Only records were ever listed. Everything else set `deleted_at` and became
 * unreachable — deleted by a button that called itself a soft delete, with no
 * screen anywhere that could bring it back. Migrations 53-55 added the restore
 * functions; this is the list that makes them reachable.
 *
 * ── WHY `supabaseAdmin()` THROUGHOUT ─────────────────────────────────────
 * Every read path in this codebase filters `deleted_at is null`, and the RLS
 * policies do the same — a soft-deleted row is invisible to the request-scoped
 * client by design. So the bin would always render empty through it. Same rule,
 * and the same reasoning, as `listDeletedRecords`: admin-only is enforced in
 * code at the top of each function rather than delegated to RLS.
 *
 * ⚠️ The RESTORE functions are the opposite — they go through the
 * request-scoped client, because each one is `security definer` and checks
 * `auth_is_admin()`, which resolves through `auth.uid()`. Under the service-role
 * key that is NULL and every one of them refuses its own caller.
 *
 * ── WHY EACH KIND IS ITS OWN QUERY AND ITS OWN RESTORE ───────────────────
 * They have different preconditions, and a generic restore would have to encode
 * all of them while losing the ability to say which rule refused: a file cannot
 * come back into a row that already holds five; a reply cannot come back under a
 * deleted update or a deleted thread; a user cannot come back active. Migration
 * 54's header has the full account.
 *
 * ── PASSWORDS ARE NEVER SELECTED ─────────────────────────────────────────
 * `logins.password_enc`/`password_key` are locked down by column-level REVOKE
 * (migration 9) and reachable only through `reveal_password`. The login query
 * below names its columns explicitly and neither appears — "absent, never
 * blank" applies to the bin exactly as it does to the drawer.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';

/** What kind of thing a bin entry is. Drives the label, the icon and which
 *  restore function the row calls — nothing here branches on a module. */
export type BinKind = 'file' | 'update' | 'reply' | 'login' | 'case' | 'case_reply';

export type BinItem = {
  kind: BinKind;
  id: string;
  /** One line naming the thing: a file name, the first words of an update, a
   *  case title. Never the whole body — this is a list, not a reader. */
  title: string;
  /** Which record it belongs to, so an admin restoring something knows where it
   *  is about to reappear. Null for the handful of rows whose parent record has
   *  itself been purged. */
  recordId: string | null;
  recordName: string | null;
  deletedAt: string | null;
};

const MAX_PER_KIND = 200;

/** First line of a body, trimmed for a list row. */
function excerpt(body: string | null, fallback: string): string {
  const line = (body ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return fallback;
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

export async function listBin(ctx: AuthContext): Promise<BinItem[]> {
  if (!ctx.isAdmin) return [];
  const supabase = supabaseAdmin();

  /*
   * Six reads in one wave rather than six waves. Each is capped at
   * MAX_PER_KIND — PostgREST truncates a row set at 1000 anyway, and a bin
   * silently showing the first thousand of something is exactly the kind of
   * quiet lie this codebase has already been bitten by once (`effective_grants`
   * losing rows off the end of a page). The cap is explicit and the screen says
   * so.
   */
  const [files, updates, logins, cases, replies, records] = await Promise.all([
    supabase
      .from('files')
      .select('id, name, deleted_at, file_row_id, file_rows!inner(record_id)')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(MAX_PER_KIND),
    supabase
      .from('updates')
      .select('id, body, parent_id, record_id, deleted_at')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(MAX_PER_KIND),
    supabase
      .from('logins')
      .select('id, login_type, username, record_id, deleted_at')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(MAX_PER_KIND),
    supabase
      .from('cases')
      .select('id, number, title, record_id, deleted_at')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(MAX_PER_KIND),
    supabase
      .from('case_replies')
      .select('id, body, case_id, deleted_at, cases!inner(record_id, number)')
      .not('deleted_at', 'is', null)
      .order('deleted_at', { ascending: false })
      .limit(MAX_PER_KIND),
    // Names for every record any of the above belongs to. Read in full rather
    // than joined six times: `records` is the one table all six point at, and a
    // second pass over ids in memory is cheaper than six nested selects.
    supabase.from('records').select('id, deal_name'),
  ]);

  for (const r of [files, updates, logins, cases, replies, records]) {
    if (r.error) throw r.error;
  }

  const nameById = new Map((records.data ?? []).map((r) => [r.id as string, r.deal_name as string]));
  const named = (recordId: string | null) => ({
    recordId,
    recordName: recordId ? (nameById.get(recordId) ?? null) : null,
  });

  const out: BinItem[] = [];

  for (const f of files.data ?? []) {
    // The embed comes back as an object for a to-one relationship and as an
    // array when PostgREST cannot prove it is to-one; both shapes are handled
    // rather than asserted, because getting it wrong is a silent `undefined`.
    const row = f.file_rows as unknown as { record_id: string } | { record_id: string }[] | null;
    const recordId = Array.isArray(row) ? (row[0]?.record_id ?? null) : (row?.record_id ?? null);
    out.push({ kind: 'file', id: f.id, title: f.name, deletedAt: f.deleted_at, ...named(recordId) });
  }

  for (const u of updates.data ?? []) {
    out.push({
      kind: u.parent_id ? 'reply' : 'update',
      id: u.id,
      title: excerpt(u.body, u.parent_id ? 'A reply' : 'An update'),
      deletedAt: u.deleted_at,
      ...named(u.record_id),
    });
  }

  for (const l of logins.data ?? []) {
    out.push({
      kind: 'login',
      id: l.id,
      title: l.username ? `${l.login_type} — ${l.username}` : l.login_type,
      deletedAt: l.deleted_at,
      ...named(l.record_id),
    });
  }

  for (const cse of cases.data ?? []) {
    out.push({
      kind: 'case',
      id: cse.id,
      title: `Case #${cse.number} — ${cse.title}`,
      deletedAt: cse.deleted_at,
      ...named(cse.record_id),
    });
  }

  for (const r of replies.data ?? []) {
    const parent = r.cases as unknown as
      | { record_id: string; number: number }
      | { record_id: string; number: number }[]
      | null;
    const one = Array.isArray(parent) ? (parent[0] ?? null) : parent;
    out.push({
      kind: 'case_reply',
      id: r.id,
      title: `Reply on case #${one?.number ?? '?'} — ${excerpt(r.body, 'a reply')}`,
      deletedAt: r.deleted_at,
      ...named(one?.record_id ?? null),
    });
  }

  // Newest first across every kind, so the bin reads as one timeline of what
  // was removed rather than six lists that each start again.
  return out.sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
}

export type BinRestoreResult = { ok: true } | { ok: false; message: string };

/** The database function behind each kind. One place, so a new kind cannot be
 *  added to the list without deciding what restores it. */
const RESTORE_FN: Record<BinKind, { fn: string; arg: string }> = {
  file: { fn: 'restore_file', arg: 'p_file_id' },
  update: { fn: 'restore_update', arg: 'p_update_id' },
  reply: { fn: 'restore_update', arg: 'p_update_id' },
  login: { fn: 'restore_login', arg: 'p_login_id' },
  case: { fn: 'restore_case', arg: 'p_case_id' },
  case_reply: { fn: 'restore_case_reply', arg: 'p_reply_id' },
};

/**
 * Bring one thing back.
 *
 * Every refusal these functions raise is a sentence written for a person — "That
 * file row already holds 5 files", "Restore the case thread first" — so it is
 * surfaced as-is rather than re-worded from an error code, the same posture
 * `adminPipelines.ts` takes with migration 37's messages.
 */
export async function restoreBinItem(
  ctx: AuthContext,
  kind: BinKind,
  id: string,
): Promise<BinRestoreResult> {
  if (!ctx.isAdmin) return { ok: false, message: 'Admin only' };
  const spec = RESTORE_FN[kind];
  if (!spec) return { ok: false, message: 'That cannot be restored.' };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc(spec.fn, { [spec.arg]: id });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}
