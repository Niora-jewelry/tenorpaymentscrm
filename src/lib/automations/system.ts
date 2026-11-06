/**
 * Hard-coded automations (client, 6 Nov 2026): the jobs the CRM runs by
 * itself, as opposed to the ones built in the Automations builder.
 *
 * Each job asks `systemOn(key)` before it does anything, so Turn off stops it
 * at its next step, and reports how it went through `runSystem`, which feeds
 * the tab's Last run, Status and History. The switch lives in the database
 * (`system_automations`, migration 9917) so it reaches every server at once.
 *
 * Reads and switches go through the Automations permission: View sees the tab,
 * Full edit turns things off and deletes them.
 */
import 'server-only';
import type { AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { assertAutomationsEdit, assertAutomationsView, AutomationError } from './access';

export type SystemKey =
  | 'comm_dates'
  | 'mail_sync'
  | 'text_broadcasts'
  | 'maverick_sync'
  | 'agreement_downloads'
  | 'agreement_expiry'
  | 'agreement_reminders'
  | 'agreement_status_check'
  | 'notifications_cleanup'
  | 'upload_cleanup'
  | 'automation_history_cleanup';

type Def = {
  name: string;
  what: string;
  /** Where it acts, in the client's words. */
  where: string;
  when: string;
  /** Where its settings are changed, when it has any. */
  edit: { href: string; label: string } | null;
  /** How many items are queued for it right now; null when that has no meaning. */
  waiting: (() => Promise<number>) | null;
};

const db = () => supabaseAdmin();
const count = async (q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> => {
  const { count: n, error } = await q;
  if (error) throw error;
  return n ?? 0;
};

const OPEN_AGREEMENT = ['sending', 'sent', 'viewed', 'partially_signed'];

export const SYSTEM: Record<SystemKey, Def> = {
  comm_dates: {
    name: 'Last outreach and Last merchant response',
    what: 'Fills both dates from the newest call, text or email on the record, whichever came last. A call or message from the merchant sets Last merchant response; one to the merchant sets Last outreach. Both can still be changed by hand.',
    where: 'Every module · Overview',
    when: 'As each call, text or email arrives',
    edit: null,
    waiting: null,
  },
  mail_sync: {
    name: 'Email sync',
    what: 'Brings new mail, folders and rules in from Outlook, and sends what is waiting in the outbox.',
    where: 'Email',
    when: 'Every minute',
    edit: { href: '/admin/integrations?tab=microsoft&sub=main', label: 'Integrations › Microsoft 365' },
    waiting: () => count(db().from('mail_mailboxes').select('id', { count: 'exact', head: true }).is('deleted_at', null).is('deactivated_at', null).lte('next_sync_at', new Date().toISOString())),
  },
  text_broadcasts: {
    name: 'Send text broadcasts',
    what: 'Sends each queued broadcast text, a few a minute, skipping anyone who has opted out.',
    where: 'Phone',
    when: 'Every minute',
    edit: { href: '/admin/integrations?tab=twilio&sub=main', label: 'Integrations › Twilio' },
    waiting: () => count(db().from('sms_broadcast_recipients').select('id', { count: 'exact', head: true }).eq('status', 'queued')),
  },
  maverick_sync: {
    name: 'Maverick daily update',
    what: 'Fetches application status, reporting, statements and support tickets from Maverick Payments.',
    where: 'Every module · Applications, Reporting, Statements, Cases',
    when: 'Daily at 7 AM New York time',
    edit: { href: '/admin/integrations?tab=maverick&sub=main', label: 'Integrations › Maverick Payments' },
    waiting: null,
  },
  agreement_downloads: {
    name: 'Save signed agreements',
    what: 'Downloads each fully signed agreement and files it on the record, retrying for about an hour if SignWell is slow.',
    where: 'Every module · Files › Agreements',
    when: 'Every minute',
    edit: null,
    waiting: () => count(db().from('agreements').select('id', { count: 'exact', head: true }).eq('download_status', 'pending')),
  },
  agreement_expiry: {
    name: 'Expire unsigned agreements',
    what: 'Marks an agreement Expired once its signing window passes, and tells the sender.',
    where: 'Every module · Files › Agreements',
    when: 'Daily, overnight',
    edit: { href: '/admin/presets', label: 'Presets › Agreements' },
    waiting: () =>
      count(db().from('agreements').select('id', { count: 'exact', head: true }).in('status', OPEN_AGREEMENT).lt('expires_at', new Date().toISOString())),
  },
  agreement_reminders: {
    name: 'Remind signers',
    what: 'Emails a reminder on day 3, 6 and 10 to anyone who has not signed an agreement sent through Outlook.',
    where: 'Every module · Files › Agreements',
    when: 'Daily, overnight',
    edit: { href: '/admin/presets', label: 'Presets › Agreements' },
    waiting: null,
  },
  agreement_status_check: {
    name: 'Check agreement status',
    what: 'Asks SignWell about every agreement still out for signature, in case a status update was missed.',
    where: 'Every module · Files › Agreements',
    when: 'Daily, overnight',
    edit: { href: '/admin/integrations?tab=signwell&sub=main', label: 'Integrations › SignWell' },
    waiting: () => count(db().from('agreements').select('id', { count: 'exact', head: true }).in('status', OPEN_AGREEMENT)),
  },
  notifications_cleanup: {
    name: 'Clear old notifications',
    what: 'Removes notifications older than 90 days, and withdrawn mentions a day after they were withdrawn.',
    where: 'Notifications',
    when: 'Daily, overnight',
    edit: null,
    waiting: () =>
      count(db().from('notifications').select('id', { count: 'exact', head: true }).lt('created_at', new Date(Date.now() - 90 * 86_400_000).toISOString())),
  },
  upload_cleanup: {
    name: 'Remove abandoned uploads',
    what: 'Deletes returned-application PDFs that were uploaded but never attached to a record. They hold SSNs, so they must not linger.',
    where: 'Every module · Applications',
    when: 'Daily, overnight',
    edit: null,
    waiting: null,
  },
  automation_history_cleanup: {
    name: 'Trim automation history',
    what: 'Clears finished queue entries after 7 days, and runs that matched nothing after 30 days.',
    where: 'Automations',
    when: 'Daily, overnight',
    edit: null,
    waiting: null,
  },
};

export const SYSTEM_KEYS = Object.keys(SYSTEM) as SystemKey[];
export const isSystemKey = (k: string): k is SystemKey => (SYSTEM_KEYS as string[]).includes(k);

/* ── used by the jobs ──────────────────────────────────────────────────── */

/** Off, or deleted, means skip. Unknown or unreadable means on: a database hiccup must not stop the CRM's own jobs. */
export async function systemOn(key: SystemKey): Promise<boolean> {
  const { data, error } = await db().rpc('system_automation_on', { p_key: key });
  if (error) {
    console.error('[system automations] could not read switch', { key, code: error.code });
    return true;
  }
  return data !== false;
}

async function record(key: SystemKey, ok: boolean, n: number, note: string | null): Promise<void> {
  const { error } = await db().rpc('system_automation_record', { p_key: key, p_ok: ok, p_count: Math.max(0, Math.floor(n)), p_note: note });
  if (error) console.error('[system automations] could not record a run', { key, code: error.code });
}

/**
 * Runs one job if it is switched on, and records how it went. The job returns
 * how many things it did and, optionally, a short note for History. A failure
 * is recorded and swallowed, so one job's problem never stops the next.
 */
export async function runSystem(key: SystemKey, work: () => Promise<{ count: number; note?: string | null } | null>): Promise<void> {
  if (!(await systemOn(key))) return;
  try {
    const r = await work();
    if (r) await record(key, true, r.count, r.note ?? null);
  } catch (e) {
    console.error('[system automations] job failed', { key, message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    await record(key, false, 0, 'It stopped with an error. It tries again on its next run.');
  }
}

/* ── the Automations page ──────────────────────────────────────────────── */

export type SystemView = {
  key: SystemKey;
  name: string;
  what: string;
  where: string;
  when: string;
  edit: Def['edit'];
  enabled: boolean;
  switchedBy: string | null;
  switchedAt: string | null;
  lastRunAt: string | null;
  lastOutcome: 'ok' | 'failed' | null;
  lastNote: string | null;
  waiting: number | null;
};

export type SystemEvent = { id: string; kind: 'ran' | 'failed' | 'turned_on' | 'turned_off' | 'deleted'; at: string; by: string | null; count: number | null; note: string | null };

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const list = [...new Set(ids.filter((x): x is string => Boolean(x)))];
  if (!list.length) return new Map();
  const { data } = await db().from('profiles').select('id, full_name, email').in('id', list);
  return new Map((data ?? []).map((p) => [p.id as string, ((p.full_name as string | null)?.trim() || (p.email as string | null)) ?? 'Someone']));
}

export async function listSystemAutomations(ctx: AuthContext): Promise<SystemView[]> {
  await assertAutomationsView(ctx);
  const { data, error } = await db().from('system_automations').select('key, enabled, switched_by, switched_at, deleted_at, last_run_at, last_outcome, last_note').is('deleted_at', null);
  if (error) throw error;
  const rows = (data ?? []).filter((r) => isSystemKey(r.key as string));
  const names = await namesOf(rows.map((r) => r.switched_by as string | null));
  const waiting = await Promise.all(
    rows.map(async (r) => {
      const fn = SYSTEM[r.key as SystemKey].waiting;
      if (!fn || !r.enabled) return null;
      return fn().catch(() => null);
    }),
  );
  return rows
    .map((r, i) => {
      const key = r.key as SystemKey;
      const def = SYSTEM[key];
      return {
        key,
        name: def.name,
        what: def.what,
        where: def.where,
        when: def.when,
        edit: def.edit,
        enabled: r.enabled as boolean,
        switchedBy: r.switched_by ? (names.get(r.switched_by as string) ?? null) : null,
        switchedAt: (r.switched_at as string | null) ?? null,
        lastRunAt: (r.last_run_at as string | null) ?? null,
        lastOutcome: (r.last_outcome as 'ok' | 'failed' | null) ?? null,
        lastNote: (r.last_note as string | null) ?? null,
        waiting: waiting[i] ?? null,
      };
    })
    .sort((a, b) => SYSTEM_KEYS.indexOf(a.key) - SYSTEM_KEYS.indexOf(b.key));
}

export async function systemHistory(ctx: AuthContext, key: SystemKey): Promise<SystemEvent[]> {
  await assertAutomationsView(ctx);
  const { data, error } = await db().from('system_automation_events').select('id, kind, at, actor_id, count, note').eq('key', key).order('at', { ascending: false }).limit(100);
  if (error) throw error;
  const names = await namesOf((data ?? []).map((e) => e.actor_id as string | null));
  return (data ?? []).map((e) => ({
    id: String(e.id),
    kind: e.kind as SystemEvent['kind'],
    at: e.at as string,
    by: e.actor_id ? (names.get(e.actor_id as string) ?? 'Someone') : null,
    count: (e.count as number | null) ?? null,
    note: (e.note as string | null) ?? null,
  }));
}

export async function setSystemAutomation(ctx: AuthContext, key: SystemKey, action: 'turn_on' | 'turn_off' | 'delete'): Promise<void> {
  await assertAutomationsEdit(ctx);
  if (await currentImpersonation()) throw new AutomationError('Stop viewing as someone else first.');
  const { error } = await db().rpc('system_automation_set', { p_key: key, p_action: action, p_actor: ctx.userId });
  if (error) {
    if (error.code === '42501') throw new AutomationError(error.message);
    console.error('[system automations] could not switch', { key, action, code: error.code });
    throw new AutomationError('That did not save. Try again.');
  }
}
