/**
 * Notifications — @mentions on updates, case replies and fields, plus the
 * phone-call alerts that already lived here.
 *
 * Every read and every state change goes through the RPCs of migrations
 * 9788–9790, keyed on `auth.uid()`: a person only ever sees their own rows,
 * and only while they can still see what each row points at (the record,
 * the tab, the field, the update). `notification_open` is the one path that
 * removes a field mention's previous value — the client's rule, "once the
 * mentioned user has opened the notification".
 *
 * Deep links are built here too (`hrefFor`): the first module the viewer can
 * open, then the tab, sub-tab and the notification id, which the drawer uses
 * to scroll to and highlight the exact item.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import type { AuthContext } from './permissions';
import { moduleGrant } from './permissions';
import { loadConfig } from './config';
import { profileNamesFor } from './users';

export type MentionKind = 'mention_update' | 'mention_case_reply' | 'mention_field';
export const PHONE_KINDS = ['call', 'voicemail', 'recording', 'sms'] as const;

export type NotificationView = {
  id: string;
  sourceKind: string;
  recordId: string | null;
  recordName: string | null;
  actorId: string | null;
  actorName: string | null;
  updateId: string | null;
  parentUpdateId: string | null;
  caseId: string | null;
  caseNumber: number | null;
  caseReplyId: string | null;
  fieldKey: string | null;
  fieldLabel: string | null;
  tabKey: string | null;
  subtabKey: string | null;
  /** The legacy sentence for phone alerts; the preview for mentions. */
  body: string;
  preview: string | null;
  note: string | null;
  currentValue: string | null;
  previousValue: string | null;
  createdAt: string;
  readAt: string | null;
  openedAt: string | null;
  /** Where clicking it goes, or null when there is nowhere to send them. */
  href: string | null;
  /** The module the link opens, for the list's "Module" column. */
  moduleLabel: string | null;
};

/** Kept for the phone module, which still writes through `notify()`. */
export type NotificationRow = Pick<NotificationView, 'id' | 'body' | 'recordId' | 'sourceKind' | 'createdAt' | 'readAt' | 'href'>;

type Raw = Record<string, unknown>;

/* Everything phone-borne lives under Communication → Phone, on one of its
   three views (UI spec §5); `view` picks the one the notification is about. */
const TAB_FOR_PHONE: Record<string, { tab: string; subtab?: string; view?: string }> = {
  call: { tab: 'communication', subtab: 'phone' },
  voicemail: { tab: 'communication', subtab: 'phone', view: 'recordings' },
  recording: { tab: 'communication', subtab: 'phone', view: 'recordings' },
  sms: { tab: 'communication', subtab: 'phone', view: 'texts' },
};

/**
 * The module each record opens in, for this viewer: the FIRST non-admin
 * module, in configured order, that holds the record and that the viewer can
 * see. Null when there is none (archived, or only in the admin-only Records
 * List for a member) — the row then renders as text with no link.
 */
async function moduleForRecords(ctx: AuthContext, recordIds: string[]): Promise<Map<string, { slug: string; label: string }>> {
  const out = new Map<string, { slug: string; label: string }>();
  const ids = [...new Set(recordIds)];
  if (!ids.length) return out;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('record_modules').select('record_id, module_id').in('record_id', ids);
  if (error) throw error;
  const config = await loadConfig();
  const ordered = config.modules.filter((m) => !m.adminOnly);
  const visible = new Map<string, boolean>();
  await Promise.all(ordered.map(async (m) => visible.set(m.id, (await moduleGrant(ctx, m.id, m.adminOnly)) !== 'hidden')));
  const byRecord = new Map<string, Set<string>>();
  for (const r of data ?? []) {
    const id = r.record_id as string;
    if (!byRecord.has(id)) byRecord.set(id, new Set());
    byRecord.get(id)!.add(r.module_id as string);
  }
  for (const id of ids) {
    const mine = byRecord.get(id);
    const mod = mine ? ordered.find((m) => mine.has(m.id) && visible.get(m.id)) : undefined;
    if (mod) out.set(id, { slug: mod.slug, label: mod.label });
  }
  return out;
}

/** Where a notification opens. Exported for its unit test only. */
export function hrefFor(r: Raw, mod: { slug: string } | undefined): string | null {
  const kind = r.source_kind as string;
  const recordId = r.record_id as string | null;
  if (!recordId || !mod) return kind in TAB_FOR_PHONE ? '/phone' : null;
  const base = `/${mod.slug}?record=${recordId}`;
  if (kind.startsWith('mention_')) {
    const tab = r.tab_key as string | null;
    const sub = r.subtab_key as string | null;
    return `${base}${tab ? `&tab=${encodeURIComponent(tab)}` : ''}${sub ? `&subtab=${encodeURIComponent(sub)}` : ''}&n=${r.id as string}`;
  }
  const target = TAB_FOR_PHONE[kind];
  if (!target) return base;
  return `${base}&tab=${encodeURIComponent(target.tab)}${target.subtab ? `&subtab=${encodeURIComponent(target.subtab)}` : ''}${target.view ? `&view=${encodeURIComponent(target.view)}` : ''}`;
}

async function toViews(ctx: AuthContext, rows: Raw[]): Promise<NotificationView[]> {
  const mods = await moduleForRecords(ctx, rows.map((r) => r.record_id as string | null).filter((x): x is string => Boolean(x)));
  return rows.map((r) => {
    const mod = r.record_id ? mods.get(r.record_id as string) : undefined;
    return {
      id: r.id as string,
      sourceKind: r.source_kind as string,
      recordId: (r.record_id as string | null) ?? null,
      recordName: (r.record_name as string | null) ?? null,
      actorId: (r.actor_id as string | null) ?? null,
      actorName: (r.actor_name as string | null) ?? null,
      updateId: (r.update_id as string | null) ?? null,
      parentUpdateId: (r.parent_update_id as string | null) ?? null,
      caseId: (r.case_id as string | null) ?? null,
      caseNumber: r.case_number == null ? null : Number(r.case_number),
      caseReplyId: (r.case_reply_id as string | null) ?? null,
      fieldKey: (r.field_key as string | null) ?? null,
      fieldLabel: (r.field_label as string | null) ?? null,
      tabKey: (r.tab_key as string | null) ?? null,
      subtabKey: (r.subtab_key as string | null) ?? null,
      body: (r.body as string) ?? '',
      preview: (r.preview as string | null) ?? null,
      note: (r.note as string | null) ?? null,
      currentValue: (r.current_value as string | null) ?? null,
      previousValue: (r.previous_value as string | null) ?? null,
      createdAt: r.created_at as string,
      readAt: (r.read_at as string | null) ?? null,
      openedAt: (r.opened_at as string | null) ?? null,
      href: hrefFor(r, mod),
      moduleLabel: mod?.label ?? null,
    };
  });
}

export type NotificationFilter = 'unread' | 'read' | 'all';
export type NotificationCursor = { at: string; id: string } | null;

export async function listNotifications(
  ctx: AuthContext,
  filter: NotificationFilter,
  cursor: NotificationCursor,
  limit = 30,
): Promise<{ rows: NotificationView[]; next: NotificationCursor }> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('notifications_list', {
    p_filter: filter,
    p_cursor_at: cursor?.at ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_limit: limit,
  });
  if (error) throw error;
  const rows = await toViews(ctx, (data ?? []) as Raw[]);
  const last = rows[rows.length - 1];
  return { rows, next: rows.length === limit && last ? { at: last.createdAt, id: last.id } : null };
}

export type UnreadCounts = { mentions: number; phone: number };

export async function unreadCounts(_ctx: AuthContext): Promise<UnreadCounts> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('my_unread_counts');
  if (error) throw error;
  const row = ((data ?? []) as Array<{ mentions: number; phone: number }>)[0];
  return { mentions: Number(row?.mentions ?? 0), phone: Number(row?.phone ?? 0) };
}

/** Unread mentions per record, for the records on one list page. */
export async function unreadMentionCounts(_ctx: AuthContext, recordIds: string[]): Promise<Record<string, number>> {
  if (!recordIds.length) return {};
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('my_unread_mention_counts', { p_record_ids: recordIds });
  if (error) throw error;
  return Object.fromEntries(((data ?? []) as Array<{ record_id: string; unread: number }>).map((r) => [r.record_id, Number(r.unread)]));
}

/** Every unread mention on one record, oldest first — what the drawer marks. */
export async function recordMentions(ctx: AuthContext, recordId: string): Promise<NotificationView[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('my_record_mentions', { p_record_id: recordId });
  if (error) throw error;
  return toViews(ctx, (data ?? []) as Raw[]);
}

/** Click-through: marks it read and opened, returns it with the previous
 *  value still present for THIS view; the value is gone after. */
/**
 * Where a notification leads, WITHOUT opening it. The links (an email's
 * /n/<id>, a row on the Notifications page) only need the destination: the
 * record page opens the mention itself when it lands (`?n=<id>`). Opening
 * here as well spent the one-time previous value before the person saw it.
 */
export async function peekNotification(ctx: AuthContext, id: string): Promise<NotificationView | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('notification_rows', { p_ids: [id] });
  if (error) throw error;
  const rows = await toViews(ctx, (data ?? []) as Raw[]);
  return rows[0] ?? null;
}

export async function openNotification(ctx: AuthContext, id: string): Promise<NotificationView | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('notification_open', { p_id: id });
  if (error) throw error;
  const rows = await toViews(ctx, (data ?? []) as Raw[]);
  return rows[0] ?? null;
}

export async function markNotifications(_ctx: AuthContext, ids: string[], read: boolean): Promise<number> {
  if (!ids.length) return 0;
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('notifications_mark', { p_ids: ids, p_read: read });
  if (error) throw error;
  return Number(data ?? 0);
}

export async function markAllRead(_ctx: AuthContext, kinds: readonly string[] | null = null): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('notifications_mark_all_read', { p_kinds: kinds ? [...kinds] : null });
  if (error) throw error;
  return Number(data ?? 0);
}

// ── Mentioning ────────────────────────────────────────────────────────────

export type MentionScope = 'updates' | 'cases' | `field:${string}`;
export type Candidate = { id: string; name: string };

/** Who may be mentioned here: only people who can see this exact thing. */
export async function mentionCandidates(ctx: AuthContext, recordId: string, scope: MentionScope): Promise<Candidate[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('mention_candidates', { p_record_id: recordId, p_scope: scope });
  if (error) throw error;
  const ids = (data ?? []) as string[];
  if (!ids.length) return [];
  const names = await profileNamesFor(ctx, ids);
  return ids.map((id) => ({ id, name: names.get(id) ?? 'Unknown user' }));
}

/**
 * Which of the ids the client claims it mentioned are genuinely in the text.
 * The picker inserts `@Full Name`; a name no longer present means the person
 * deleted the tag, so the id is dropped. `candidates` bounds the set — an id
 * that cannot be mentioned here is dropped too (the RPC would drop it as well).
 */
export function reconcileMentions(body: string, claimed: string[], candidates: Candidate[]): string[] {
  const byId = new Map(candidates.map((c) => [c.id, c.name]));
  const out: string[] = [];
  for (const id of new Set(claimed)) {
    const name = byId.get(id);
    if (name && body.includes(`@${name}`)) out.push(id);
  }
  return out;
}

export type RecentChange = { previousValue: string | null; changedAt: string } | null;

/** The sender's own change to this field in the last ten minutes, if any. */
export async function myRecentFieldChange(_ctx: AuthContext, recordId: string, fieldKey: string): Promise<RecentChange> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('my_recent_field_change', { p_record_id: recordId, p_field_key: fieldKey });
  if (error) throw error;
  const row = ((data ?? []) as Array<{ previous_value: string | null; changed_at: string }>)[0];
  return row ? { previousValue: row.previous_value ?? null, changedAt: row.changed_at } : null;
}

export async function mentionOnField(
  _ctx: AuthContext,
  input: { recordId: string; fieldKey: string; userIds: string[]; note: string | null; includePrevious: boolean },
): Promise<number> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('mention_field', {
    p_record_id: input.recordId,
    p_field_key: input.fieldKey,
    p_mentioned_user_ids: input.userIds,
    p_note: input.note,
    p_include_previous: input.includePrevious,
  });
  if (error) throw error;
  return Number(data ?? 0);
}

// ── Mute ──────────────────────────────────────────────────────────────────

export async function isMuted(ctx: AuthContext, recordId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { count, error } = await supabase
    .from('notification_mutes')
    .select('record_id', { count: 'exact', head: true })
    .eq('user_id', ctx.userId)
    .eq('record_id', recordId);
  if (error) throw error;
  return (count ?? 0) > 0;
}

export async function setMuted(ctx: AuthContext, recordId: string, muted: boolean): Promise<void> {
  const supabase = await createSupabaseServerClient();
  const { error } = muted
    ? await supabase.from('notification_mutes').upsert({ user_id: ctx.userId, record_id: recordId }, { onConflict: 'user_id,record_id', ignoreDuplicates: true })
    : await supabase.from('notification_mutes').delete().eq('user_id', ctx.userId).eq('record_id', recordId);
  if (error) throw error;
}

// ── Kept for the phone module's bell-era callers ──────────────────────────

/** @deprecated The bell is gone; `listNotifications` is the list. Left so
 *  nothing that still imports it breaks at build time. */
export async function notificationsFor(ctx: AuthContext): Promise<NotificationRow[]> {
  const { rows } = await listNotifications(ctx, 'all', null, 20);
  return rows.map((r) => ({ id: r.id, body: r.body, recordId: r.recordId, sourceKind: r.sourceKind, createdAt: r.createdAt, readAt: r.readAt, href: r.href }));
}

export async function unreadNotificationCount(ctx: AuthContext): Promise<number> {
  const c = await unreadCounts(ctx);
  return c.mentions + c.phone;
}

export async function markNotificationRead(ctx: AuthContext, notificationId: string): Promise<void> {
  await markNotifications(ctx, [notificationId], true);
}

export async function markAllNotificationsRead(ctx: AuthContext): Promise<void> {
  await markAllRead(ctx, null);
}
