/**
 * One email per mention, straight after the mention is written.
 *
 * Called from the server actions through `after()`, so the person who posted
 * never waits on SMTP. Reads the rows with the service role (it needs the
 * recipient's address, which `profiles` RLS keeps from everyone else) and
 * skips anything that must not go: a mention revoked before the email went
 * (the update was edited or deleted), a recipient who is suspended or
 * removed, one already sent. Muting is enforced earlier — a muted person
 * never gets the row, so there is nothing here to skip. Failures are logged,
 * never thrown: the mention itself stands.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { sendMentionEmail } from '@/lib/email/send';

type Row = {
  id: string;
  source_kind: string;
  recipient_id: string;
  actor_id: string | null;
  record_id: string | null;
  update_id: string | null;
  case_id: string | null;
  field_key: string | null;
  preview: string | null;
  note: string | null;
  current_value: string | null;
  previous_value: string | null;
  revoked_at: string | null;
  email_sent_at: string | null;
};

function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const platform = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim() || process.env.VERCEL_URL?.trim();
  const looksLocal = !configured || /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(configured);
  if (process.env.NODE_ENV === 'production' && looksLocal && platform) return `https://${platform.replace(/\/+$/, '')}`;
  return (configured || 'http://localhost:3000').replace(/\/+$/, '');
}

export async function deliverMentionEmails(ids: string[]): Promise<{ sent: number; skipped: number }> {
  const out = { sent: 0, skipped: 0 };
  if (!ids.length) return out;
  const admin = supabaseAdmin();
  const { data, error } = await admin
    .from('notifications')
    .select('id, source_kind, recipient_id, actor_id, record_id, update_id, case_id, field_key, preview, note, current_value, previous_value, revoked_at, email_sent_at')
    .in('id', ids)
    .like('source_kind', 'mention\\_%');
  if (error) {
    console.error('[mentions] could not read notifications for email', error.code);
    return out;
  }
  const rows = (data ?? []) as Row[];
  if (!rows.length) return out;

  const people = [...new Set(rows.flatMap((r) => [r.recipient_id, r.actor_id]).filter((x): x is string => Boolean(x)))];
  const recordIds = [...new Set(rows.map((r) => r.record_id).filter((x): x is string => Boolean(x)))];
  const caseIds = [...new Set(rows.map((r) => r.case_id).filter((x): x is string => Boolean(x)))];
  const updateIds = [...new Set(rows.map((r) => r.update_id).filter((x): x is string => Boolean(x)))];
  const fieldKeys = [...new Set(rows.map((r) => r.field_key).filter((x): x is string => Boolean(x)))];

  const [profiles, records, cases, updates, fields] = await Promise.all([
    admin.from('profiles').select('id, email, full_name, status, deleted_at').in('id', people),
    recordIds.length ? admin.from('records').select('id, deal_name, deleted_at').in('id', recordIds) : Promise.resolve({ data: [] }),
    caseIds.length ? admin.from('cases').select('id, number, deleted_at').in('id', caseIds) : Promise.resolve({ data: [] }),
    updateIds.length ? admin.from('updates').select('id, body, deleted_at').in('id', updateIds) : Promise.resolve({ data: [] }),
    fieldKeys.length
      ? admin.from('fields').select('key, label, tab_id, subtab_id, tabs(label), subtabs(label)').in('key', fieldKeys)
      : Promise.resolve({ data: [] }),
  ]);
  type P = { id: string; email: string; full_name: string | null; status: string; deleted_at: string | null };
  const byPerson = new Map(((profiles.data ?? []) as P[]).map((p) => [p.id, p]));
  const byRecord = new Map(((records.data ?? []) as Array<{ id: string; deal_name: string; deleted_at: string | null }>).map((r) => [r.id, r]));
  const byCase = new Map(((cases.data ?? []) as Array<{ id: string; number: number; deleted_at: string | null }>).map((c) => [c.id, c]));
  const byUpdate = new Map(((updates.data ?? []) as Array<{ id: string; body: string; deleted_at: string | null }>).map((u) => [u.id, u]));
  type F = { key: string; label: string; tabs: { label: string } | null; subtabs: { label: string } | null };
  const byField = new Map(((fields.data ?? []) as unknown as F[]).map((f) => [String(f.key).toLowerCase(), f]));

  const origin = appOrigin();
  for (const r of rows) {
    const to = byPerson.get(r.recipient_id);
    const record = r.record_id ? byRecord.get(r.record_id) : undefined;
    const update = r.update_id ? byUpdate.get(r.update_id) : undefined;
    const kase = r.case_id ? byCase.get(r.case_id) : undefined;
    const skip =
      r.email_sent_at ||
      r.revoked_at ||
      !to ||
      to.status !== 'active' ||
      to.deleted_at ||
      !to.email ||
      !record ||
      record.deleted_at ||
      (update && update.deleted_at) ||
      (kase && kase.deleted_at);
    if (skip) {
      out.skipped += 1;
      continue;
    }
    const actor = r.actor_id ? byPerson.get(r.actor_id) : undefined;
    const field = r.field_key ? byField.get(r.field_key.toLowerCase()) : undefined;
    const where =
      r.source_kind === 'mention_update'
        ? 'an update'
        : r.source_kind === 'mention_case_reply'
          ? `case #${kase?.number ?? ''}`.trim()
          : `the ${field?.label ?? r.field_key} field${field?.tabs?.label ? ` (${field.tabs.label}${field.subtabs?.label ? ` → ${field.subtabs.label}` : ''})` : ''}`;
    const text =
      r.source_kind === 'mention_update'
        ? (update?.body ?? r.preview ?? '')
        : r.source_kind === 'mention_case_reply'
          ? (r.preview ?? '').replace(/^Case #\d+:\s*/, '')
          : (r.note ?? '');

    const res = await sendMentionEmail(to.email, {
      actorName: actor?.full_name?.trim() || 'Someone',
      recordName: record.deal_name,
      where,
      text,
      currentValue: r.source_kind === 'mention_field' ? r.current_value : undefined,
      previousValue: r.source_kind === 'mention_field' ? r.previous_value : undefined,
      href: `${origin}/n/${r.id}`,
    });
    if (res.ok) {
      await admin.from('notifications').update({ email_sent_at: new Date().toISOString() }).eq('id', r.id);
      out.sent += 1;
    } else {
      console.error('[mentions] email not sent', r.id, res.error);
      out.skipped += 1;
    }
  }
  return out;
}

/** The ids `mention_notify` wrote for a target, so the actions can email them. */
export async function notificationIdsFor(target: { updateId?: string; caseReplyId?: string; recordId?: string; fieldKey?: string; since?: string }): Promise<string[]> {
  const admin = supabaseAdmin();
  let q = admin.from('notifications').select('id').is('email_sent_at', null).like('source_kind', 'mention\\_%');
  if (target.updateId) q = q.eq('update_id', target.updateId);
  else if (target.caseReplyId) q = q.eq('case_reply_id', target.caseReplyId);
  else if (target.recordId && target.fieldKey) q = q.eq('record_id', target.recordId).eq('field_key', target.fieldKey).gte('created_at', target.since ?? new Date(Date.now() - 60_000).toISOString());
  else return [];
  const { data, error } = await q;
  if (error) {
    console.error('[mentions] could not list notification ids', error.code);
    return [];
  }
  return (data ?? []).map((r) => r.id as string);
}
