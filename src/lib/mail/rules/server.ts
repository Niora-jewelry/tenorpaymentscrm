/**
 * Outlook rules: Graph's messageRules on the mailbox's Inbox, cached in
 * `mail_rules` for the rules screen.
 *
 * Writes go straight to Graph (the person is waiting on the screen and
 * Outlook's refusal, if any, is the message they need), then the cache is
 * re-read from Graph so it always shows Outlook's truth — including rules
 * made or changed in Outlook since.
 */
import 'server-only';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { GraphTransport } from '../graph/transport';
import { fromGraph, planSequences, toGraph, type GraphRule, type RuleForm } from './model';

export type RulesTarget = { mailboxId: string; graph: GraphTransport; root: string };

const path = (root: string) => `${root}/mailFolders/inbox/messageRules`;

type Page = { value?: GraphRule[]; '@odata.nextLink'?: string };

/** Graph → cache. Returns how many rules Outlook has. */
export async function refreshRules(t: RulesTarget): Promise<number> {
  const admin = supabaseAdmin();
  const all: GraphRule[] = [];
  let req: { path: string } = { path: path(t.root) };
  for (let page = 0; page < 10; page += 1) {
    const res = (await t.graph.request<Page>(req)) ?? {};
    all.push(...(res.value ?? []).filter((r) => r.id));
    if (!res['@odata.nextLink']) break;
    req = { path: res['@odata.nextLink'] };
  }
  const now = new Date().toISOString();
  if (all.length) {
    const { error } = await admin.from('mail_rules').upsert(
      all.map((r) => ({
        mailbox_id: t.mailboxId,
        graph_id: r.id!,
        display_name: (r.displayName ?? '').slice(0, 256) || 'Untitled rule',
        sequence: Number.isFinite(r.sequence) ? Number(r.sequence) : 0,
        is_enabled: r.isEnabled !== false,
        is_read_only: Boolean(r.isReadOnly),
        has_error: Boolean(r.hasError),
        conditions: r.conditions ?? null,
        exceptions: r.exceptions ?? null,
        actions: r.actions ?? null,
        synced_at: now,
        deleted_at: null,
      })),
      { onConflict: 'mailbox_id,graph_id' },
    );
    if (error) throw new Error(`mail_rules upsert failed: ${error.code ?? 'db'}`);
  }
  const keep = all.map((r) => r.id!);
  let gone = admin.from('mail_rules').update({ deleted_at: now }).eq('mailbox_id', t.mailboxId).is('deleted_at', null);
  if (keep.length) gone = gone.not('graph_id', 'in', `(${keep.map((k) => `"${k.replace(/"/g, '')}"`).join(',')})`);
  await gone;
  await admin.from('mail_mailboxes').update({ rules_synced_at: now }).eq('id', t.mailboxId);
  return all.length;
}

async function cached(mailboxId: string, graphId: string): Promise<GraphRule | null> {
  const { data } = await supabaseAdmin()
    .from('mail_rules')
    .select('graph_id, display_name, sequence, is_enabled, is_read_only, conditions, exceptions, actions')
    .eq('mailbox_id', mailboxId)
    .eq('graph_id', graphId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.graph_id as string,
    displayName: data.display_name as string,
    sequence: data.sequence as number,
    isEnabled: data.is_enabled as boolean,
    isReadOnly: data.is_read_only as boolean,
    conditions: data.conditions as Record<string, unknown> | null,
    exceptions: data.exceptions as Record<string, unknown> | null,
    actions: data.actions as Record<string, unknown> | null,
  };
}

export class RuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuleError';
  }
}

export async function createRule(t: RulesTarget, form: RuleForm): Promise<void> {
  const { data } = await supabaseAdmin()
    .from('mail_rules')
    .select('sequence')
    .eq('mailbox_id', t.mailboxId)
    .is('deleted_at', null)
    .order('sequence', { ascending: false })
    .limit(1)
    .maybeSingle();
  const body = toGraph(form);
  await t.graph.request({ method: 'POST', path: path(t.root), body: { ...body, sequence: Number(data?.sequence ?? 0) + 1 } });
  await refreshRules(t);
}

export async function updateRule(t: RulesTarget, graphId: string, form: RuleForm): Promise<void> {
  const prev = await cached(t.mailboxId, graphId);
  if (!prev) throw new RuleError('That rule is no longer in Outlook.');
  if (prev.isReadOnly) throw new RuleError('Outlook marks this rule as read-only. Change it in Outlook.');
  await t.graph.request({ method: 'PATCH', path: `${path(t.root)}/${encodeURIComponent(graphId)}`, body: toGraph(form, prev) });
  await refreshRules(t);
}

export async function setRuleEnabled(t: RulesTarget, graphId: string, enabled: boolean): Promise<void> {
  const prev = await cached(t.mailboxId, graphId);
  if (!prev) throw new RuleError('That rule is no longer in Outlook.');
  await t.graph.request({ method: 'PATCH', path: `${path(t.root)}/${encodeURIComponent(graphId)}`, body: { isEnabled: enabled } });
  await refreshRules(t);
}

export async function deleteRule(t: RulesTarget, graphId: string): Promise<void> {
  const prev = await cached(t.mailboxId, graphId);
  if (prev?.isReadOnly) throw new RuleError('Outlook marks this rule as read-only. Delete it in Outlook.');
  await t.graph.request({ method: 'DELETE', path: `${path(t.root)}/${encodeURIComponent(graphId)}` });
  await refreshRules(t);
}

/**
 * New order, top first. Outlook runs rules by ascending `sequence`; only
 * rules whose number has to change are written, and read-only rules (which
 * the API may not touch) keep theirs — see planSequences.
 */
export async function reorderRules(t: RulesTarget, order: string[]): Promise<void> {
  const { data } = await supabaseAdmin()
    .from('mail_rules')
    .select('graph_id, display_name, sequence, is_read_only')
    .eq('mailbox_id', t.mailboxId)
    .is('deleted_at', null);
  const rows = (data ?? []) as Array<{ graph_id: string; display_name: string; sequence: number; is_read_only: boolean }>;
  const current = new Map(rows.map((r) => [r.graph_id, { sequence: r.sequence, readOnly: r.is_read_only }]));
  if (order.length !== current.size || order.some((id) => !current.has(id))) {
    throw new RuleError('The rules changed in Outlook meanwhile. Here is the current order — try again.');
  }
  const plan = planSequences(order, current);
  if ('blockedBy' in plan) {
    const name = rows.find((r) => r.graph_id === plan.blockedBy)?.display_name ?? 'a rule';
    throw new RuleError(`“${name}” can only be changed in Outlook, so other rules can’t be moved past it here. Reorder it in Outlook.`);
  }
  for (const c of plan.changes) {
    await t.graph.request({ method: 'PATCH', path: `${path(t.root)}/${encodeURIComponent(c.id)}`, body: { sequence: c.sequence } });
  }
  await refreshRules(t);
}

/** Cache rows → what the rules screen shows. */
export type RuleView = {
  graphId: string;
  name: string;
  sequence: number;
  enabled: boolean;
  readOnly: boolean;
  hasError: boolean;
  form: RuleForm;
};

export function ruleView(r: {
  graph_id: string;
  display_name: string;
  sequence: number;
  is_enabled: boolean;
  is_read_only: boolean;
  has_error: boolean;
  conditions: unknown;
  exceptions: unknown;
  actions: unknown;
}): RuleView {
  return {
    graphId: r.graph_id,
    name: r.display_name,
    sequence: r.sequence,
    enabled: r.is_enabled,
    readOnly: r.is_read_only,
    hasError: r.has_error,
    form: fromGraph({
      displayName: r.display_name,
      isEnabled: r.is_enabled,
      conditions: r.conditions as Record<string, unknown> | null,
      exceptions: r.exceptions as Record<string, unknown> | null,
      actions: r.actions as Record<string, unknown> | null,
    }),
  };
}
