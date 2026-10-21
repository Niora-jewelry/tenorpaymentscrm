'use server';

/**
 * The rules screen. Reading needs the Email View grant and a mailbox the
 * person can see (RLS); changing needs Edit and is refused under "sign in
 * as". Outlook is asked for the current rules whenever the screen opens and
 * every minute while it stays open, so rules made in Outlook show up here.
 *
 * Properties of a rule the editor does not show are never taken from the
 * browser: they come from Outlook's copy of the rule and are written back
 * as they were.
 */
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { actingFor } from '@/lib/mail/acting';
import { MAIL_MESSAGES } from '@/lib/mail/messages';
import { mailLog } from '@/lib/mail/log';
import { GraphError } from '@/lib/mail/graph/transport';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';
import { isEmail } from '@/lib/mail/compose/recipients';
import { ACTION_FLAGS, IMPORTANCE, SENSITIVITY, entryFor, fromGraph, validate, type RuleForm } from '@/lib/mail/rules/model';
import { createRule, deleteRule, refreshRules, reorderRules, ruleView, RuleError, setRuleEnabled, updateRule, type RuleView, type RulesTarget } from '@/lib/mail/rules/server';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

export type RuleFolder = { graphId: string; name: string; depth: number; wellKnown: string | null };
export type RulesSnapshot = { rules: RuleView[]; folders: RuleFolder[]; syncedAt: string | null; stale: string | null };

const STALE_MS = 60_000;

async function target(mailboxId: string, mode: 'view' | 'edit'): Promise<{ t: RulesTarget; ctx: Awaited<ReturnType<typeof authorize>> } | { message: string }> {
  const ctx = await authorize();
  // Rules are mailbox content: "sign in as" sees health only, for reading as well as writing.
  if (await currentImpersonation()) return { message: MAIL_MESSAGES.impersonating };
  try {
    await requireEmailAccess(ctx, mode);
  } catch (e) {
    if (e instanceof EmailAccessError) return { message: e.message };
    throw e;
  }
  if (mode === 'edit') {
    const limit = await rateLimit(userKey('mail_action', ctx.userId), RATE_LIMITS.mailActionPerUser);
    if (!limit.allowed) return { message: MAIL_MESSAGES.busy(limit.retryAfterSeconds) };
  }
  // RLS read: proves the person may see this mailbox at all.
  const supabase = await createSupabaseServerClient();
  const { data: mb } = await supabase.from('mail_mailboxes').select('id').eq('id', mailboxId).maybeSingle();
  if (!mb) return { message: 'That mailbox isn’t available to you.' };
  const acting = await actingFor(ctx, mailboxId);
  if (!acting) return { message: 'Nobody’s Outlook connection can reach this mailbox right now. Reconnect it in Email settings.' };
  return { ctx, t: { mailboxId, graph: acting.graph, root: acting.root } };
}

function explain(e: unknown, area: string): { ok: false; message: string } {
  if (e instanceof RuleError) return { ok: false, message: e.message };
  if (e instanceof GraphError) {
    mailLog('warn', 'rules', `${area}_graph_failed`, { code: e.classified.code, status: e.status });
    const c = e.classified.code;
    if (c === 'throttled') return { ok: false, message: MAIL_MESSAGES.busy(e.classified.retryAfterSeconds ?? 10) };
    if (c === 'provider_down') return { ok: false, message: MAIL_MESSAGES.providerDown };
    if (c === 'not_found') return { ok: false, message: 'That rule is no longer in Outlook.' };
    if (c === 'scope_missing' || c === 'mailbox_access_removed') {
      return { ok: false, message: 'Outlook won’t let TapDash manage rules for this mailbox. Reconnect it, or ask your Microsoft admin for access.' };
    }
    if (c === 'rule_rejected' || e.status === 400) {
      const why = e.graphMessage ? `: ${e.graphMessage.replace(/\s+/g, ' ').slice(0, 200)}` : '. Check the folder and addresses, then try again.';
      return { ok: false, message: `Outlook rejected this rule${why}` };
    }
    return { ok: false, message: MAIL_MESSAGES.generic };
  }
  mailLog('error', 'rules', `${area}_failed`, { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
  return { ok: false, message: MAIL_MESSAGES.generic };
}

async function snapshot(mailboxId: string, stale: string | null): Promise<RulesSnapshot> {
  const supabase = await createSupabaseServerClient();
  const [{ data: rules }, { data: folders }, { data: mb }] = await Promise.all([
    supabase
      .from('mail_rules')
      .select('graph_id, display_name, sequence, is_enabled, is_read_only, has_error, conditions, exceptions, actions')
      .eq('mailbox_id', mailboxId)
      .order('sequence')
      .order('display_name'),
    supabase
      .from('mail_folders')
      .select('graph_id, display_name, depth, well_known, parent_folder_id, id')
      .eq('mailbox_id', mailboxId)
      .is('deleted_at', null),
    supabase.from('mail_mailboxes').select('rules_synced_at').eq('id', mailboxId).maybeSingle(),
  ]);
  return {
    rules: (rules ?? []).map((r) => ruleView(r as Parameters<typeof ruleView>[0])),
    folders: treeOrder((folders ?? []) as Array<{ id: string; graph_id: string; display_name: string; depth: number; well_known: string | null; parent_folder_id: string | null }>),
    syncedAt: (mb?.rules_synced_at as string | null) ?? null,
    stale,
  };
}

/** Folders in the order the folder pane shows them: Inbox first, then each folder followed by its children. */
function treeOrder(rows: Array<{ id: string; graph_id: string; display_name: string; depth: number; well_known: string | null; parent_folder_id: string | null }>): RuleFolder[] {
  const RANK: Record<string, number> = { inbox: 0, drafts: 1, sentitems: 2, archive: 3, deleteditems: 4, junkemail: 5 };
  const kids = new Map<string | null, typeof rows>();
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (r.well_known === 'outbox') continue;
    const p = r.parent_folder_id && ids.has(r.parent_folder_id) ? r.parent_folder_id : null;
    kids.set(p, [...(kids.get(p) ?? []), r]);
  }
  const out: RuleFolder[] = [];
  const walk = (parent: string | null, depth: number) => {
    const list = (kids.get(parent) ?? []).sort(
      (a, b) => (RANK[a.well_known ?? ''] ?? 9) - (RANK[b.well_known ?? ''] ?? 9) || a.display_name.localeCompare(b.display_name),
    );
    for (const r of list) {
      out.push({ graphId: r.graph_id, name: r.display_name, depth, wellKnown: r.well_known });
      walk(r.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export async function rulesAction(input: { mailboxId: string; refresh?: boolean }): Promise<Result<RulesSnapshot>> {
  const parsed = z.object({ mailboxId: z.uuid(), refresh: z.boolean().optional() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await target(parsed.data.mailboxId, 'view');
  if ('message' in g) return { ok: false, message: g.message };
  let stale: string | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data: mb } = await supabase.from('mail_mailboxes').select('rules_synced_at').eq('id', parsed.data.mailboxId).maybeSingle();
    const age = mb?.rules_synced_at ? Date.now() - Date.parse(mb.rules_synced_at as string) : Infinity;
    if (parsed.data.refresh || age > STALE_MS) await refreshRules(g.t);
  } catch (e) {
    // Show what we have, and say why it may be behind.
    stale = explain(e, 'refresh').message;
  }
  return { ok: true, data: await snapshot(parsed.data.mailboxId, stale) };
}

// ── input ─────────────────────────────────────────────────────────────────

const Person = z.object({ name: z.string().max(200).default(''), address: z.string().trim().toLowerCase().max(254).refine(isEmail, 'Not an email address') });
const Value = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('words'), words: z.array(z.string().trim().min(1).max(255)).max(100) }),
  z.object({ kind: z.literal('people'), people: z.array(Person).max(100) }),
  z.object({ kind: z.literal('flag') }),
  z.object({ kind: z.literal('importance'), value: z.enum(IMPORTANCE) }),
  z.object({ kind: z.literal('sensitivity'), value: z.enum(SENSITIVITY) }),
  z.object({ kind: z.literal('actionFlag'), value: z.enum(ACTION_FLAGS) }),
  z.object({ kind: z.literal('size'), min: z.number().int().min(0).max(10_000_000).nullable(), max: z.number().int().min(0).max(10_000_000).nullable() }),
  z.object({ kind: z.literal('folder'), folderId: z.string().max(400) }),
]);
const Row = z.object({ key: z.string().max(64), value: Value });
const FormInput = z.object({
  name: z.string().max(256),
  enabled: z.boolean(),
  conditions: z.array(Row).max(40),
  exceptions: z.array(Row).max(40),
  actions: z.array(Row).max(20),
});

/** Every row must be a catalogued key with the catalogued kind, each key once. */
function wellFormed(form: z.infer<typeof FormInput>): boolean {
  for (const section of ['conditions', 'exceptions', 'actions'] as const) {
    const seen = new Set<string>();
    for (const r of form[section]) {
      if (entryFor(section, r.key)?.kind !== r.value.kind || seen.has(r.key)) return false;
      seen.add(r.key);
    }
  }
  return true;
}

export async function saveRuleAction(input: { mailboxId: string; graphId: string | null; form: unknown }): Promise<Result<RulesSnapshot>> {
  const parsed = z.object({ mailboxId: z.uuid(), graphId: z.string().min(1).max(400).nullable(), form: FormInput }).safeParse(input);
  if (!parsed.success) {
    const bad = parsed.error.issues.some((i) => i.message === 'Not an email address');
    return { ok: false, message: bad ? 'One of the addresses isn’t valid.' : 'Something in this rule isn’t valid.' };
  }
  const { mailboxId, graphId } = parsed.data;
  if (!wellFormed(parsed.data.form)) return { ok: false, message: 'Something in this rule isn’t valid.' };
  const g = await target(mailboxId, 'edit');
  if ('message' in g) return { ok: false, message: g.message };

  try {
    const supabase = await createSupabaseServerClient();
    // Extras come from Outlook's copy, never from the browser.
    let extra: RuleForm['extra'] = { conditions: {}, exceptions: {}, actions: {} };
    if (graphId) {
      const { data: prev } = await supabase
        .from('mail_rules')
        .select('display_name, is_enabled, conditions, exceptions, actions')
        .eq('mailbox_id', mailboxId)
        .eq('graph_id', graphId)
        .maybeSingle();
      if (!prev) return { ok: false, message: 'That rule is no longer in Outlook.' };
      extra = fromGraph({
        conditions: prev.conditions as Record<string, unknown> | null,
        exceptions: prev.exceptions as Record<string, unknown> | null,
        actions: prev.actions as Record<string, unknown> | null,
      }).extra;
    }
    const form: RuleForm = { ...parsed.data.form, extra };
    const problems = validate(form);
    if (problems.length) return { ok: false, message: problems[0] };

    // Folders must be this mailbox's own.
    const folderIds = [...form.actions].map((r) => (r.value.kind === 'folder' ? r.value.folderId : null)).filter((x): x is string => Boolean(x));
    if (folderIds.length) {
      const { data: found } = await supabase.from('mail_folders').select('graph_id').eq('mailbox_id', mailboxId).is('deleted_at', null).in('graph_id', folderIds);
      if ((found ?? []).length !== new Set(folderIds).size) return { ok: false, message: 'That folder is no longer in this mailbox. Choose another.' };
    }

    if (graphId) await updateRule(g.t, graphId, form);
    else await createRule(g.t, form);
    return { ok: true, data: await snapshot(mailboxId, null) };
  } catch (e) {
    return explain(e, 'save');
  }
}

export async function deleteRuleAction(input: { mailboxId: string; graphId: string }): Promise<Result<RulesSnapshot>> {
  const parsed = z.object({ mailboxId: z.uuid(), graphId: z.string().min(1).max(400) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await target(parsed.data.mailboxId, 'edit');
  if ('message' in g) return { ok: false, message: g.message };
  try {
    await deleteRule(g.t, parsed.data.graphId);
    return { ok: true, data: await snapshot(parsed.data.mailboxId, null) };
  } catch (e) {
    return explain(e, 'delete');
  }
}

export async function toggleRuleAction(input: { mailboxId: string; graphId: string; enabled: boolean }): Promise<Result<RulesSnapshot>> {
  const parsed = z.object({ mailboxId: z.uuid(), graphId: z.string().min(1).max(400), enabled: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await target(parsed.data.mailboxId, 'edit');
  if ('message' in g) return { ok: false, message: g.message };
  try {
    await setRuleEnabled(g.t, parsed.data.graphId, parsed.data.enabled);
    return { ok: true, data: await snapshot(parsed.data.mailboxId, null) };
  } catch (e) {
    return explain(e, 'toggle');
  }
}

export async function reorderRulesAction(input: { mailboxId: string; order: string[] }): Promise<Result<RulesSnapshot>> {
  const parsed = z.object({ mailboxId: z.uuid(), order: z.array(z.string().min(1).max(400)).max(500) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await target(parsed.data.mailboxId, 'edit');
  if ('message' in g) return { ok: false, message: g.message };
  try {
    await reorderRules(g.t, parsed.data.order);
    return { ok: true, data: await snapshot(parsed.data.mailboxId, null) };
  } catch (e) {
    if (e instanceof RuleError) {
      // Outlook's order changed underneath: hand back the fresh list with the message.
      return { ok: false, message: e.message };
    }
    return explain(e, 'reorder');
  }
}
