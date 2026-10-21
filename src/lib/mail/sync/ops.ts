/**
 * Carries queued `mail_ops` to Microsoft — the outbound half of two-way sync.
 *
 * Each op already happened locally (`mail_op_submit`); this makes Outlook
 * agree, in `$batch`es of 20, under the sign-in that submitted it. Outcomes:
 *
 *   2xx            done
 *   404            the message is already gone in Outlook: done, and the
 *                  message is re-read so our copy agrees
 *   409 / 412      Outlook changed it first: done, re-read — Outlook wins
 *   throttled      back in the queue after Retry-After; the run stops
 *   sign-in dead   left queued; the run stops (tokens.ts broke the identity)
 *   anything else  retried with backoff; after five attempts it fails, the
 *                  message is re-read (which undoes the local change) and
 *                  the person who did it gets an "action failed" notice
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { graphForIdentity } from '../tokens';
import { batchItemError, GraphError, type GraphRequest } from '../graph/transport';
import { nextSyncDelayMinutes } from '../backoff';
import { mailLog } from '../log';
import type { MailboxCtx } from './ingest';

const TAKE = 100;
const MAX_ATTEMPTS = 5;

type OpRow = {
  id: string;
  user_id: string;
  identity_id: string | null;
  kind: 'mark_read' | 'mark_unread' | 'move' | 'hard_delete';
  target_graph_id: string;
  payload: { dest_folder_id?: string; dest_graph_id?: string };
  attempts: number;
};

const VERB: Record<OpRow['kind'], string> = {
  mark_read: 'mark as read',
  mark_unread: 'mark as unread',
  move: 'move',
  hard_delete: 'delete',
};

function toRequest(root: string, op: OpRow): GraphRequest {
  const msg = `${root}/messages/${encodeURIComponent(op.target_graph_id)}`;
  switch (op.kind) {
    case 'mark_read':
    case 'mark_unread':
      return { method: 'PATCH', path: msg, body: { isRead: op.kind === 'mark_read' } };
    case 'move':
      return { method: 'POST', path: `${msg}/move`, body: { destinationId: op.payload.dest_graph_id } };
    case 'hard_delete':
      return { method: 'DELETE', path: msg };
  }
}

export type OpsResult = { ran: number; refetch: string[]; touchedFolders: Set<string>; stop: GraphError | null };

export async function runOps(mb: MailboxCtx, deadline: number): Promise<OpsResult> {
  const admin = supabaseAdmin();
  const result: OpsResult = { ran: 0, refetch: [], touchedFolders: new Set(), stop: null };

  // A run that died mid-batch leaves ops 'running'; after their five-minute
  // claim lapses they go back to the queue (re-sending is safe: every op is
  // idempotent on Graph's side — read is read, move to X is move to X).
  await admin
    .from('mail_ops')
    .update({ status: 'queued' })
    .eq('mailbox_id', mb.id)
    .eq('status', 'running')
    .lt('next_attempt_at', new Date().toISOString());

  const { data, error } = await admin
    .from('mail_ops')
    .select('id, user_id, identity_id, kind, target_graph_id, payload, attempts')
    .eq('mailbox_id', mb.id)
    .eq('status', 'queued')
    .lte('next_attempt_at', new Date().toISOString())
    .in('kind', ['mark_read', 'mark_unread', 'move', 'hard_delete'])
    .order('created_at', { ascending: true })
    .limit(TAKE);
  if (error) throw new Error(`mail_ops read failed: ${error.code ?? 'db'}`);
  const ops = (data ?? []) as OpRow[];
  if (ops.length === 0) return result;

  await admin
    .from('mail_ops')
    .update({ status: 'running', next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString() })
    .in('id', ops.map((o) => o.id));

  // One transport per acting sign-in (an admin's own connection vs. the driver).
  const byIdentity = new Map<string, OpRow[]>();
  for (const op of ops) {
    const key = op.identity_id ?? 'driver';
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), op]);
  }

  const done: string[] = [];
  const requeue: Array<{ op: OpRow; at: string; code: string }> = [];
  const failed: Array<{ op: OpRow; code: string }> = [];

  for (const [identity, group] of byIdentity) {
    if (result.stop || Date.now() >= deadline) {
      for (const op of group) requeue.push({ op, at: new Date().toISOString(), code: 'deferred' });
      continue;
    }
    const graph = identity === 'driver' ? mb.graph : graphForIdentity(identity);
    let answers;
    try {
      answers = await graph.batch(group.map((op) => toRequest(mb.root, op)));
    } catch (e) {
      // The batch call itself failed (token, network, throttling): nothing ran.
      const c = e instanceof GraphError ? e.classified : null;
      const wait = c?.retryAfterSeconds ? c.retryAfterSeconds * 1000 : 60_000;
      for (const op of group) requeue.push({ op, at: new Date(Date.now() + wait).toISOString(), code: c?.code ?? 'internal' });
      if (e instanceof GraphError && (c?.code === 'throttled' || c?.connection === 'broken' || c?.code === 'provider_down')) result.stop = e;
      continue;
    }

    group.forEach((op, i) => {
      result.ran += 1;
      const err = batchItemError(answers[i]);
      if (!err) {
        done.push(op.id);
        if (op.kind === 'move' && op.payload.dest_folder_id) result.touchedFolders.add(op.payload.dest_folder_id);
        return;
      }
      const c = err.classified;
      if (c.code === 'not_found' || c.code === 'conflict') {
        done.push(op.id);
        result.refetch.push(op.target_graph_id);
        return;
      }
      if (c.code === 'throttled') {
        requeue.push({ op, at: new Date(Date.now() + (c.retryAfterSeconds ?? 30) * 1000).toISOString(), code: c.code });
        result.stop ??= err;
        return;
      }
      if (op.attempts + 1 >= MAX_ATTEMPTS || c.code === 'scope_missing' || c.code === 'mailbox_access_removed') {
        failed.push({ op, code: c.code });
        result.refetch.push(op.target_graph_id);
        return;
      }
      requeue.push({ op, at: new Date(Date.now() + nextSyncDelayMinutes(op.attempts + 1) * 60_000).toISOString(), code: c.code });
    });
  }

  const now = new Date().toISOString();
  if (done.length) await admin.from('mail_ops').update({ status: 'done', done_at: now }).in('id', done);
  for (const r of requeue) {
    await admin
      .from('mail_ops')
      .update({ status: 'queued', attempts: r.op.attempts + (r.code === 'deferred' ? 0 : 1), next_attempt_at: r.at, last_error_code: r.code })
      .eq('id', r.op.id);
  }
  if (failed.length) {
    for (const f of failed) {
      await admin
        .from('mail_ops')
        .update({ status: 'failed', done_at: now, attempts: f.op.attempts + 1, last_error_code: f.code })
        .eq('id', f.op.id);
    }
    // One notice per person and kind, not one per message.
    const perUser = new Map<string, { kind: OpRow['kind']; n: number }>();
    for (const f of failed) {
      const k = `${f.op.user_id}:${f.op.kind}`;
      const cur = perUser.get(k);
      perUser.set(k, { kind: f.op.kind, n: (cur?.n ?? 0) + 1 });
    }
    for (const [k, v] of perUser) {
      const userId = k.split(':')[0];
      await admin.from('mail_notices').insert({
        user_id: userId,
        mailbox_id: mb.id,
        kind: 'action_failed',
        body: `Outlook didn't ${VERB[v.kind]} ${v.n === 1 ? 'a message' : `${v.n} messages`} in ${mb.address}. Showing what Outlook has.`.slice(0, 500),
      });
    }
    mailLog('warn', 'ops', 'ops_failed', { mailboxId: mb.id, count: failed.length });
  }
  return result;
}
