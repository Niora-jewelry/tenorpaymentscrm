/**
 * Server internals shared by the CRM side (`service.ts`) and the merchant
 * side (`merchant.ts`). Service role throughout — every caller has already
 * decided who may do what (a CRM user's grants, or possession of the link).
 */
import 'server-only';
import { randomBytes, randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { hashTicket, toPostgresBytea } from '@/lib/security/otp';
import { fromBytea } from '@/lib/mail/crypto';
import { loadConfig } from '@/lib/records/config';
import { openText, sealText } from './crypto';
import type { Answers } from './catalog';
import { buildWrite, classify, isBlank, proposalsFrom, targetKey, type CrmValues, type Labels } from './mapping';

export type ApplicationStatus = 'sent' | 'opened' | 'submitted' | 'pdf_uploaded' | 'reviewed' | 'expired' | 'voided';

export type ApplicationRow = {
  id: string;
  number: number;
  record_id: string;
  status: ApplicationStatus;
  recipient: string;
  cc: string[];
  subject: string;
  sent_by: string | null;
  sent_at: string;
  last_sent_at: string;
  send_count: number;
  expires_at: string;
  opened_at: string | null;
  submitted_at: string | null;
  returned_via: 'online' | 'pdf' | null;
  reviewed_at: string | null;
  voided_at: string | null;
};

export const appLabel = (n: number) => `APP-${String(n).padStart(6, '0')}`;
export const parseAppLabel = (s: string | null): number | null => {
  const m = /^APP-(\d{1,12})$/i.exec((s ?? '').trim());
  return m ? Number(m[1]) : null;
};

/** Expired is a date, not a write: shown as such the moment it passes. */
export function effectiveStatus(a: Pick<ApplicationRow, 'status' | 'expires_at'>): ApplicationStatus {
  if ((a.status === 'sent' || a.status === 'opened') && new Date(a.expires_at).getTime() < Date.now()) return 'expired';
  return a.status;
}
/** The merchant can still type into it. */
export const linkIsLive = (a: Pick<ApplicationRow, 'status' | 'expires_at'>) => {
  const s = effectiveStatus(a);
  return s === 'sent' || s === 'opened';
};

// ── the link token ─────────────────────────────────────────────────────────

export function newToken(): { token: string; hash: Buffer } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashTicket(token) };
}
export const tokenHash = (token: string) => hashTicket(token);
export function sealToken(token: string, appId: string) {
  const s = sealText(token, `application-token:${appId}`);
  return { token_sealed: toPostgresBytea(s.data), token_iv: toPostgresBytea(s.iv) };
}
export function openToken(row: { id: string; token_sealed: unknown; token_iv: unknown }): string {
  return openText({ data: fromBytea(row.token_sealed), iv: fromBytea(row.token_iv) }, `application-token:${row.id}`);
}
/** A token-looking string, before any database work. */
export const plausibleToken = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);

// ── reads ──────────────────────────────────────────────────────────────────

const APP_COLUMNS =
  'id, number, record_id, status, recipient, cc, subject, sent_by, sent_at, last_sent_at, send_count, expires_at, opened_at, submitted_at, returned_via, reviewed_at, voided_at';

export async function applicationById(id: string): Promise<ApplicationRow | null> {
  const { data, error } = await supabaseAdmin().from('applications').select(APP_COLUMNS).eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as ApplicationRow | null) ?? null;
}
export async function applicationByNumber(n: number): Promise<ApplicationRow | null> {
  const { data, error } = await supabaseAdmin().from('applications').select(APP_COLUMNS).eq('number', n).maybeSingle();
  if (error) throw error;
  return (data as ApplicationRow | null) ?? null;
}
export async function applicationByToken(token: string): Promise<ApplicationRow | null> {
  if (!plausibleToken(token)) return null;
  const { data, error } = await supabaseAdmin()
    .from('applications')
    .select(APP_COLUMNS)
    .eq('token_hash', toPostgresBytea(tokenHash(token)))
    .maybeSingle();
  if (error) throw error;
  return (data as ApplicationRow | null) ?? null;
}

export async function recordForApplication(recordId: string): Promise<{ values: CrmValues; dealName: string; updatedAt: string } | null> {
  const { data, error } = await supabaseAdmin()
    .from('records')
    .select('values, deal_name, updated_at')
    .eq('id', recordId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { values: (data.values as CrmValues) ?? {}, dealName: data.deal_name as string, updatedAt: data.updated_at as string };
}

export type Settings = { linkExpiryDays: number; emailSubject: string; emailBody: string };
export async function applicationSettings(): Promise<Settings> {
  const { data, error } = await supabaseAdmin().from('application_settings').select('link_expiry_days, email_subject, email_body').maybeSingle();
  if (error) throw error;
  return {
    linkExpiryDays: (data?.link_expiry_days as number | undefined) ?? 30,
    emailSubject: (data?.email_subject as string | undefined) ?? 'Your merchant application',
    emailBody: (data?.email_body as string | undefined) ?? '{{link}}',
  };
}

/** Choice labels for display ("2-5 days", "Commercial"), from configuration. */
export async function choiceLabels(): Promise<Labels> {
  const config = await loadConfig();
  const byField = new Map(config.fields.map((f) => [f.key, f.id]));
  const map = new Map<string, string>();
  for (const c of config.choices) if (c.moduleId === null) map.set(`${c.fieldId}:${c.key}`, c.value);
  return (fieldKey, key) => map.get(`${byField.get(fieldKey)}:${key}`) ?? key.replace(/_/g, ' ');
}

/** The name an application goes out under: DBA, else legal name, else the record's name. */
export const merchantName = (crm: CrmValues, dealName: string) =>
  (typeof crm.dba === 'string' && crm.dba.trim()) || (typeof crm.legal_business_name === 'string' && crm.legal_business_name.trim()) || dealName;

// ── the one way answers enter the CRM ──────────────────────────────────────

export type IngestResult = { applied: number; pending: number };

/**
 * Turns returned answers into the review table and the automatic writes, in
 * one database transaction (`application_record_return`). Retried once if the
 * record changed underneath.
 */
export async function ingest(app: ApplicationRow, answers: Answers, via: 'online' | 'pdf' | 'manual', actor: string | null): Promise<IngestResult> {
  const labels = await choiceLabels();
  for (let attempt = 0; attempt < 2; attempt++) {
    const rec = await recordForApplication(app.record_id);
    if (!rec) throw new Error('That merchant record no longer exists.');
    const classified = proposalsFrom(answers, rec.values, labels).map((p) => classify(p, rec.values));
    const kept = classified.filter((c) => c.status !== 'same');
    const applied = kept.filter((c) => c.status === 'applied');
    const write = buildWrite(applied, rec.values);
    const isSsn = (key: string) => key.startsWith('member:owner_private.');
    const changes = kept.map((c) => {
      const key = targetKey(c.target);
      return {
        target: key,
        field_key: c.fieldKey,
        question: c.question,
        // A CRM SSN is never copied into the review table — only its mask.
        crm_value: isSsn(key) || isBlank(c.crmValue) ? null : c.crmValue,
        crm_display: isBlank(c.crmValue) ? null : isSsn(key) ? maskSsn(c.crmValue) : displayCrm(c.crmValue, c.fieldKey, labels),
        answer_value: { v: c.value ?? null, ...(c.candidates ? { c: c.candidates } : {}) },
        answer_display: c.display,
        status: c.status,
      };
    });
    const { data, error } = await supabaseAdmin().rpc('application_record_return', {
      p_application: app.id,
      p_changes: changes,
      p_values: write.values,
      p_notes: write.notes,
      p_via: via,
      p_actor: actor,
      p_expected_updated_at: rec.updatedAt,
    });
    if (error?.code === '40001' && attempt === 0) continue;
    if (error) throw error;
    const row = (data as { applied: number; pending: number }[])[0];
    return { applied: row?.applied ?? 0, pending: row?.pending ?? 0 };
  }
  throw new Error('The record kept changing. Try again.');
}

const maskSsn = (v: unknown) => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 4 ? `•••-••-${d.slice(-4)}` : '•••';
};

/** A CRM value as the review screen shows it. */
export function displayCrm(v: unknown, fieldKey: string, labels: Labels): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? labels(fieldKey, x) : String(x))).join(', ');
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('street' in o || 'city' in o) {
      const csz = [o.city, [o.state, o.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
      return [o.street, o.street2, csz].filter(Boolean).join(', ');
    }
    return Object.entries(o)
      .map(([k, x]) => `${labels(fieldKey, k)} ${String(x)}%`)
      .join(' · ');
  }
  const s = String(v);
  return labels(fieldKey, s) !== s.replace(/_/g, ' ') ? labels(fieldKey, s) : s;
}

export const newId = () => randomUUID();
