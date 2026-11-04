'use server';

/**
 * Processor (Maverick) actions on a record: Reporting pages, Other cases, the
 * pre-send check and Send / Update. Parse, then hand to the service, which asks
 * the gate.
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import {
  openCaseForOtherCase,
  ProcessorAccessError,
  processorPreCheck,
  ProcessorServiceError,
  reportingRows,
  sendApplicationToProcessor,
  syncOtherCase,
  type ProcessorCheck,
} from '@/lib/processors/service';
import type { ReportPage } from '@/lib/processors/service';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

const uuid = z.uuid();

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ProcessorServiceError || e instanceof ProcessorAccessError) return { ok: false, message: e.message };
    if (e instanceof Error && /No (edit )?access/.test(e.message)) return { ok: false, message: 'You do not have access to do that on this record.' };
    console.error('[processors]', fallback, e instanceof Error ? e.message.slice(0, 300) : e);
    return { ok: false, message: fallback };
  }
}
const refresh = () => revalidatePath('/[module]', 'page');

const Filter = z.object({
  values: z.array(z.string().max(200)).max(200).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  last4: z.string().regex(/^\d{1,4}$/).optional(),
});
const Rows = z.object({
  recordId: uuid,
  view: z.enum(['transactions', 'batches', 'payouts', 'ach']),
  filters: z.record(z.string().regex(/^[a-z0-9_]{1,40}$/), Filter),
  page: z.number().int().min(0).max(10_000),
});

export async function reportingRowsAction(input: z.input<typeof Rows>): Promise<Result<ReportPage>> {
  const parsed = Rows.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That filter is not valid.' };
  const ctx = await authorize();
  const { recordId, view, filters, page } = parsed.data;
  return run(() => reportingRows(ctx, recordId, view, filters, page), 'Could not load the report.');
}

export async function syncOtherCaseAction(ticketId: string, caseId: string): Promise<Result<null>> {
  const t = uuid.safeParse(ticketId);
  const c = uuid.safeParse(caseId);
  if (!t.success || !c.success) return { ok: false, message: 'That case is not valid.' };
  const ctx = await authorize();
  const r = await run(async () => {
    await syncOtherCase(ctx, t.data, c.data);
    return null;
  }, 'Could not sync the case.');
  if (r.ok) refresh();
  return r;
}

const NewCase = z.object({
  ticketId: uuid,
  title: z.string().trim().min(1, 'Add a short title.').max(200),
  issue: z.string().trim().min(1, 'The Issue is required.').max(20_000),
});

export async function openCaseForOtherCaseAction(input: z.input<typeof NewCase>): Promise<Result<{ caseId: string }>> {
  const parsed = NewCase.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'That case is not valid.' };
  const ctx = await authorize();
  const r = await run(() => openCaseForOtherCase(ctx, parsed.data.ticketId, parsed.data.title, parsed.data.issue), 'Could not open the case.');
  if (r.ok) refresh();
  return r;
}

export async function processorPreCheckAction(recordId: string, forCheckTab: boolean): Promise<Result<ProcessorCheck>> {
  const id = uuid.safeParse(recordId);
  if (!id.success || typeof forCheckTab !== 'boolean') return { ok: false, message: 'That record is not valid.' };
  const ctx = await authorize();
  return run(() => processorPreCheck(ctx, id.data, { forCheckTab }), 'Could not run the check.');
}

export async function sendToProcessorAction(recordId: string): Promise<Result<{ action: 'create' | 'update' }>> {
  const id = uuid.safeParse(recordId);
  if (!id.success) return { ok: false, message: 'That record is not valid.' };
  const ctx = await authorize();
  const r = await run(() => sendApplicationToProcessor(ctx, id.data), 'Could not send. Nothing was sent.');
  refresh();
  return r;
}
