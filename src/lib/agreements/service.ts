/**
 * Agreements — the CRM side. Every function starts at the gate.
 *
 * Who may send: the record is visible, its Agreements tab is not hidden,
 * and the viewer holds the "Send agreement" permission (`agreements.send`;
 * admins always). Anyone who can open the record sees the panel.
 *
 * What goes out is filled from the record's FULL values (service role): a
 * Sales agent may send an agreement that prints the EIN and bank account
 * they cannot see. What comes back is gated the other way — the signed
 * PDF (and the banner's values) open only for a viewer who can see every
 * field that was printed. No code here names a tab or a field: the panel
 * hangs off `tabs.shows_agreements`, the mapping is the kind's own file.
 */
import 'server-only';
import { after } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { loadConfig, type Config } from '@/lib/records/config';
import { assertAdminPage } from '@/lib/records/adminConfig';
import { permissionsFor, type AuthContext } from '@/lib/records/permissions';
import { hiddenFieldKeysFor, tabAccess } from '@/lib/records/tabAccess';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { rateLimit, userKey } from '@/lib/security/rate-limit';
import { toPostgresBytea } from '@/lib/security/otp';
import { fromBytea } from '@/lib/mail/crypto';
import { choiceLabels, merchantName, recordForApplication } from '@/lib/applications/store';
import { openBytes, openText, sealBytes, sealText } from './crypto';
import { describeSignerProblem, selectSigners, type Signer, type SignerProblem } from './signers';
import { ownersOf, renderAgreement, requiredProblems } from './mapping';
import { agreementFileName, fillAndFlatten, loadTemplate, signatureSpots, templateInstalled, TemplateMissingError } from './pdf';
import { buildSnapshot, diffSnapshot, showValue, type Snapshot } from './snapshot';
import { agreementsConfigured, signwellTestMode, vendor } from './vendor';
import { VendorError } from './vendor/types';
import type { AgreementKindDef, AgreementProblem, AgreementSource } from './kinds/types';
import { activeKinds, agreementById, agreementSettings, agrLabel, isOpen, newId, openAgreementFor, signersFor, type AgreementRow, type AgreementStatus, type Settings, type SignerRow, type SignerStatus } from './store';
import { storeCompletedPdf } from './download';

export class AgreementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgreementError';
  }
}

export const FILES_BUCKET = 'agreement-pdfs';
const OUTAGE = "Couldn't reach the signing service. Nothing was sent. Try again in a few minutes.";

// ── gate ─────────────────────────────────────────────────────────────────────

export async function agreementsTab(): Promise<string | null> {
  const config = await loadConfig();
  return config.tabs.find((t) => t.showsAgreements)?.key ?? null;
}

export async function canSendAgreements(ctx: AuthContext): Promise<boolean> {
  if (ctx.isAdmin) return true;
  const p = await permissionsFor(ctx);
  return p.settings['agreements.send'] === 'yes';
}

async function requireView(ctx: AuthContext, recordId: string): Promise<void> {
  const tab = await agreementsTab();
  if (!tab) throw new AgreementError('No tab carries agreements. Ask an admin to enable the Agreements tab.');
  if ((await tabAccess(ctx, recordId, tab)) === 'hidden') throw new AgreementError('No access to this record.');
}

async function requireSend(ctx: AuthContext, recordId: string): Promise<void> {
  await requireView(ctx, recordId);
  if (!(await canSendAgreements(ctx))) throw new AgreementError('You do not have the "Send agreement" permission.');
  if (await currentImpersonation()) throw new AgreementError('You are signed in as someone else. Stop impersonating to send.');
}

// ── reading the record for an agreement ───────────────────────────────────────

/** The latest note per field key, service role: "If yes, please explain" boxes. */
async function latestNotes(recordId: string): Promise<Record<string, string>> {
  const { data } = await supabaseAdmin()
    .from('notes')
    .select('scope_id, body, created_at')
    .eq('record_id', recordId)
    .eq('scope_kind', 'field')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  const out: Record<string, string> = {};
  for (const n of (data ?? []) as { scope_id: string; body: string }[]) if (!(n.scope_id in out)) out[n.scope_id] = n.body;
  return out;
}

async function fieldAddresses(recordId: string): Promise<Record<string, unknown>> {
  const { data } = await supabaseAdmin().from('field_addresses').select('field_key, address').eq('record_id', recordId);
  return Object.fromEntries(((data ?? []) as { field_key: string; address: unknown }[]).map((r) => [r.field_key, r.address]));
}

async function sourceFor(recordId: string, sentAt = new Date()): Promise<{ src: AgreementSource; dealName: string; updatedAt: string } | null> {
  const rec = await recordForApplication(recordId);
  if (!rec) return null;
  const [labels, notes, addresses] = await Promise.all([choiceLabels(), latestNotes(recordId), fieldAddresses(recordId)]);
  return { src: { values: rec.values, addresses, notes, label: labels, sentAt }, dealName: rec.dealName, updatedAt: rec.updatedAt };
}

function ownerInputs(values: Record<string, unknown>) {
  const { owners } = ownersOf(values);
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return owners.map((o, index) => ({ index, first: s(o.first), last: s(o.last), email: s(o.email), title: s(o.title), percentage: o.percentage }));
}

// ── the pre-send check ────────────────────────────────────────────────────────

export type ProblemItem = { fieldKey: string; index?: number; member?: string; label: string; message: string; tabKey: string | null; subtabKey: string | null };
export type ProblemGroup = { tabKey: string | null; tabLabel: string; subtabKey: string | null; subtabLabel: string | null; items: ProblemItem[] };

function groupProblems(config: Config, problems: AgreementProblem[]): ProblemGroup[] {
  const groups = new Map<string, ProblemGroup>();
  const ordered = [...problems].sort((a, b) => {
    const fa = config.fields.find((f) => f.key === a.fieldKey);
    const fb = config.fields.find((f) => f.key === b.fieldKey);
    const ta = config.tabs.find((t) => t.id === fa?.tabId)?.position ?? 1e9;
    const tb = config.tabs.find((t) => t.id === fb?.tabId)?.position ?? 1e9;
    return ta - tb || (fa?.position ?? 0) - (fb?.position ?? 0);
  });
  for (const p of ordered) {
    const f = config.fields.find((x) => x.key === p.fieldKey);
    const tab = f ? config.tabs.find((t) => t.id === f.tabId) : undefined;
    const sub = f?.subtabId ? config.subtabs.find((s) => s.id === f.subtabId) : undefined;
    const key = `${tab?.key ?? ''}/${sub?.key ?? ''}`;
    const g = groups.get(key) ?? { tabKey: tab?.key ?? null, tabLabel: tab?.label ?? 'Record', subtabKey: sub?.key ?? null, subtabLabel: sub?.label ?? null, items: [] };
    g.items.push({ fieldKey: p.fieldKey, index: p.index, member: p.member, label: f?.label ?? p.fieldKey, message: p.message, tabKey: tab?.key ?? null, subtabKey: sub?.key ?? null });
    groups.set(key, g);
  }
  return [...groups.values()];
}

function signerProblems(problems: SignerProblem[], src: AgreementSource): AgreementProblem[] {
  const { owners } = ownersOf(src.values);
  const nameOf = (index: number) => {
    const o = owners[index] ?? {};
    const n = [o.first, o.last].filter((x): x is string => typeof x === 'string' && x.trim() !== '').join(' ');
    return n || `Owner ${index + 1}`;
  };
  return problems.map((p) => ({
    fieldKey: 'owner_ownership',
    index: 'index' in p ? p.index : undefined,
    message: describeSignerProblem(p, nameOf),
  }));
}

export type PreSendResult = {
  ok: boolean;
  kind: { key: string; label: string };
  groups: ProblemGroup[];
  signers: { slot: number; name: string; title: string; email: string; percentage: number }[];
  expiresDays: number;
  subject: string;
  message: string;
  fileName: string;
  testMode: boolean;
  configured: boolean;
  templateReady: boolean;
};

function fillTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

async function kindOrThrow(kindKey: string): Promise<AgreementKindDef> {
  const k = (await activeKinds()).find((x) => x.key === kindKey);
  if (!k) throw new AgreementError('That agreement is not available.');
  return k;
}

/** Everything the dialog shows before anything goes out (spec §5). */
export async function preSendCheck(ctx: AuthContext, recordId: string, kindKey: string): Promise<PreSendResult> {
  await requireSend(ctx, recordId);
  const kind = await kindOrThrow(kindKey);
  const [config, found, settings, templateReady, open, me] = await Promise.all([
    loadConfig(),
    sourceFor(recordId),
    agreementSettings(),
    templateInstalled(kind),
    openAgreementFor(recordId),
    supabaseAdmin().from('profiles').select('full_name, email').eq('id', ctx.userId).maybeSingle(),
  ]);
  if (!found) throw new AgreementError('That record no longer exists.');
  const { src, dealName } = found;

  const problems: AgreementProblem[] = requiredProblems(kind, src);
  const picked = selectSigners(ownerInputs(src.values));
  problems.push(...signerProblems(picked.problems, src));
  if (open) problems.push({ fieldKey: 'owner_ownership', message: `An agreement is already out (${agrLabel(open.number)}). Void it first.` });

  // A problem on a field the viewer cannot see is named by its place, not its value.
  const hidden = await hiddenFieldKeysFor(ctx, recordId, config.fields);
  const visibleProblems = problems.map((p) => (hidden.has(p.fieldKey) ? { ...p, message: 'A value in a section you cannot see is missing or wrong. Ask an underwriter or admin to complete it.' } : p));

  const name = merchantName(src.values, dealName);
  const expires = new Date(Date.now() + settings.expiresDays * 86400_000);
  const vars = {
    merchant: name,
    signer_name: picked.signers[0]?.first ?? 'there',
    expires: expires.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    sender_name: (me.data?.full_name as string | undefined) || (me.data?.email as string | undefined) || settings.requesterName,
  };
  return {
    ok: visibleProblems.length === 0 && templateReady && agreementsConfigured,
    kind: { key: kind.key, label: kind.label },
    groups: groupProblems(config, visibleProblems),
    signers: picked.signers.map((s) => ({ slot: s.slot, name: s.name, title: s.title, email: s.email, percentage: s.percentage })),
    expiresDays: settings.expiresDays,
    subject: fillTemplate(settings.emailSubject, vars),
    message: fillTemplate(settings.emailMessage, vars),
    fileName: agreementFileName(name, kind.label),
    testMode: signwellTestMode,
    configured: agreementsConfigured,
    templateReady,
  };
}

// ── sending ───────────────────────────────────────────────────────────────────

export type SendInput = { recordId: string; kind: string; subject: string; message: string };

export async function sendAgreement(ctx: AuthContext, input: SendInput): Promise<{ id: string; label: string }> {
  await requireSend(ctx, input.recordId);
  if (!agreementsConfigured) throw new AgreementError('The signing service is not set up yet (SignWell key and webhook).');
  const limit = await rateLimit(userKey('agreement_send', ctx.userId), { limit: 20, windowSeconds: 3600 });
  if (!limit.allowed) throw new AgreementError(`Too many agreements sent in the last hour. Try again in ${limit.retryAfterSeconds} seconds.`);

  const kind = await kindOrThrow(input.kind);
  const sentAt = new Date();
  const found = await sourceFor(input.recordId, sentAt);
  if (!found) throw new AgreementError('That record no longer exists.');
  const { src, dealName } = found;

  // The same check again, on the server: never the browser alone (spec §5).
  const problems = requiredProblems(kind, src);
  const picked = selectSigners(ownerInputs(src.values));
  problems.push(...signerProblems(picked.problems, src));
  if (problems.length) throw new AgreementError(`Can't send yet: ${problems.length} item${problems.length === 1 ? '' : 's'} need fixing. Open the check to see them.`);
  if (await openAgreementFor(input.recordId)) throw new AgreementError('An agreement is already out. Void it first.');

  const settings = await agreementSettings();
  const { pdf: template, fields } = await loadTemplate(kind);
  const rendered = renderAgreement(kind, src, picked.signers);
  const flat = await fillAndFlatten(kind, template, rendered.byPdfField);
  const spots = signatureSpots(kind, fields, picked.signers);
  const name = merchantName(src.values, dealName);
  const fileName = agreementFileName(name, kind.label);

  const id = newId();
  const snapshot = buildSnapshot(src, rendered.used, kind.version, sentAt);
  const sealed = sealText(JSON.stringify(snapshot), `agreement-snapshot:${id}`);
  const insert = await supabaseAdmin().from('agreements').insert({
    id,
    record_id: input.recordId,
    kind: kind.key,
    status: 'sending',
    vendor: 'signwell',
    test_mode: signwellTestMode,
    sent_by: ctx.userId,
    sent_at: sentAt.toISOString(),
    expires_at: new Date(sentAt.getTime() + settings.expiresDays * 86400_000).toISOString(),
    subject: input.subject,
    message: input.message,
    requester_name: settings.requesterName,
    snapshot_sealed: toPostgresBytea(sealed.data),
    snapshot_iv: toPostgresBytea(sealed.iv),
    used_field_keys: rendered.usedFieldKeys,
    signer_count: picked.signers.length,
  }).select('number').single();
  if (insert.error) {
    if (insert.error.code === '23505') throw new AgreementError('An agreement is already out. Void it first.');
    throw insert.error;
  }
  const label = agrLabel(insert.data.number as number);

  let sent;
  try {
    sent = await vendor().send({
      agreementId: id,
      recordId: input.recordId,
      name: `${kind.label} — ${name}`,
      fileName,
      pdf: flat,
      signers: picked.signers,
      spots,
      subject: input.subject,
      message: input.message,
      requesterName: settings.requesterName,
      requesterEmail: settings.requesterEmail,
      expiresDays: settings.expiresDays,
      reminders: settings.reminders,
      testMode: signwellTestMode,
    });
  } catch (e) {
    // No half-sent record (spec §9).
    await supabaseAdmin().from('agreements').delete().eq('id', id);
    if (e instanceof VendorError) throw new AgreementError(e.kind === 'rejected' || e.kind === 'auth' ? `The signing service refused the agreement. Nothing was sent. (${e.message})` : OUTAGE);
    throw e;
  }

  const signerRows = picked.signers.map((s) => ({
    agreement_id: id,
    record_id: input.recordId,
    slot: s.slot,
    owner_index: s.index,
    name: s.name,
    email: s.email,
    ownership_pct: s.percentage,
    vendor_recipient_id: sent.recipients.find((r) => r.slot === s.slot)?.vendorId ?? null,
    status: 'sent',
  }));
  const wrote = await supabaseAdmin().from('agreements').update({ vendor_document_id: sent.documentId, status: 'sent', last_event_at: new Date().toISOString() }).eq('id', id);
  const signersWrote = wrote.error ? wrote : await supabaseAdmin().from('agreement_signers').insert(signerRows);
  if (wrote.error || signersWrote.error) {
    await vendor().cancel(sent.documentId).catch(() => undefined);
    await supabaseAdmin().from('agreements').delete().eq('id', id);
    throw new AgreementError('The agreement could not be recorded, so it was cancelled at the signing service. Try again.');
  }

  // The flattened copy that went out, sealed, so the record keeps what the signers saw.
  await storeAgreementFile(id, input.recordId, 'sent_copy', fileName, flat).catch(() => undefined);

  const names = picked.signers.map((s) => s.name).join(', ');
  await supabaseAdmin().rpc('agreement_log', {
    p_agreement: id,
    p_actor: ctx.userId,
    p_summary: `${label} sent for signature to ${names}`,
    p_update_body: `Agreement ${label} (${kind.label}) sent for e-signature to ${names}. Expires ${new Date(sentAt.getTime() + settings.expiresDays * 86400_000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}.`,
  });
  return { id, label };
}

export async function storeAgreementFile(agreementId: string, recordId: string, kind: 'sent_copy' | 'completed', name: string, bytes: Uint8Array): Promise<string> {
  const fileId = newId();
  const sealed = sealBytes(Buffer.from(bytes), `agreement-file:${fileId}`);
  const path = `${recordId}/${fileId}.bin`;
  const up = await supabaseAdmin().storage.from(FILES_BUCKET).upload(path, sealed.data, { contentType: 'application/octet-stream', upsert: false });
  if (up.error) throw new Error(up.error.message);
  const ins = await supabaseAdmin().from('agreement_files').upsert(
    { id: fileId, agreement_id: agreementId, record_id: recordId, kind, storage_path: path, name, size_bytes: bytes.byteLength, iv: toPostgresBytea(sealed.iv) },
    { onConflict: 'agreement_id,kind' },
  );
  if (ins.error) {
    await supabaseAdmin().storage.from(FILES_BUCKET).remove([path]);
    throw ins.error;
  }
  return fileId;
}

// ── open agreements: void, resend, remind, one signer's new email ─────────────

async function ownedOpen(ctx: AuthContext, agreementId: string): Promise<AgreementRow> {
  const a = await agreementById(agreementId);
  if (!a) throw new AgreementError('That agreement no longer exists.');
  await requireSend(ctx, a.record_id);
  return a;
}

export async function voidAgreement(ctx: AuthContext, agreementId: string): Promise<void> {
  const a = await ownedOpen(ctx, agreementId);
  if (!isOpen(a.status)) throw new AgreementError('That agreement is already closed.');
  if (a.vendor_document_id) {
    try {
      await vendor().cancel(a.vendor_document_id);
    } catch (e) {
      // Already closed at the vendor: reconcile rather than refuse.
      if (!(e instanceof VendorError && (e.kind === 'not_found' || e.kind === 'conflict'))) throw new AgreementError(OUTAGE);
    }
  }
  await supabaseAdmin().rpc('agreement_apply_event', {
    p_vendor: a.vendor,
    p_vendor_document_id: a.vendor_document_id ?? a.id,
    p_agreement_hint: a.id,
    p_dedupe_key: `void:${a.id}:${Date.now()}`,
    p_event_type: 'user_voided',
    p_event_time: new Date().toISOString(),
    p_event_hash: null,
    p_signer_email: null,
    p_reason: null,
    p_source: 'user',
  });
  await supabaseAdmin().from('agreements').update({ voided_by: ctx.userId }).eq('id', a.id);
}

/** Void & resend (spec §8): cancel, then a fresh agreement from the record as it is now. */
export async function voidAndResend(ctx: AuthContext, agreementId: string, input: Omit<SendInput, 'recordId'>): Promise<{ id: string; label: string }> {
  const a = await ownedOpen(ctx, agreementId);
  if (isOpen(a.status)) await voidAgreement(ctx, agreementId);
  return sendAgreement(ctx, { ...input, recordId: a.record_id });
}

export async function sendReminder(ctx: AuthContext, agreementId: string): Promise<void> {
  const a = await ownedOpen(ctx, agreementId);
  if (!isOpen(a.status) || !a.vendor_document_id) throw new AgreementError('That agreement is not open.');
  const limit = await rateLimit(userKey('agreement_remind', ctx.userId), { limit: 10, windowSeconds: 3600 });
  if (!limit.allowed) throw new AgreementError('Reminders are limited to ten an hour.');
  try {
    await vendor().remind(a.vendor_document_id);
  } catch {
    throw new AgreementError(OUTAGE);
  }
  await supabaseAdmin().rpc('agreement_log', { p_agreement: a.id, p_actor: ctx.userId, p_summary: `Reminder sent for ${agrLabel(a.number)}`, p_update_body: null });
}

/**
 * A bounced signer: the user fixes the email on the Ownership sub-tab and
 * resends to that one signer only (the client, 30 Oct 2026). The vendor
 * re-emails them; the other signers are untouched.
 */
export async function resendToSigner(ctx: AuthContext, agreementId: string, signerId: string): Promise<{ email: string }> {
  const a = await ownedOpen(ctx, agreementId);
  if (!isOpen(a.status) || !a.vendor_document_id) throw new AgreementError('That agreement is not open.');
  const signer = (await signersFor(a.id)).find((s) => s.id === signerId);
  if (!signer) throw new AgreementError('That signer is not on this agreement.');
  if (signer.status === 'signed') throw new AgreementError(`${signer.name} has already signed.`);
  if (!signer.vendor_recipient_id) throw new AgreementError('The signing service has no recipient for this signer.');
  const rec = await recordForApplication(a.record_id);
  const owner = rec ? (ownersOf(rec.values).owners[signer.owner_index] ?? null) : null;
  const email = typeof owner?.email === 'string' ? owner.email.trim() : '';
  const first = typeof owner?.first === 'string' ? owner.first.trim() : '';
  const last = typeof owner?.last === 'string' ? owner.last.trim() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new AgreementError(`${signer.name} still has no valid email on the Ownership sub-tab. Fix it there first.`);
  if (email.toLowerCase() === signer.email.toLowerCase() && signer.status === 'bounced') throw new AgreementError(`${signer.name}'s email is unchanged (${email}). Fix it on the Ownership sub-tab first.`);
  const name = [first, last].filter(Boolean).join(' ') || signer.name;
  try {
    await vendor().updateRecipient(a.vendor_document_id, signer.vendor_recipient_id, name, email);
  } catch (e) {
    if (e instanceof VendorError && e.kind === 'rejected') throw new AgreementError('The signing service would not change this signer — they may have started signing.');
    throw new AgreementError(OUTAGE);
  }
  await supabaseAdmin().from('agreement_signers').update({ email, name, status: 'sent', bounced_at: null, resent_at: new Date().toISOString() }).eq('id', signer.id);
  await supabaseAdmin().rpc('agreement_log', {
    p_agreement: a.id,
    p_actor: ctx.userId,
    p_summary: `${agrLabel(a.number)} resent to ${name}`,
    p_update_body: `Agreement ${agrLabel(a.number)} resent to ${name} at a corrected address.`,
  });
  return { email };
}

export async function retryDownload(ctx: AuthContext, agreementId: string): Promise<void> {
  const a = await ownedOpen(ctx, agreementId);
  if (a.status !== 'completed') throw new AgreementError('Only a completed agreement has a signed PDF.');
  await supabaseAdmin().from('agreements').update({ download_status: 'pending', next_attempt_at: new Date().toISOString(), download_attempts: 0, download_note: null }).eq('id', a.id);
  after(() => storeCompletedPdf(a.id).catch(() => undefined));
}

// ── the panel ─────────────────────────────────────────────────────────────────

export type SignerView = { id: string; slot: number; name: string; email: string; percentage: number | null; status: SignerStatus; at: string | null; declineReason: string | null };
export type FileView = { id: string; kind: 'sent_copy' | 'completed'; name: string; sizeBytes: number; canOpen: boolean };
export type AgreementView = {
  id: string;
  label: string;
  kindLabel: string;
  status: AgreementStatus;
  testMode: boolean;
  sentBy: string | null;
  sentAt: string;
  expiresAt: string;
  completedAt: string | null;
  declinedAt: string | null;
  declineReason: string | null;
  expiredAt: string | null;
  voidedAt: string | null;
  downloadStatus: 'none' | 'pending' | 'stored' | 'failed';
  signers: SignerView[];
  files: FileView[];
};
export type ChangeView = { label: string; before: string; after: string };
export type AgreementsPanelData = {
  items: AgreementView[];
  kinds: { key: string; label: string }[];
  canSend: boolean;
  configured: boolean;
  /** Values that changed since the open agreement went out (spec §8). */
  changes: ChangeView[] | null;
  openId: string | null;
};

function openSnapshot(a: AgreementRow): Snapshot | null {
  if (!a.snapshot_sealed || !a.snapshot_iv) return null;
  try {
    return JSON.parse(openText({ data: fromBytea(a.snapshot_sealed), iv: fromBytea(a.snapshot_iv) }, `agreement-snapshot:${a.id}`)) as Snapshot;
  } catch {
    return null;
  }
}

export async function agreementsFor(ctx: AuthContext, recordId: string): Promise<AgreementsPanelData> {
  await requireView(ctx, recordId);
  const supabase = await createSupabaseServerClient();
  const [rows, signerRows, fileRows, kinds, canSend, config] = await Promise.all([
    supabase.from('agreements').select('id, number, kind, status, test_mode, sent_by, sent_at, expires_at, completed_at, declined_at, decline_reason, expired_at, voided_at, used_field_keys, download_status').eq('record_id', recordId).order('sent_at', { ascending: false }),
    supabase.from('agreement_signers').select('id, agreement_id, slot, name, email, ownership_pct, status, viewed_at, signed_at, declined_at, decline_reason, bounced_at, resent_at').eq('record_id', recordId).order('slot'),
    supabase.from('agreement_files').select('id, agreement_id, kind, name, size_bytes').eq('record_id', recordId),
    activeKinds(),
    canSendAgreements(ctx),
    loadConfig(),
  ]);
  if (rows.error) throw rows.error;
  const hidden = await hiddenFieldKeysFor(ctx, recordId, config.fields);
  const kindLabel = (k: string) => kinds.find((x) => x.key === k)?.label ?? k;

  const items: AgreementView[] = ((rows.data ?? []) as Record<string, unknown>[]).map((r) => {
    const used = (r.used_field_keys as string[]) ?? [];
    // The PDF opens only for a viewer who may see every field printed on it.
    const canOpen = used.every((k) => !hidden.has(k));
    return {
      id: r.id as string,
      label: agrLabel(r.number as number),
      kindLabel: kindLabel(r.kind as string),
      status: r.status as AgreementStatus,
      testMode: Boolean(r.test_mode),
      sentBy: (r.sent_by as string | null) ?? null,
      sentAt: r.sent_at as string,
      expiresAt: r.expires_at as string,
      completedAt: (r.completed_at as string | null) ?? null,
      declinedAt: (r.declined_at as string | null) ?? null,
      declineReason: (r.decline_reason as string | null) ?? null,
      expiredAt: (r.expired_at as string | null) ?? null,
      voidedAt: (r.voided_at as string | null) ?? null,
      downloadStatus: r.download_status as AgreementView['downloadStatus'],
      signers: ((signerRows.data ?? []) as Record<string, unknown>[])
        .filter((s) => s.agreement_id === r.id)
        .map((s) => ({
          id: s.id as string,
          slot: s.slot as number,
          name: s.name as string,
          email: s.email as string,
          percentage: (s.ownership_pct as number | null) ?? null,
          status: s.status as SignerStatus,
          at: ((s.signed_at ?? s.declined_at ?? s.bounced_at ?? s.viewed_at) as string | null) ?? null,
          declineReason: (s.decline_reason as string | null) ?? null,
        })),
      files: ((fileRows.data ?? []) as Record<string, unknown>[])
        .filter((f) => f.agreement_id === r.id)
        .map((f) => ({ id: f.id as string, kind: f.kind as FileView['kind'], name: f.name as string, sizeBytes: f.size_bytes as number, canOpen })),
    };
  });

  // The change banner: the open agreement's snapshot against the record now.
  let changes: ChangeView[] | null = null;
  const openRow = items.find((i) => isOpen(i.status));
  if (openRow) {
    const full = await agreementById(openRow.id);
    const snap = full ? openSnapshot(full) : null;
    const found = await sourceFor(recordId);
    if (snap && found) {
      changes = diffSnapshot(snap, found.src)
        .filter((c) => !hidden.has(c.key))
        .map((c) => {
          const f = config.fields.find((x) => x.key === c.key);
          const member = c.member && f?.repeatSchema ? (f.repeatSchema as { key: string; label: string; sensitive?: boolean }[]).find((m) => m.key === c.member) : undefined;
          const masked = Boolean(f?.sensitive || member?.sensitive);
          const label = [f?.label ?? c.key, c.index !== undefined ? `#${c.index + 1}` : null, member?.label ?? null, c.kind === 'address' ? 'address' : c.kind === 'note' ? 'note' : null].filter(Boolean).join(' · ');
          return { label, before: showValue(c.before, masked), after: showValue(c.after, masked) };
        });
    }
  }

  return { items, kinds: kinds.map((k) => ({ key: k.key, label: k.label })), canSend, configured: agreementsConfigured, changes, openId: openRow?.id ?? null };
}

/** The sealed PDF, for a viewer who may see every field printed on it. */
export async function openAgreementPdf(ctx: AuthContext, fileId: string): Promise<{ name: string; bytes: Buffer }> {
  const supabase = await createSupabaseServerClient();
  const { data: visible } = await supabase.from('agreement_files').select('id, agreement_id, record_id, name').eq('id', fileId).maybeSingle();
  if (!visible) throw new AgreementError('Not found.');
  const recordId = visible.record_id as string;
  await requireView(ctx, recordId);
  const a = await agreementById(visible.agreement_id as string);
  if (!a) throw new AgreementError('Not found.');
  const config = await loadConfig();
  const hidden = await hiddenFieldKeysFor(ctx, recordId, config.fields);
  if (a.used_field_keys.some((k) => hidden.has(k))) throw new AgreementError('This PDF holds values from a section you cannot see.');
  const { data: row } = await supabaseAdmin().from('agreement_files').select('storage_path, iv').eq('id', fileId).single();
  const dl = await supabaseAdmin().storage.from(FILES_BUCKET).download(row!.storage_path as string);
  if (dl.error || !dl.data) throw new AgreementError('The PDF could not be read.');
  const bytes = openBytes({ data: Buffer.from(await dl.data.arrayBuffer()), iv: fromBytea(row!.iv) }, `agreement-file:${fileId}`);
  return { name: visible.name as string, bytes };
}

// ── settings (Admin › Presets) ────────────────────────────────────────────────

export async function readAgreementSettings(ctx: AuthContext): Promise<Settings & { configured: boolean; testMode: boolean }> {
  await assertAdminPage(ctx, 'presets');
  return { ...(await agreementSettings()), configured: agreementsConfigured, testMode: signwellTestMode };
}

export async function saveAgreementSettings(ctx: AuthContext, input: Settings): Promise<void> {
  await assertAdminPage(ctx, 'presets');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_agreement_settings', {
    p_expires_days: input.expiresDays,
    p_reminders: input.reminders,
    p_requester_name: input.requesterName,
    p_requester_email: input.requesterEmail,
    p_subject: input.emailSubject,
    p_message: input.emailMessage,
  });
  if (error) throw new AgreementError(error.code === '42501' || error.code === '23514' ? error.message : 'The settings could not be saved.');
}

export { TemplateMissingError };
export type { Signer, SignerRow };
