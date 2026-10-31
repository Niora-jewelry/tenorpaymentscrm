/**
 * The tick. The rules live in SQL (`automation_work`), where a step and its
 * history commit together; this file does the two things SQL can't: build and
 * send an email, and email an alert.
 *
 * Service role, no session: nothing here can look like a person's change, which
 * is half of how "no chaining" holds. The other half is in `automation_fire`.
 */
import 'server-only';
import { addressLine, usDate } from '@/lib/agreements/format';
import { merchantName } from '@/lib/applications/store';
import { sendAutomationAlertEmail } from '@/lib/email/send';
import { mailConfigured } from '@/lib/env.server';
import { OUTBOX_BUCKET, sendDue } from '@/lib/mail/compose/send';
import { loadConfig, type Config } from '@/lib/records/config';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { env } from '@/lib/env';
import { FILES_BUCKET } from './service';
import { customAddresses, type EmailStep } from './steps';
import { bodyHtml, fill, type Values } from './template';

const MAX_ATTACHED = 35 * 1024 * 1024;
const RECORD_FILES_BUCKET = 'records';

type Job = { run_id: string | null; record_id: string | null; automation_id: string | null; automation_name: string | null; step: EmailStep | null; did: number };

type Attachment = { path: string; name: string; size: number; contentType: string };

const stop = (run: string, status: 'skipped' | 'failed', reason: string) =>
  supabaseAdmin().rpc('automation_mail_stop', { p_run: run, p_status: status, p_reason: reason.slice(0, 500) });

function valueText(config: Config, key: string, raw: unknown): string {
  const f = config.fields.find((x) => x.key === key);
  // Never a sensitive field, even if one was written into a body by hand.
  if (!f || f.sensitive || raw == null) return '';
  const label = (v: string) => config.choices.find((c) => c.fieldId === f.id && c.key === v)?.value ?? v;
  if (Array.isArray(raw)) return raw.map((v) => (typeof v === 'string' ? label(v) : String(v))).join(', ');
  if (f.type === 'address') return addressLine(raw);
  if (f.type === 'date' || f.type === 'datetime') return usDate(raw);
  if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
  if (typeof raw === 'object') return Object.values(raw as Record<string, unknown>).filter((v) => typeof v === 'string' && v.trim()).join(', ');
  return label(String(raw));
}

const asRows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** Spec: main contact (primary), all owners, or a custom address. */
function recipientsFor(step: EmailStep, values: Record<string, unknown>): { name: string; address: string }[] {
  if (step.to === 'custom') return customAddresses(step.customTo).map((address) => ({ name: address, address }));
  const rows = step.to === 'owners' ? asRows(values.owner_ownership) : asRows(values.contact).slice(0, 1);
  const seen = new Set<string>();
  const out: { name: string; address: string }[] = [];
  for (const r of rows) {
    const address = text(r.email);
    if (!address.includes('@') || seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    const name = text(r.name) || [text(r.first), text(r.last)].filter(Boolean).join(' ');
    out.push({ name: name || address, address });
  }
  return out;
}

async function copyFile(from: { bucket: string; path: string }, to: string, name: string, contentType: string): Promise<Attachment> {
  const admin = supabaseAdmin();
  const { data, error } = await admin.storage.from(from.bucket).download(from.path);
  if (error || !data) throw new Error(`The file ${name} could not be read.`);
  const bytes = Buffer.from(await data.arrayBuffer());
  const up = await admin.storage.from(OUTBOX_BUCKET).upload(to, bytes, { contentType, upsert: true });
  if (up.error) throw new Error(`The file ${name} could not be attached.`);
  return { path: to, name, size: bytes.length, contentType };
}

/** Uploaded files, then whatever sits on the chosen Files rows. Spec: either or both. */
async function attachmentsFor(step: EmailStep, recordId: string, ownerId: string, runId: string): Promise<Attachment[]> {
  const admin = supabaseAdmin();
  const base = `${ownerId}/automation/${runId}`;
  const safe = (n: string) => n.replace(/[^\w.\- ]+/g, '_').slice(-120) || 'file';
  const out: Attachment[] = [];

  if (step.fileIds.length) {
    const { data } = await admin.from('automation_files').select('id, name, storage_path, content_type').in('id', step.fileIds);
    if ((data ?? []).length !== step.fileIds.length) throw new Error('A file attached to this step is gone.');
    for (const f of data ?? []) {
      out.push(await copyFile({ bucket: FILES_BUCKET, path: f.storage_path as string }, `${base}/${f.id as string}/${safe(f.name as string)}`, f.name as string, f.content_type as string));
    }
  }

  for (const row of step.fileRows) {
    const { data } = await admin
      .from('file_rows')
      .select('files (id, name, storage_path, deleted_at)')
      .eq('record_id', recordId)
      .eq('kind', 'application')
      .eq('locked', true)
      .eq('name', row)
      .is('deleted_at', null);
    const files = (data ?? []).flatMap((r) => (r.files ?? []) as unknown as { id: string; name: string; storage_path: string; deleted_at: string | null }[]).filter((f) => !f.deleted_at);
    // An email promising a voided check must not go without one.
    if (!files.length) throw new Error(`Nothing is uploaded to ${row} on this record.`);
    for (const f of files) {
      out.push(await copyFile({ bucket: RECORD_FILES_BUCKET, path: f.storage_path }, `${base}/${f.id}/${safe(f.name)}`, f.name, 'application/octet-stream'));
    }
  }
  return out;
}

async function deliver(job: Job): Promise<void> {
  const run = job.run_id!;
  const step = job.step!;
  const admin = supabaseAdmin();
  if (!mailConfigured) {
    await stop(run, 'failed', 'Email is not set up on this server.');
    return;
  }

  try {
    const [{ data: rec }, config, { data: senders }] = await Promise.all([
      admin.from('records').select('values, deal_name').eq('id', job.record_id!).maybeSingle(),
      loadConfig(),
      admin.rpc('automation_mail_sender', { p_mailbox: step.mailboxId }),
    ]);
    if (!rec) {
      await stop(run, 'failed', 'The record is gone.');
      return;
    }
    const values = (rec.values ?? {}) as Record<string, unknown>;
    const to = recipientsFor(step, values);
    if (!to.length) {
      await stop(run, 'skipped', step.to === 'owners' ? 'No owner on this record has an email address.' : 'The main contact has no email address.');
      return;
    }
    const sender = (senders ?? [])[0] as { user_id: string; identity_id: string } | undefined;
    if (!sender) {
      await stop(run, 'failed', 'That inbox has no working connection.');
      return;
    }

    const first = asRows(values.contact)[0] ?? {};
    const fills: Values = {
      contact: text(first.name) || [text(first.first), text(first.last)].filter(Boolean).join(' '),
      merchant: merchantName(values, (rec.deal_name as string | null) ?? ''),
      field: (key) => valueText(config, key, key === 'deal_name' ? rec.deal_name : values[key]),
    };

    const attachments = await attachmentsFor(step, job.record_id!, sender.user_id, run);
    if (attachments.reduce((n, a) => n + a.size, 0) > MAX_ATTACHED) {
      await stop(run, 'failed', 'The attachments come to more than 35 MB.');
      return;
    }

    const { data: outboxId, error } = await admin.rpc('automation_mail_enqueue', {
      p_run: run,
      p_mailbox: step.mailboxId,
      p_subject: fill(step.subject, fills),
      p_body: bodyHtml(step.body, fills),
      p_to: to,
      p_attachments: attachments,
    });
    if (error) throw new Error(error.message);
    await sendDue({ only: outboxId as string, budgetMs: 30_000 });
  } catch (e) {
    await stop(run, 'failed', e instanceof Error ? e.message : 'The email could not be built.');
  }
}

/** Spec: the alert is also sent by email. Retried on each tick for a day: an address that always refuses must not be tried forever, and the alert still stands in the admin panel and Notifications. */
async function emailAlerts(): Promise<void> {
  const admin = supabaseAdmin();
  const { data: runs } = await admin
    .from('automation_runs')
    .select('id, automation_id, automation_name, record_label, reason')
    .gte('alerted_at', new Date(Date.now() - 86_400_000).toISOString())
    .is('alert_email_at', null)
    .limit(10);
  for (const r of runs ?? []) {
    const { data: rows } = await admin.from('notifications').select('recipient:profiles!notifications_recipient_id_fkey (email)').eq('automation_run_id', r.id as string).eq('source_kind', 'automation_alert');
    const emails = [...new Set((rows ?? []).map((x) => (x.recipient as unknown as { email: string } | null)?.email).filter((e): e is string => Boolean(e)))];
    let sent = emails.length === 0;
    for (const to of emails) {
      const res = await sendAutomationAlertEmail(to, {
        automationName: r.automation_name as string,
        recordName: (r.record_label as string | null) ?? 'a record',
        reason: (r.reason as string | null) ?? 'It stopped.',
        href: `${env.NEXT_PUBLIC_APP_URL}/admin/automations/runs?automation=${r.automation_id as string}`,
      });
      sent = sent || res.ok;
    }
    if (sent) await admin.from('automation_runs').update({ alert_email_at: new Date().toISOString() }).eq('id', r.id as string);
  }
}

/** Keeps going until nothing is left to do or the budget runs out. */
export async function runAutomations(budgetMs: number): Promise<{ steps: number; emails: number }> {
  const admin = supabaseAdmin();
  const deadline = Date.now() + budgetMs;
  const done = { steps: 0, emails: 0 };
  while (Date.now() < deadline) {
    const { data, error } = await admin.rpc('automation_work', { p_limit: 25 });
    if (error) {
      console.error('[automations] work failed', error.code, error.message.slice(0, 200));
      break;
    }
    const rows = (data ?? []) as Job[];
    const jobs = rows.filter((j) => j.run_id && j.step);
    done.steps += rows[0]?.did ?? 0;
    for (const job of jobs) {
      await deliver(job);
      done.emails += 1;
      if (Date.now() > deadline) break;
    }
    if (!rows.length || ((rows[0]?.did ?? 0) === 0 && jobs.length === 0)) break;
  }
  await emailAlerts();
  return done;
}
