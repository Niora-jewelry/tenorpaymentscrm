/**
 * Service-role reads and small helpers for agreements. Nothing here checks
 * the viewer — `service.ts` does that first, every time — which is why none
 * of it is exported past the agreements folder's own modules.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { KINDS, kindFor } from './kinds';
import type { AgreementKindDef } from './kinds/types';

export type AgreementStatus = 'sending' | 'sent' | 'viewed' | 'partially_signed' | 'completed' | 'declined' | 'expired' | 'voided';
export type SignerStatus = 'sent' | 'viewed' | 'signed' | 'declined' | 'bounced';
export const OPEN_STATUSES: AgreementStatus[] = ['sending', 'sent', 'viewed', 'partially_signed'];

export type AgreementRow = {
  id: string;
  number: number;
  record_id: string;
  kind: string;
  status: AgreementStatus;
  vendor: string;
  vendor_document_id: string | null;
  test_mode: boolean;
  sent_by: string | null;
  sent_at: string;
  expires_at: string;
  last_event_at: string | null;
  completed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  expired_at: string | null;
  voided_at: string | null;
  voided_by: string | null;
  subject: string;
  message: string;
  requester_name: string;
  snapshot_sealed: unknown;
  snapshot_iv: unknown;
  used_field_keys: string[];
  signer_count: number;
  download_status: 'none' | 'pending' | 'stored' | 'failed';
  download_attempts: number;
  next_attempt_at: string | null;
  download_note: string | null;
};

export type SignerRow = {
  id: string;
  agreement_id: string;
  record_id: string;
  slot: number;
  owner_index: number;
  name: string;
  email: string;
  ownership_pct: number | null;
  vendor_recipient_id: string | null;
  status: SignerStatus;
  viewed_at: string | null;
  signed_at: string | null;
  declined_at: string | null;
  decline_reason: string | null;
  bounced_at: string | null;
  resent_at: string | null;
};

export type Settings = { expiresDays: number; reminders: boolean; requesterName: string; requesterEmail: string | null; emailSubject: string; emailMessage: string };

export const agrLabel = (n: number) => `AGR-${String(n).padStart(6, '0')}`;
export const newId = () => randomUUID();
export const isOpen = (s: AgreementStatus) => OPEN_STATUSES.includes(s);

export async function agreementById(id: string): Promise<AgreementRow | null> {
  const { data } = await supabaseAdmin().from('agreements').select('*').eq('id', id).maybeSingle();
  return (data as AgreementRow | null) ?? null;
}

/** The open agreement of one kind on a record — one may be out per kind. */
export async function openAgreementFor(recordId: string, kind: string): Promise<AgreementRow | null> {
  const { data } = await supabaseAdmin()
    .from('agreements')
    .select('*')
    .eq('record_id', recordId)
    .eq('kind', kind)
    .in('status', OPEN_STATUSES)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as AgreementRow | null) ?? null;
}

export async function signersFor(agreementId: string): Promise<SignerRow[]> {
  const { data } = await supabaseAdmin().from('agreement_signers').select('*').eq('agreement_id', agreementId).order('slot');
  return (data as SignerRow[] | null) ?? [];
}

export async function agreementSettings(): Promise<Settings> {
  const { data } = await supabaseAdmin().from('agreement_settings').select('*').eq('singleton', true).maybeSingle();
  return {
    expiresDays: (data?.expires_days as number | undefined) ?? 30,
    reminders: (data?.reminders as boolean | undefined) ?? true,
    requesterName: (data?.requester_name as string | undefined) ?? 'TapDash',
    requesterEmail: (data?.requester_email as string | null | undefined) ?? null,
    emailSubject: (data?.email_subject as string | undefined) ?? 'Your {{agreement}} — {{merchant}}',
    emailMessage: (data?.email_message as string | undefined) ?? '',
  };
}

/** The kinds that exist as config rows AND have a definition in code — the
 *  code is the mapping, the row is the on/off switch and the label. */
export async function activeKinds(): Promise<AgreementKindDef[]> {
  const { data } = await supabaseAdmin().from('agreement_kinds').select('key, label, active, position').eq('active', true).order('position');
  const rows = (data ?? []) as { key: string; label: string }[];
  return rows.map((r) => kindFor(r.key)).filter((k): k is AgreementKindDef => Boolean(k)).map((k) => ({ ...k, label: rows.find((r) => r.key === k.key)?.label ?? k.label }));
}

export { KINDS };
