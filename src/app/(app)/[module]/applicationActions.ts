'use server';

/**
 * Prepopulated Application — the CRM user's actions. Parse, then hand to the
 * service, which asks the gate (Applications tab, field grants, own Outlook
 * mailbox). Nothing here decides who may do what.
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import {
  ApplicationError,
  decide,
  enterAnswersByHand,
  prepareCrmUpload,
  resendApplication,
  sendApplication,
  sendDefaults,
  dropIncoming,
  readIncoming,
  uploadReturnedPdf,
  voidApplication,
  type SendDefaults,
  type UploadOutcome,
} from '@/lib/applications/service';
import { TemplateMissingError } from '@/lib/applications/pdf';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

const uuid = z.uuid();
const email = z.string().trim().toLowerCase().max(254);
const Compose = z.object({
  mailboxId: uuid,
  to: email.min(3),
  cc: z.array(email).max(20),
  subject: z.string().trim().min(1, 'Add a subject.').max(200),
  body: z.string().trim().min(1, 'Add a message.').max(5000),
});

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ApplicationError || e instanceof TemplateMissingError) return { ok: false, message: e.message };
    if (e instanceof Error && /No (edit )?access/.test(e.message)) return { ok: false, message: 'You do not have access to do that on this record.' };
    console.error('[applications]', fallback, e instanceof Error ? e.message.slice(0, 300) : e);
    return { ok: false, message: fallback };
  }
}
const refresh = () => revalidatePath('/[module]', 'page');

export async function sendDefaultsAction(recordId: string): Promise<Result<SendDefaults>> {
  const id = uuid.safeParse(recordId);
  if (!id.success) return { ok: false, message: 'That record is not valid.' };
  const ctx = await authorize();
  return run(() => sendDefaults(ctx, id.data), 'Could not prepare the application.');
}

export async function sendApplicationAction(input: z.input<typeof Compose> & { recordId: string }): Promise<Result<{ label: string }>> {
  const parsed = Compose.extend({ recordId: uuid }).safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Something in the message is not valid.' };
  const ctx = await authorize();
  const r = await run(() => sendApplication(ctx, parsed.data), 'The application was not sent. Try again.');
  if (r.ok) refresh();
  return r.ok ? { ok: true, data: { label: r.data.label } } : r;
}

export async function resendApplicationAction(input: z.input<typeof Compose> & { applicationId: string }): Promise<Result<null>> {
  const parsed = Compose.extend({ applicationId: uuid }).safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Something in the message is not valid.' };
  const ctx = await authorize();
  const { applicationId, ...rest } = parsed.data;
  const r = await run(() => resendApplication(ctx, applicationId, rest), 'The application was not sent. Try again.');
  if (r.ok) refresh();
  return r.ok ? { ok: true, data: null } : r;
}

export async function voidApplicationAction(applicationId: string): Promise<Result<null>> {
  const id = uuid.safeParse(applicationId);
  if (!id.success) return { ok: false, message: 'That application is not valid.' };
  const ctx = await authorize();
  const r = await run(() => voidApplication(ctx, id.data), 'Could not void the application.');
  if (r.ok) refresh();
  return r.ok ? { ok: true, data: null } : r;
}

export async function prepareApplicationUploadAction(recordId: string): Promise<Result<{ path: string; token: string }>> {
  const id = uuid.safeParse(recordId);
  if (!id.success) return { ok: false, message: 'That record is not valid.' };
  const ctx = await authorize();
  return run(() => prepareCrmUpload(ctx, id.data), 'Could not prepare the upload.');
}

const Finish = z.object({
  recordId: uuid,
  applicationId: uuid.nullable(),
  path: z.string().regex(/^incoming\/[0-9a-f-]{36}\.pdf$/),
  name: z.string().trim().min(1).max(255),
});

/**
 * Reads the staged PDF and imports it. When the user must first say which
 * application it belongs to (`choose`), the staged file is kept so the same
 * upload can be finished with their answer; otherwise it is removed.
 */
export async function finishApplicationUploadAction(input: z.input<typeof Finish>): Promise<Result<UploadOutcome>> {
  const parsed = Finish.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That upload is not valid.' };
  const ctx = await authorize();
  const r = await run(async () => {
    const bytes = await readIncoming(parsed.data.path);
    try {
      const outcome = await uploadReturnedPdf(ctx, { recordId: parsed.data.recordId, applicationId: parsed.data.applicationId, name: parsed.data.name, bytes });
      if (outcome.kind !== 'choose') await dropIncoming(parsed.data.path);
      return outcome;
    } catch (e) {
      await dropIncoming(parsed.data.path);
      throw e;
    }
  }, 'The PDF could not be imported. Try again.');
  if (r.ok) refresh();
  return r;
}

/** The user closed the "which application?" question without choosing. */
export async function discardApplicationUploadAction(path: string): Promise<void> {
  const ctx = await authorize();
  void ctx;
  if (/^incoming\/[0-9a-f-]{36}\.pdf$/.test(path)) await dropIncoming(path);
}

const Decisions = z.object({
  applicationId: uuid,
  decisions: z
    .array(z.object({ changeId: uuid, decision: z.enum(['accept', 'keep']), pick: z.number().int().min(0).max(20).optional() }))
    .min(1)
    .max(500),
});

export async function decideAction(input: z.input<typeof Decisions>): Promise<Result<{ remaining: number }>> {
  const parsed = Decisions.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Those choices are not valid.' };
  const ctx = await authorize();
  const r = await run(() => decide(ctx, parsed.data.applicationId, parsed.data.decisions), 'Those choices were not saved. Try again.');
  if (r.ok) {
    refresh();
    revalidatePath(`/applications/${parsed.data.applicationId}`);
  }
  return r;
}

export async function enterByHandAction(input: { applicationId: string; answers: unknown }): Promise<Result<{ applied: number; pending: number }>> {
  const id = uuid.safeParse(input?.applicationId);
  if (!id.success) return { ok: false, message: 'That application is not valid.' };
  const ctx = await authorize();
  const r = await run(() => enterAnswersByHand(ctx, id.data, input.answers), 'The answers were not saved. Try again.');
  if (r.ok) {
    refresh();
    revalidatePath(`/applications/${id.data}`);
  }
  return r;
}
