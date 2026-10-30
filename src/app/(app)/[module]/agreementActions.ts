'use server';

/**
 * Agreements — the CRM user's actions. Parse, then hand to the service,
 * which asks the gate (the Agreements tab, the "Send agreement" permission,
 * the fields printed). Sending itself goes through POST /api/agreements/send.
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import {
  AgreementError,
  TemplateMissingError,
  preSendCheck,
  resendToSigner,
  retryDownload,
  sendReminder,
  voidAgreement,
  type PreSendResult,
} from '@/lib/agreements/service';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };
const uuid = z.uuid();

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof AgreementError || e instanceof TemplateMissingError) return { ok: false, message: e.message };
    if (e instanceof Error && /No (edit )?access/.test(e.message)) return { ok: false, message: 'You do not have access to do that on this record.' };
    console.error('[agreements]', fallback, e instanceof Error ? e.message.slice(0, 300) : e);
    return { ok: false, message: fallback };
  }
}
const refresh = () => revalidatePath('/[module]', 'page');

export async function preSendCheckAction(recordId: string, kind: string): Promise<Result<PreSendResult>> {
  const id = uuid.safeParse(recordId);
  const k = z.string().trim().min(1).max(60).safeParse(kind);
  if (!id.success || !k.success) return { ok: false, message: 'That record is not valid.' };
  const ctx = await authorize();
  return run(() => preSendCheck(ctx, id.data, k.data), 'Could not check the record.');
}

export async function voidAgreementAction(agreementId: string): Promise<Result<null>> {
  const id = uuid.safeParse(agreementId);
  if (!id.success) return { ok: false, message: 'That agreement is not valid.' };
  const ctx = await authorize();
  const r = await run(() => voidAgreement(ctx, id.data), 'The agreement could not be voided.');
  if (r.ok) refresh();
  return r.ok ? { ok: true, data: null } : r;
}

export async function sendReminderAction(agreementId: string): Promise<Result<null>> {
  const id = uuid.safeParse(agreementId);
  if (!id.success) return { ok: false, message: 'That agreement is not valid.' };
  const ctx = await authorize();
  const r = await run(() => sendReminder(ctx, id.data), 'The reminder was not sent.');
  if (r.ok) refresh();
  return r.ok ? { ok: true, data: null } : r;
}

export async function resendToSignerAction(agreementId: string, signerId: string): Promise<Result<{ email: string }>> {
  const a = uuid.safeParse(agreementId);
  const s = uuid.safeParse(signerId);
  if (!a.success || !s.success) return { ok: false, message: 'That signer is not valid.' };
  const ctx = await authorize();
  const r = await run(() => resendToSigner(ctx, a.data, s.data), 'The agreement was not resent.');
  if (r.ok) refresh();
  return r;
}

export async function retryDownloadAction(agreementId: string): Promise<Result<null>> {
  const id = uuid.safeParse(agreementId);
  if (!id.success) return { ok: false, message: 'That agreement is not valid.' };
  const ctx = await authorize();
  const r = await run(() => retryDownload(ctx, id.data), 'The download could not be retried.');
  if (r.ok) refresh();
  return r.ok ? { ok: true, data: null } : r;
}
