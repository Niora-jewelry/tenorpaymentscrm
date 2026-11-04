'use server';

/**
 * The Maverick connection page: resolve unmatched merchants, and run the daily
 * sync now. Parse, then hand to the service, which asks the permission.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { need, processorPerms, ProcessorAccessError } from '@/lib/processors/access';
import { findRecordsForMatch, matchMerchant, ProcessorServiceError } from '@/lib/processors/service';
import { runProcessorSync } from '@/lib/processors/sync';
import { rateLimit, userKey } from '@/lib/security/rate-limit';
import { currentImpersonation } from '@/lib/auth/impersonation';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ProcessorServiceError || e instanceof ProcessorAccessError) return { ok: false, message: e.message };
    console.error('[processors] connection', fallback, e instanceof Error ? e.message.slice(0, 300) : e);
    return { ok: false, message: fallback };
  }
}

const Query = z.string().trim().max(80);

export async function findRecordsForMatchAction(query: string): Promise<Result<{ id: string; name: string; mid: string | null }[]>> {
  const q = Query.safeParse(query);
  if (!q.success) return { ok: false, message: 'That search is not valid.' };
  const ctx = await authorize();
  return run(() => findRecordsForMatch(ctx, q.data), 'Could not search records.');
}

const Match = z.object({ merchantId: z.uuid(), recordId: z.uuid() });

export async function matchMerchantAction(input: z.input<typeof Match>): Promise<Result<null>> {
  const parsed = Match.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'That match is not valid.' };
  const ctx = await authorize();
  const r = await run(async () => {
    await matchMerchant(ctx, parsed.data.merchantId, parsed.data.recordId);
    return null;
  }, 'Could not match the merchant.');
  if (r.ok) revalidatePath('/admin/maverick');
  return r;
}

/** Runs the daily sync now, whatever the hour. Same work, same alerts. */
export async function syncNowAction(): Promise<Result<{ ran: boolean; reason?: string; outcome?: string }>> {
  const ctx = await authorize();
  const r = await run(async () => {
    need((await processorPerms(ctx)).connection, 'run the Maverick sync');
    if (await currentImpersonation()) throw new ProcessorAccessError('Stop viewing as someone else first.');
    const limit = await rateLimit(userKey('processor_sync_now', ctx.userId), { limit: 3, windowSeconds: 3600 });
    if (!limit.allowed) throw new ProcessorServiceError('The sync has been run three times this hour. Try again later.');
    return runProcessorSync(new Date(), { force: true });
  }, 'Could not run the sync.');
  revalidatePath('/admin/maverick');
  return r;
}
