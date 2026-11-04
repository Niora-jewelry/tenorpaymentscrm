/**
 * The daily sync (spec, Connection and sync): 7:00 AM New York time, once a day.
 *
 *  - Merchants first, matched to records by MID; an unknown one is left
 *    unmatched for review (the flag).
 *  - A merchant seen for the first time is read back two weeks; after that only
 *    what is new or changed since the last successful run.
 *  - Transactions, batches, payouts, ACH, statements, tickets and the
 *    application status come in through the same run.
 *  - A failed or partial run: the last success stays as it was, the error is
 *    kept per data type, and everyone with "Receive Maverick sync-failure
 *    alerts" is notified. The next day's run retries by itself.
 *
 * Vercel's clock is UTC, so the cron fires at 11:00 and 12:00 UTC and only the
 * one that lands on 7 o'clock in New York runs; `processor_sync_runs` holds one
 * row per New York day, so a repeat does nothing.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { MID_FIELD_KEY, type DataType } from './service';
import { ADAPTER_READY, PROCESSOR, PROCESSOR_LABEL, ProcessorNotReady, processorConnected, processorVendor, type ProcessorVendor, type VendorMerchant } from './vendor';

const db = () => supabaseAdmin();
const FIRST_LOOKBACK_DAYS = 14;

export const newYorkHour = (now: Date): number => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(now));
export const newYorkDay = (now: Date): string => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

type Outcome = { ok: boolean; added?: number; error?: string };

async function markState(type: DataType, ok: boolean, error: string | null, at: Date): Promise<void> {
  const patch: Record<string, string | null> = ok
    ? { processor: PROCESSOR, data_type: type, last_success_at: at.toISOString(), last_attempt_at: at.toISOString(), last_error: null }
    : { processor: PROCESSOR, data_type: type, last_attempt_at: at.toISOString(), last_error: (error ?? 'Failed').slice(0, 500) };
  const { error: e } = await db().from('processor_sync_state').upsert(patch, { onConflict: 'processor,data_type' });
  if (e) throw e;
}

async function lastSuccessOf(type: DataType): Promise<Date | null> {
  const { data } = await db().from('processor_sync_state').select('last_success_at').eq('processor', PROCESSOR).eq('data_type', type).maybeSingle();
  return data?.last_success_at ? new Date(data.last_success_at as string) : null;
}

const plain = (e: unknown): string => (e instanceof ProcessorNotReady ? e.message : e instanceof Error && e.name === 'ProcessorError' ? e.message : `${PROCESSOR_LABEL} could not be reached.`);

/** Merchants: upsert, then match each unmatched one to the record carrying its MID. */
async function syncMerchants(vendor: ProcessorVendor): Promise<{ merchants: { id: string; m: VendorMerchant; recordId: string | null; backfilled: boolean }[]; added: number }> {
  const list = await vendor.merchants();
  let added = 0;
  const out: { id: string; m: VendorMerchant; recordId: string | null; backfilled: boolean }[] = [];
  for (const m of list) {
    const { data: row, error } = await db()
      .from('processor_merchants')
      .upsert({ processor: PROCESSOR, external_id: m.externalId, mid: m.mid, name: m.name, last_seen_at: new Date().toISOString() }, { onConflict: 'processor,external_id' })
      .select('id, record_id, backfilled_at')
      .single();
    if (error) throw error;
    let recordId = row.record_id as string | null;
    if (!recordId && m.mid) {
      const { data: rec } = await db().from('records').select('id').eq(`values->>${MID_FIELD_KEY}`, m.mid).is('deleted_at', null).limit(2);
      // Exactly one record with that MID: matched. None or several: left for a person.
      if (rec && rec.length === 1) {
        const { error: matchError } = await db().rpc('processor_match_merchant', { p_merchant: row.id, p_record: rec[0]!.id, p_actor: null });
        if (matchError) throw matchError;
        recordId = rec[0]!.id as string;
        added++;
      }
    }
    out.push({ id: row.id as string, m, recordId, backfilled: Boolean(row.backfilled_at) });
  }
  return { merchants: out, added };
}

const since = (backfilled: boolean, last: Date | null, now: Date) =>
  backfilled && last ? last : new Date(now.getTime() - FIRST_LOOKBACK_DAYS * 86_400_000);

/** One run. `force` skips the 7 o'clock check (the connection page's "Sync now"). */
export async function runProcessorSync(now = new Date(), { force = false } = {}): Promise<{ ran: boolean; outcome?: string; reason?: string }> {
  if (!force && newYorkHour(now) !== 7) return { ran: false, reason: 'not 7 AM in New York' };
  if (!(await processorConnected())) return { ran: false, reason: 'not connected' };
  if (!ADAPTER_READY) return { ran: false, reason: 'the Maverick adapter is not wired yet' };

  const { data: run, error: runError } = await db()
    .from('processor_sync_runs')
    .insert({ processor: PROCESSOR, run_day: newYorkDay(now) })
    .select('id')
    .maybeSingle();
  if (runError) {
    if (runError.code === '23505' && !force) return { ran: false, reason: 'already ran today' };
    if (runError.code !== '23505') throw runError;
  }
  const runId = (run?.id as string | undefined) ?? null;

  const summary: Partial<Record<DataType, Outcome>> = {};
  let vendor: ProcessorVendor;
  try {
    vendor = await processorVendor();
  } catch (e) {
    summary.merchants = { ok: false, error: plain(e) };
    return finish(runId, summary, now);
  }

  let merchants: Awaited<ReturnType<typeof syncMerchants>>['merchants'] = [];
  try {
    const r = await syncMerchants(vendor);
    merchants = r.merchants;
    summary.merchants = { ok: true, added: r.added };
    await markState('merchants', true, null, now);
  } catch (e) {
    summary.merchants = { ok: false, error: plain(e) };
    await markState('merchants', false, plain(e), now);
    return finish(runId, summary, now);
  }

  const matched = merchants.filter((x) => x.recordId);
  const steps: { type: DataType; table: string; pull: (m: VendorMerchant, from: Date) => Promise<Record<string, unknown>[]> }[] = [
    {
      type: 'transactions', table: 'processor_transactions',
      pull: async (m, from) => (await vendor.transactions(m, from)).map((t) => ({
        external_id: t.externalId, card_type: t.cardType, card_brand: t.cardBrand,
        // Never more than the last four, whatever the processor sends.
        card_last4: t.cardLast4 && /^\d{4}$/.test(t.cardLast4.slice(-4)) ? t.cardLast4.slice(-4) : null,
        amount: t.amount, terminal_id: t.terminalId, transaction_type: t.transactionType, message_type: t.messageType,
        payment_type: t.paymentType, authorized_at: t.authorizedAt, response_code: t.responseCode, status: t.status,
      })),
    },
    { type: 'batches', table: 'processor_batches', pull: async (m, from) => (await vendor.batches(m, from)).map((b) => ({ external_id: b.externalId, batch_date: b.batchDate, amount: b.amount, sales: b.sales, credits: b.credits, batch_count: b.batchCount })) },
    {
      type: 'payouts', table: 'processor_payouts',
      pull: async (m, from) => (await vendor.payouts(m, from)).map((p) => ({
        external_id: p.externalId, payout_date: p.payoutDate, deposit_amount: p.depositAmount, chargeback_count: p.chargebackCount, chargeback_amount: p.chargebackAmount,
        non_settled_amount: p.nonSettledAmount, fee_amount: p.feeAmount, reserve_amount: p.reserveAmount, released_amount: p.releasedAmount,
      })),
    },
    { type: 'ach', table: 'processor_ach_transactions', pull: async (m, from) => (await vendor.ach(m, from)).map((a) => ({ external_id: a.externalId, transaction_type: a.transactionType, amount: a.amount, contact_name: a.contactName, memo: a.memo, status: a.status, transaction_date: a.transactionDate, created_on: a.createdOn })) },
    {
      type: 'tickets', table: 'processor_tickets',
      pull: async (m, from) => (await vendor.tickets(m, from)).map((t) => ({ external_id: t.externalId, mid: t.mid, title: t.title, status: t.status, details: t.details.slice(0, 60), opened_at: t.openedAt, changed_at: t.changedAt })),
    },
  ];

  for (const step of steps) {
    const last = await lastSuccessOf(step.type);
    try {
      let added = 0;
      for (const x of merchants) {
        const rows = await step.pull(x.m, since(x.backfilled, last, now));
        if (!rows.length) continue;
        const { error } = await db()
          .from(step.table)
          .upsert(rows.map((r) => ({ ...r, processor: PROCESSOR, merchant_id: x.id, record_id: x.recordId, synced_at: now.toISOString() })), { onConflict: 'processor,external_id' });
        if (error) throw error;
        added += rows.length;
      }
      summary[step.type] = { ok: true, added };
      await markState(step.type, true, null, now);
    } catch (e) {
      summary[step.type] = { ok: false, error: plain(e) };
      await markState(step.type, false, plain(e), now);
    }
  }

  // Statements land in the Statements tab by month; that step is wired with the API.
  try {
    for (const x of matched) await vendor.statements(x.m, since(x.backfilled, await lastSuccessOf('statements'), now));
    summary.statements = { ok: true, added: 0 };
    await markState('statements', true, null, now);
  } catch (e) {
    summary.statements = { ok: false, error: plain(e) };
    await markState('statements', false, plain(e), now);
  }

  // Application status, for every record that has been sent.
  try {
    const { data: apps, error } = await db().from('processor_applications').select('record_id, external_id').eq('processor', PROCESSOR).not('external_id', 'is', null);
    if (error) throw error;
    let changed = 0;
    for (const a of apps ?? []) {
      const s = await vendor.applicationStatus(a.external_id as string);
      const { data: did, error: setError } = await db().rpc('processor_set_application_status', { p_processor: PROCESSOR, p_record: a.record_id, p_external_id: s.externalId, p_status: s.status, p_label: s.label });
      if (setError) throw setError;
      if (did) changed++;
    }
    summary.application_status = { ok: true, added: changed };
    await markState('application_status', true, null, now);
  } catch (e) {
    summary.application_status = { ok: false, error: plain(e) };
    await markState('application_status', false, plain(e), now);
  }

  // First pull done: from now on only what is new.
  const fresh = merchants.filter((x) => !x.backfilled).map((x) => x.id);
  if (fresh.length) await db().from('processor_merchants').update({ backfilled_at: now.toISOString() }).in('id', fresh);

  return finish(runId, summary, now);
}

async function finish(runId: string | null, summary: Partial<Record<DataType, Outcome>>, now: Date): Promise<{ ran: true; outcome: string }> {
  const results = Object.values(summary);
  const failed = results.filter((r) => !r.ok);
  const outcome = failed.length === 0 ? 'ok' : failed.length === results.length ? 'failed' : 'partial';
  if (runId) await db().from('processor_sync_runs').update({ finished_at: new Date().toISOString(), outcome, summary }).eq('id', runId);
  if (failed.length) {
    const what = (Object.entries(summary) as [DataType, Outcome][]).filter(([, r]) => !r.ok).map(([t]) => t.replace('_', ' ')).join(', ');
    const first = failed[0]?.error ?? 'Unknown error';
    const { error } = await db().rpc('processor_alert', {
      p_body: `${PROCESSOR_LABEL} sync ${outcome === 'failed' ? 'failed' : 'partly failed'} (${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium' }).format(now)}): ${what}. The next run retries automatically.`,
      p_preview: first,
    });
    if (error) console.error('[processors] alert failed', error.code);
  }
  return { ran: true, outcome };
}
