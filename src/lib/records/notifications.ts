/**
 * Notifications — the bell. `notifications` (migration 11) is written
 * exclusively by `notify()` (a SECURITY DEFINER function with no client
 * grant at all — migration 22's "no grant to anyone" posture); this file is
 * the read/mark-read side, scoped to the signed-in user by RLS
 * (`recipient_id = auth.uid()`) and by the column-restricted `update
 * (read_at)` grant, so there is nothing here that could touch another
 * user's notifications even by mistake.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { moduleGrant } from './permissions';
import { loadConfig } from './config';

export type NotificationRow = {
  id: string;
  body: string;
  recordId: string | null;
  sourceKind: string;
  createdAt: string;
  readAt: string | null;
  /** Where clicking it should go, or null when there is nowhere to send them.
   *  Resolved on the server — see `hrefFor`. */
  href: string | null;
};

/**
 * Which drawer tab a notification is about.
 *
 * Keys, not ids: `?tab=` takes keys precisely so a link survives a reseed, and
 * so this table reads as the mapping it is. A kind that is not listed opens the
 * record on its first tab, which is the honest fallback — better than guessing
 * at a tab that may not exist.
 */
const TAB_FOR_KIND: Record<string, { tab: string; subtab?: string }> = {
  mention: { tab: 'updates' },
  update: { tab: 'updates' },
  case: { tab: 'cases' },
  call: { tab: 'communication', subtab: 'phone' },
  voicemail: { tab: 'communication', subtab: 'recordings' },
  recording: { tab: 'communication', subtab: 'recordings' },
  sms: { tab: 'communication', subtab: 'text' },
};

function mapNotification(r: Record<string, unknown>, href: string | null): NotificationRow {
  return {
    id: r.id as string,
    body: r.body as string,
    recordId: (r.record_id as string | null) ?? null,
    sourceKind: r.source_kind as string,
    createdAt: r.created_at as string,
    readAt: (r.read_at as string | null) ?? null,
    href,
  };
}

/**
 * The destination for a notification, as a module the viewer can actually open.
 *
 * ── WHY THIS IS NOT `/records?record=<id>` ───────────────────────────────
 * That is what the bell used to do for every notification, and Records List is
 * `admin_only`. A member clicking their own mention was sent to a module the
 * permission gate redirects them out of, so the notification simply did not
 * work for the people who get most of them.
 *
 * A record sits in several modules and a viewer may hold different grants on
 * each, so the destination is the FIRST module, in configured order, that this
 * viewer can see. Configured order rather than arbitrary, so the same
 * notification lands in the same place every time.
 *
 * Returns null when the record is in no module the viewer can open — an
 * archived record, or one only in the Records List for a non-admin. The bell
 * then renders the notification as text with no link, which is the truth.
 */
async function buildHrefs(
  ctx: AuthContext,
  rows: Record<string, unknown>[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  const recordIds = [...new Set(rows.map((r) => r.record_id as string | null).filter(Boolean))] as string[];
  if (!recordIds.length) return out;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('record_modules')
    .select('record_id, module_id')
    .in('record_id', recordIds);
  if (error) throw error;

  const config = await loadConfig();
  const ordered = config.modules.filter((m) => !m.adminOnly);

  // One grant lookup per module, not per notification.
  const visible = new Map<string, boolean>();
  await Promise.all(
    ordered.map(async (m) => {
      visible.set(m.id, (await moduleGrant(ctx, m.id, m.adminOnly)) !== 'hidden');
    }),
  );

  const modulesByRecord = new Map<string, Set<string>>();
  for (const r of data ?? []) {
    const id = r.record_id as string;
    if (!modulesByRecord.has(id)) modulesByRecord.set(id, new Set());
    modulesByRecord.get(id)!.add(r.module_id as string);
  }

  for (const id of recordIds) {
    const mine = modulesByRecord.get(id);
    const mod = mine ? ordered.find((m) => mine.has(m.id) && visible.get(m.id)) : undefined;
    out.set(id, mod ? `/${mod.slug}?record=${id}` : null);
  }
  return out;
}

/** Telephony notifications have somewhere to go even with no record: the Phone
 *  page lists every call and thread of your own, matched or not. Most test
 *  calls and every call to a new prospect land here. */
const PHONE_KINDS = new Set(['call', 'voicemail', 'recording', 'sms']);

function withTab(base: string | null, sourceKind: string): string | null {
  if (!base) return PHONE_KINDS.has(sourceKind) ? '/phone' : null;
  const target = TAB_FOR_KIND[sourceKind];
  if (!target) return base;
  const sub = target.subtab ? `&subtab=${encodeURIComponent(target.subtab)}` : '';
  return `${base}&tab=${encodeURIComponent(target.tab)}${sub}`;
}

const BELL_LIMIT = 20;

export async function notificationsFor(ctx: AuthContext): Promise<NotificationRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('recipient_id', ctx.userId)
    .order('created_at', { ascending: false })
    .limit(BELL_LIMIT);
  if (error) throw error;

  const rows = data ?? [];
  const bases = await buildHrefs(ctx, rows);
  return rows.map((r) =>
    mapNotification(r, withTab(bases.get((r.record_id as string) ?? '') ?? null, r.source_kind as string)),
  );
}

export async function unreadNotificationCount(ctx: AuthContext): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { count, error } = await supabase
    .from('notifications')
    .select('id', { count: 'exact', head: true })
    .eq('recipient_id', ctx.userId)
    .is('read_at', null);
  if (error) throw error;
  return count ?? 0;
}

export async function markNotificationRead(ctx: AuthContext, notificationId: string): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('recipient_id', ctx.userId);
  if (error) throw error;
}

export async function markAllNotificationsRead(ctx: AuthContext): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('recipient_id', ctx.userId)
    .is('read_at', null);
  if (error) throw error;
}
