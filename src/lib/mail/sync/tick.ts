/**
 * One run of the sync engine — what the per-minute cron does.
 *
 *   1. Queue what is due (`mail_schedule_due`: tiers, unseeded folders, the
 *      hourly tree refresh).
 *   2. Lease mailboxes with due work, most urgent first, and drain three at
 *      a time until the budget runs out. The lease is sized to the remaining
 *      budget, so an overlapping tick can never pick up a mailbox this one
 *      is still working on.
 *   3. Prune old runs and finished queue rows.
 *
 * Idempotent and safe to overlap: every unit of work is a coalesced queue
 * row and every mailbox is held by at most one lease.
 */
import 'server-only';
import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { mailLog } from '../log';
import { drainMailbox, type ClaimedMailbox, type DrainResult } from './drain';

export type TickSummary = {
  scheduled: number;
  mailboxes: number;
  ok: number;
  throttled: number;
  failed: number;
  changed: number;
  ms: number;
};

const DEFAULT_BUDGET_MS = 240_000;
const CONCURRENCY = 3;
const CLAIM_BATCH = 6;
/** Stop starting new mailboxes this close to the end; let running ones finish. */
const TAIL_MS = 15_000;

export async function runTick(opts: { only?: string; budgetMs?: number; trigger?: string } = {}): Promise<TickSummary> {
  const t0 = Date.now();
  const deadline = t0 + (opts.budgetMs ?? DEFAULT_BUDGET_MS);
  const owner = `${opts.trigger ?? 'tick'}-${randomUUID()}`;
  const admin = supabaseAdmin();
  const summary: TickSummary = { scheduled: 0, mailboxes: 0, ok: 0, throttled: 0, failed: 0, changed: 0, ms: 0 };

  const { data: scheduled, error: schedErr } = await admin.rpc('mail_schedule_due');
  if (schedErr) mailLog('error', 'tick', 'schedule_failed', { code: schedErr.code });
  summary.scheduled = Number(scheduled ?? 0);

  const tally = (r: DrainResult) => {
    summary.mailboxes += 1;
    summary.changed += r.changed;
    if (r.status === 'ok') summary.ok += 1;
    else if (r.status === 'throttled') summary.throttled += 1;
    else summary.failed += 1;
  };

  while (Date.now() < deadline - TAIL_MS) {
    const leaseSeconds = Math.ceil((deadline - Date.now()) / 1000) + 30;
    const { data: claimed, error } = await admin.rpc('mail_claim_mailboxes', {
      p_owner: owner,
      p_limit: CLAIM_BATCH,
      p_lease_seconds: leaseSeconds,
      p_only: opts.only ?? null,
    });
    if (error) {
      mailLog('error', 'tick', 'claim_failed', { code: error.code });
      break;
    }
    const batch = (claimed ?? []) as ClaimedMailbox[];
    if (batch.length === 0) break;

    // A small pool: at most CONCURRENCY mailboxes talking to Graph at once.
    let next = 0;
    const worker = async () => {
      while (next < batch.length) {
        const mb = batch[next++];
        try {
          tally(await drainMailbox(mb, deadline - 5_000, owner, opts.trigger ?? 'tick'));
        } catch (e) {
          summary.mailboxes += 1;
          summary.failed += 1;
          mailLog('error', 'tick', 'drain_crashed', { mailboxId: mb.id, message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
          await admin.from('mail_mailboxes').update({ lease_until: null, lease_owner: null }).eq('id', mb.id).eq('lease_owner', owner);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, worker));
    if (opts.only) break;
  }

  if (summary.ok > 0) {
    await admin
      .from('mail_provider_health')
      .update({ state: 'up', down_since: null, last_success_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', 1)
      .neq('state', 'config_error');
  }
  const { error: pruneErr } = await admin.rpc('mail_prune');
  if (pruneErr) mailLog('warn', 'tick', 'prune_failed', { code: pruneErr.code });

  summary.ms = Date.now() - t0;
  return summary;
}
