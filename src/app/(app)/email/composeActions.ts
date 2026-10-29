'use server';

/**
 * Writing and sending mail.
 *
 * Gate on every action: signed in, not impersonating, Email Edit grant, rate
 * limited. The database functions behind them re-check that the mailbox is
 * one the person connected (mail_outbox_submit, mail_set_signature) — the
 * gate here only refuses earlier and more politely.
 *
 * Signatures never enter the editor (it cannot hold Outlook's tables and
 * inline styles faithfully): the composer previews it, and it is appended
 * here, exactly as stored, when a draft is saved or a message sent.
 */
import { after } from 'next/server';
import { z } from 'zod';
import { authorize, seesAll } from '@/lib/records/permissions';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { requireEmailAccess, EmailAccessError } from '@/lib/mail/access';
import { MAIL_MESSAGES } from '@/lib/mail/messages';
import { mailLog } from '@/lib/mail/log';
import { rateLimit, RATE_LIMITS, userKey } from '@/lib/security/rate-limit';
import { sanitizeEmail, sanitizeOutgoing } from '@/lib/mail/content/sanitize';
import { GraphError } from '@/lib/mail/graph/transport';
import { adoptDraft, ComposeError, discardDraft, forgetKept, saveDraft, senderFor } from '@/lib/mail/compose/drafts';
import { OUTBOX_BUCKET, sendDue } from '@/lib/mail/compose/send';
import { fromOptions, withSignature } from '@/lib/mail/compose/sender';
import { isEmail, likeEscape, replyRecipients, subjectFor } from '@/lib/mail/compose/recipients';
import type { Addr, ComposeInit, ComposeKind, ScheduledItem } from '@/lib/mail/viewTypes';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };
type Ctx = Awaited<ReturnType<typeof authorize>>;

async function gate(scope: 'mail_action' | 'mail_send' = 'mail_action'): Promise<{ ctx: Ctx } | { message: string }> {
  const ctx = await authorize();
  if (await currentImpersonation()) return { message: MAIL_MESSAGES.impersonating };
  try {
    await requireEmailAccess(ctx, 'edit');
  } catch (e) {
    if (e instanceof EmailAccessError) return { message: e.message };
    throw e;
  }
  const rules = scope === 'mail_send' ? [RATE_LIMITS.mailSendPerUserMinute, RATE_LIMITS.mailSendPerUserDay] : [RATE_LIMITS.mailActionPerUser];
  for (const [i, rule] of rules.entries()) {
    const limit = await rateLimit(userKey(`${scope}${i}`, ctx.userId), rule);
    if (!limit.allowed) {
      return { message: scope === 'mail_send' ? `You're sending faster than Outlook allows. Try again in ${limit.retryAfterSeconds} seconds.` : MAIL_MESSAGES.busy(limit.retryAfterSeconds) };
    }
  }
  return { ctx };
}

/** Reads: signed in, not impersonating, may see Email at all. */
async function readGate(): Promise<{ ctx: Ctx } | { message: string }> {
  const ctx = await authorize();
  if (await currentImpersonation()) return { message: MAIL_MESSAGES.impersonating };
  try {
    await requireEmailAccess(ctx, 'view');
  } catch (e) {
    if (e instanceof EmailAccessError) return { message: e.message };
    throw e;
  }
  return { ctx };
}

function explain(e: unknown, area: string): { ok: false; message: string } {
  if (e instanceof ComposeError) return { ok: false, message: e.message };
  if (e instanceof GraphError) {
    mailLog('warn', 'compose', `${area}_graph_failed`, { code: e.classified.code });
    return { ok: false, message: e.classified.code === 'not_found' ? 'That message is no longer in Outlook.' : messageForCode(e) };
  }
  mailLog('error', 'compose', `${area}_failed`, { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
  return { ok: false, message: MAIL_MESSAGES.generic };
}

function messageForCode(e: GraphError): string {
  const c = e.classified;
  if (c.code === 'throttled') return MAIL_MESSAGES.busy(c.retryAfterSeconds ?? 10);
  if (c.code === 'provider_down') return MAIL_MESSAGES.providerDown;
  if (c.code === 'reconnect_required') return 'Outlook needs you to reconnect this mailbox before you can send from it.';
  return MAIL_MESSAGES.generic;
}

const Recipient = z.object({ name: z.string().max(200).default(''), address: z.string().trim().toLowerCase().max(254).refine(isEmail, 'Not an email address') });
const Recipients = z.array(Recipient).max(500);
const Kind = z.enum(['new', 'reply', 'replyAll', 'forward']);

// ── starting ──────────────────────────────────────────────────────────────

const StartInput = z.object({
  kind: Kind,
  mailboxId: z.uuid().optional(),
  sourceMessageId: z.uuid().optional(),
  draftMessageId: z.uuid().optional(),
  /** A new message started from an Email field on a record (UI spec §4,
   *  "click to compose"): the address goes straight into To. */
  to: z.email().max(320).optional(),
});

export async function composeStartAction(input: z.input<typeof StartInput>): Promise<Result<ComposeInit>> {
  const parsed = StartInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const { kind, sourceMessageId, draftMessageId } = parsed.data;
  try {
    const options = await fromOptions(g.ctx);
    if (options.length === 0) return { ok: false, message: 'Connect a mailbox in Email settings before writing mail.' };
    const supabase = await createSupabaseServerClient();

    // Continuing a draft that is already in Drafts (from here or from Outlook).
    if (draftMessageId) {
      const { draftId, mailboxId, graphId, kept } = await adoptDraft(g.ctx, draftMessageId);
      const s = await senderFor(g.ctx, mailboxId);
      const live = await s.graph.request<{
        changeKey?: string;
        subject?: string;
        body?: { content?: string };
        toRecipients?: Array<{ emailAddress?: Addr }>;
        ccRecipients?: Array<{ emailAddress?: Addr }>;
        bccRecipients?: Array<{ emailAddress?: Addr }>;
      }>({
        path: `${s.root}/messages/${encodeURIComponent(graphId)}`,
        query: { $select: 'changeKey,subject,body,toRecipients,ccRecipients,bccRecipients' },
        headers: { Prefer: 'outlook.body-content-type="html"' },
      });
      const addrs = (l?: Array<{ emailAddress?: Addr }>) =>
        (l ?? []).map((r) => ({ name: r.emailAddress?.name ?? '', address: (r.emailAddress?.address ?? '').toLowerCase() })).filter((a) => a.address);
      const common = {
        draftId,
        mailboxId,
        fromOptions: options.filter((o) => o.mailboxId === mailboxId),
        to: addrs(live?.toRecipients),
        cc: addrs(live?.ccRecipients),
        bcc: addrs(live?.bccRecipients),
        subject: live?.subject ?? '',
      };
      // Untouched in Outlook since the CRM saved it: reopen exactly as it was left —
      // the words in the editor, the signature and Outlook's quote kept apart.
      if (kept?.changeKey && live?.changeKey === kept.changeKey) {
        const { data: src } = kept.sourceGraphId
          ? await supabase
              .from('mail_messages')
              .select('id, subject, from_name, from_address, received_at, sent_at')
              .eq('mailbox_id', mailboxId)
              .eq('graph_id', kept.sourceGraphId)
              .maybeSingle()
          : { data: null };
        return {
          ok: true,
          data: {
            ...common,
            kind: kept.kind,
            sourceMessageId: (src?.id as string | undefined) ?? null,
            html: kept.editorHtml,
            includeSignature: kept.includeSignature,
            source: src
              ? {
                  fromName: (src.from_name as string) ?? '',
                  fromAddress: (src.from_address as string) ?? '',
                  at: ((src.received_at ?? src.sent_at) as string) ?? '',
                  subject: (src.subject as string) ?? '',
                }
              : null,
          },
        };
      }
      // Written or changed in Outlook: its body already carries any signature and quote.
      if (kept) await forgetKept(draftId);
      return {
        ok: true,
        data: { ...common, kind: 'new', sourceMessageId: null, html: sanitizeOutgoing(live?.body?.content ?? ''), includeSignature: false, source: null },
      };
    }

    if (kind === 'new') {
      const { data: settings } = await supabase.from('mail_user_settings').select('default_from_mailbox_id').maybeSingle();
      const preferred = parsed.data.mailboxId ?? (settings?.default_from_mailbox_id as string | undefined);
      const from = options.find((o) => o.mailboxId === preferred) ?? options[0];
      const to = parsed.data.to ? [{ name: '', address: parsed.data.to.toLowerCase() }] : [];
      return { ok: true, data: { kind, draftId: null, sourceMessageId: null, mailboxId: from.mailboxId, fromOptions: options, to, cc: [], bcc: [], subject: '', html: '', source: null } };
    }

    if (!sourceMessageId) return { ok: false, message: 'Choose the message to answer.' };
    const { data: src } = await supabase
      .from('mail_messages')
      .select('id, mailbox_id, subject, from_name, from_address, to_recipients, cc_recipients, reply_to, direction, received_at, sent_at')
      .eq('id', sourceMessageId)
      .maybeSingle();
    if (!src) return { ok: false, message: 'That message is no longer here.' };
    const from = options.find((o) => o.mailboxId === src.mailbox_id);
    if (!from) return { ok: false, message: 'You can answer mail only from a mailbox you connected yourself.' };
    const recips = replyRecipients(
      {
        from: src.from_address ? { name: (src.from_name as string) ?? '', address: src.from_address as string } : null,
        replyTo: (src.reply_to as Addr[]) ?? [],
        to: (src.to_recipients as Addr[]) ?? [],
        cc: (src.cc_recipients as Addr[]) ?? [],
        outbound: src.direction === 'outbound',
      },
      from.address,
      kind,
    );
    return {
      ok: true,
      data: {
        kind,
        draftId: null,
        sourceMessageId,
        mailboxId: from.mailboxId,
        fromOptions: [from],
        to: recips.to,
        cc: recips.cc,
        bcc: [],
        subject: subjectFor(kind, (src.subject as string) ?? ''),
        html: '',
        source: {
          fromName: (src.from_name as string) ?? '',
          fromAddress: (src.from_address as string) ?? '',
          at: ((src.received_at ?? src.sent_at) as string) ?? '',
          subject: (src.subject as string) ?? '',
        },
      },
    };
  } catch (e) {
    return explain(e, 'start');
  }
}

// ── drafts ────────────────────────────────────────────────────────────────

const DraftInput = z.object({
  draftId: z.uuid().nullable(),
  mailboxId: z.uuid(),
  kind: Kind,
  sourceMessageId: z.uuid().nullable(),
  subject: z.string().max(255),
  html: z.string().max(1_000_000),
  includeSignature: z.boolean(),
  to: Recipients,
  cc: Recipients,
  bcc: Recipients,
});

/** Autosave: creates the Outlook draft the first time, updates it after. */
export async function saveDraftAction(input: z.input<typeof DraftInput>): Promise<Result<{ draftId: string; savedAt: string }>> {
  const parsed = DraftInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Some addresses aren’t valid yet — the draft will save once they are.' };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  try {
    const d = parsed.data;
    const html = await withSignature(d.html, d.mailboxId, d.includeSignature);
    return { ok: true, data: await saveDraft(g.ctx, { ...d, html, editorHtml: d.html }) };
  } catch (e) {
    return explain(e, 'save_draft');
  }
}

export async function discardDraftAction(input: { draftId: string }): Promise<Result<null>> {
  const parsed = z.object({ draftId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: true, data: null };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  try {
    await discardDraft(g.ctx, parsed.data.draftId);
    return { ok: true, data: null };
  } catch (e) {
    return explain(e, 'discard');
  }
}

// ── attachments ───────────────────────────────────────────────────────────

/** Exchange's default message-size ceiling; bigger is refused before it is uploaded. */
const MAX_TOTAL = 35 * 1024 * 1024;
const BLOCKED = /\.(exe|bat|cmd|com|scr|msi|vbs|js|jse|ps1|lnk|hta|cpl|reg)$/i;

const UploadInput = z.object({ name: z.string().trim().min(1).max(255), size: z.number().int().min(0).max(MAX_TOTAL), contentType: z.string().max(200) });

/**
 * A one-time signed URL for the browser to put ONE file into private storage
 * directly — the bytes never pass through a Vercel function (4.5 MB limit).
 * The path is under the person's own prefix; the send engine reads it back.
 */
export async function uploadUrlAction(input: z.input<typeof UploadInput>): Promise<Result<{ path: string; token: string }>> {
  const parsed = UploadInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Attachments can be up to 35 MB in total.' };
  if (BLOCKED.test(parsed.data.name)) return { ok: false, message: 'Outlook blocks program files like this one. Zip it or share a link instead.' };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const safe = parsed.data.name.replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'file';
  const path = `${g.ctx.userId}/${crypto.randomUUID()}/${safe}`;
  const { data, error } = await supabaseAdmin().storage.from(OUTBOX_BUCKET).createSignedUploadUrl(path);
  if (error || !data) return { ok: false, message: 'Could not prepare the upload. Try again.' };
  return { ok: true, data: { path: data.path, token: data.token } };
}

export async function removeUploadAction(input: { path: string }): Promise<Result<null>> {
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const path = String(input?.path ?? '');
  if (!path.startsWith(`${g.ctx.userId}/`) || path.includes('..')) return { ok: true, data: null };
  await supabaseAdmin().storage.from(OUTBOX_BUCKET).remove([path]);
  return { ok: true, data: null };
}

// ── sending ───────────────────────────────────────────────────────────────

const SendInput = DraftInput.extend({
  requestId: z.uuid(),
  attachments: z
    .array(z.object({ path: z.string().min(1).max(400), name: z.string().min(1).max(255), size: z.number().int().min(0), contentType: z.string().max(200) }))
    .max(50),
  sendAt: z.string().datetime({ offset: true }).nullable(),
});

export async function sendMailAction(input: z.input<typeof SendInput>): Promise<Result<{ outboxId: string; releaseAt: string; status: 'held' | 'scheduled' }>> {
  const parsed = SendInput.safeParse(input);
  if (!parsed.success) {
    const bad = parsed.error.issues.find((i) => i.message === 'Not an email address');
    return { ok: false, message: bad ? 'One of the addresses isn’t valid. Fix it and send again.' : 'Something in this message isn’t valid.' };
  }
  const g = await gate('mail_send');
  if ('message' in g) return { ok: false, message: g.message };
  const d = parsed.data;
  if (d.to.length + d.cc.length + d.bcc.length === 0) return { ok: false, message: 'Add at least one recipient.' };
  if (d.attachments.reduce((n, a) => n + a.size, 0) > MAX_TOTAL) return { ok: false, message: MAIL_MESSAGES.wouldBeTooLarge(35) };
  if (d.attachments.some((a) => !a.path.startsWith(`${g.ctx.userId}/`) || a.path.includes('..'))) return { ok: false, message: MAIL_MESSAGES.generic };

  try {
    const html = await withSignature(d.html, d.mailboxId, d.includeSignature);
    const supabase = await createSupabaseServerClient();
    const source = d.kind === 'new' ? null : d.sourceMessageId
      ? ((await supabase.from('mail_messages').select('graph_id').eq('id', d.sourceMessageId).maybeSingle()).data?.graph_id as string | undefined) ?? null
      : null;
    if (d.kind !== 'new' && !source && !d.draftId) return { ok: false, message: 'The message you were answering is no longer here.' };
    const { data, error } = await supabase.rpc('mail_outbox_submit', {
      p_request_id: d.requestId,
      p_mailbox_id: d.mailboxId,
      p_draft_id: d.draftId,
      p_kind: d.kind,
      p_source_graph_id: source,
      p_subject: d.subject,
      p_body_html: html,
      p_to: d.to,
      p_cc: d.cc,
      p_bcc: d.bcc,
      p_attachments: d.attachments,
      p_send_at: d.sendAt,
    });
    if (error) return { ok: false, message: error.code === '42501' || error.code === '22023' ? error.message : MAIL_MESSAGES.generic };
    const row = (data as Array<{ id: string; release_at: string; status: 'held' | 'scheduled' }>)[0];
    return { ok: true, data: { outboxId: row.id, releaseAt: row.release_at, status: row.status } };
  } catch (e) {
    return explain(e, 'send');
  }
}

/** The undo window is over (the client's timer): send now rather than at the next tick. */
export async function releaseOutboxAction(input: { outboxId: string }): Promise<Result<null>> {
  const parsed = z.object({ outboxId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: true, data: null };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  // RLS: only the person's own outbox rows are visible here.
  const { data } = await supabase.from('mail_outbox').select('id, status').eq('id', parsed.data.outboxId).maybeSingle();
  if (data && data.status === 'held') after(() => sendDue({ only: parsed.data.outboxId, budgetMs: 50_000 }).then(() => undefined));
  return { ok: true, data: null };
}

/** Undo send (or cancel a scheduled send): the message comes back to the composer. */
export async function undoSendAction(input: { outboxId: string }): Promise<Result<ComposeInit | null>> {
  const parsed = z.object({ outboxId: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  const { data: cancelled, error } = await supabase.rpc('mail_outbox_cancel', { p_outbox_id: parsed.data.outboxId });
  if (error) return { ok: false, message: MAIL_MESSAGES.generic };
  if (!cancelled) return { ok: false, message: 'Too late — it has already been sent.' };
  const { data: o } = await supabase.from('mail_outbox').select('*').eq('id', parsed.data.outboxId).maybeSingle();
  if (!o) return { ok: true, data: null };
  const options = await fromOptions(g.ctx);
  // The signature was appended on submit; strip it back off for the editor.
  const body = String(o.body_html);
  const html = body.replace(/<br><div class="tapdash-signature">[\s\S]*<\/div>$/, '');
  // A reply that never autosaved needs the message it answers to be sent again.
  const { data: src } = o.source_graph_id
    ? await supabase.from('mail_messages').select('id').eq('mailbox_id', o.mailbox_id).eq('graph_id', o.source_graph_id).maybeSingle()
    : { data: null };
  type Stored = { path: string; name: string; size: number; contentType: string };
  return {
    ok: true,
    data: {
      kind: o.kind as ComposeKind,
      draftId: (o.draft_id as string | null) ?? null,
      sourceMessageId: (src?.id as string | undefined) ?? null,
      includeSignature: html !== body,
      attachments: ((o.attachments as Stored[] | null) ?? []).map(({ path, name, size, contentType }) => ({ path, name, size, contentType })),
      mailboxId: o.mailbox_id as string,
      fromOptions: options.filter((x) => x.mailboxId === o.mailbox_id),
      to: o.to_recipients as Addr[],
      cc: o.cc_recipients as Addr[],
      bcc: o.bcc_recipients as Addr[],
      subject: (o.subject as string) ?? '',
      html,
      source: null,
    },
  };
}

export async function scheduledAction(): Promise<Result<ScheduledItem[]>> {
  const g = await readGate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('mail_outbox')
    .select('id, mailbox_id, subject, to_recipients, release_at')
    .eq('status', 'scheduled')
    .order('release_at');
  return {
    ok: true,
    data: (data ?? []).map((o) => ({ id: o.id as string, mailboxId: o.mailbox_id as string, subject: (o.subject as string) || '(no subject)', to: o.to_recipients as Addr[], releaseAt: o.release_at as string })),
  };
}

// ── suggestions ───────────────────────────────────────────────────────────

export async function suggestRecipientsAction(input: { q: string }): Promise<Addr[]> {
  const q = String(input?.q ?? '').trim();
  if (q.length < 1 || q.length > 100) return [];
  const g = await readGate();
  if ('message' in g) return [];
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.rpc('mail_suggest_recipients', { p_q: likeEscape(q), p_limit: 8 });
  return ((data ?? []) as Array<{ address: string; name: string }>).map((r) => ({ name: r.name ?? '', address: r.address }));
}

// ── settings: signature, undo window, templates ───────────────────────────

export async function setSignatureAction(input: { mailboxId: string; html: string }): Promise<Result<null>> {
  const parsed = z.object({ mailboxId: z.uuid(), html: z.string().max(50_000) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Signatures are limited to 50,000 characters.' };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('mail_set_signature', { p_mailbox_id: parsed.data.mailboxId, p_body_html: sanitizeOutgoing(parsed.data.html) });
  return error ? { ok: false, message: error.code === '22023' ? error.message : MAIL_MESSAGES.generic } : { ok: true, data: null };
}

export async function setUndoSecondsAction(input: { seconds: number }): Promise<Result<null>> {
  const parsed = z.object({ seconds: z.number().int().min(1).max(10) }).safeParse(input);
  if (!parsed.success) return { ok: false, message: 'Choose between 1 and 10 seconds.' };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  const { data: cur } = await supabase.from('mail_user_settings').select('hide_my_mailboxes_from_admins, default_from_mailbox_id').eq('user_id', g.ctx.userId).maybeSingle();
  const { error } = await supabase.rpc('mail_set_user_settings', {
    p_undo_send_seconds: parsed.data.seconds,
    p_hide_my_mailboxes_from_admins: Boolean(cur?.hide_my_mailboxes_from_admins),
    p_default_from_mailbox_id: (cur?.default_from_mailbox_id as string | null) ?? null,
  });
  return error ? { ok: false, message: MAIL_MESSAGES.generic } : { ok: true, data: null };
}

/**
 * Admins only: keep my personal mailboxes out of other admins' view (the spec
 * lets admins see members' personal mail; this is the admin's own opt-out).
 * Shared mailboxes are never visible to non-connectors anyway.
 */
export async function setHideFromAdminsAction(input: { hide: boolean }): Promise<Result<null>> {
  const parsed = z.object({ hide: z.boolean() }).safeParse(input);
  if (!parsed.success) return { ok: false, message: MAIL_MESSAGES.generic };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  // For people who can see everyone's inboxes: hiding theirs from the others who can.
  if (!(await seesAll(g.ctx, 'email'))) return { ok: false, message: 'This setting is for people who can see every inbox.' };
  const supabase = await createSupabaseServerClient();
  const { data: cur } = await supabase.from('mail_user_settings').select('undo_send_seconds, default_from_mailbox_id').eq('user_id', g.ctx.userId).maybeSingle();
  const { error } = await supabase.rpc('mail_set_user_settings', {
    p_undo_send_seconds: Number(cur?.undo_send_seconds ?? 5),
    p_hide_my_mailboxes_from_admins: parsed.data.hide,
    p_default_from_mailbox_id: (cur?.default_from_mailbox_id as string | null) ?? null,
  });
  return error ? { ok: false, message: MAIL_MESSAGES.generic } : { ok: true, data: null };
}

export type TemplateView = { id: string; name: string; subject: string; html: string; shared: boolean; mine: boolean };

export async function templatesAction(): Promise<Result<TemplateView[]>> {
  const g = await readGate();
  if ('message' in g) return { ok: false, message: g.message };
  const ctx = g.ctx;
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from('mail_templates').select('id, owner_id, name, subject, body_html').order('name');
  return {
    ok: true,
    data: (data ?? []).map((t) => ({
      id: t.id as string,
      name: t.name as string,
      subject: (t.subject as string) ?? '',
      html: t.body_html as string,
      shared: t.owner_id === null,
      mine: t.owner_id === ctx.userId,
    })),
  };
}

const TemplateInput = z.object({ id: z.uuid().nullable(), name: z.string().trim().min(1).max(120), subject: z.string().max(255), html: z.string().max(200_000), shared: z.boolean() });

export async function saveTemplateAction(input: z.input<typeof TemplateInput>): Promise<Result<{ id: string }>> {
  const parsed = TemplateInput.safeParse(input);
  if (!parsed.success) return { ok: false, message: 'A template needs a name (up to 120 characters).' };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('mail_template_upsert', {
    p_id: parsed.data.id,
    p_name: parsed.data.name,
    p_subject: parsed.data.subject,
    p_body_html: sanitizeOutgoing(parsed.data.html),
    p_shared: parsed.data.shared,
  });
  if (error) return { ok: false, message: error.code === '42501' ? 'Only an admin can manage shared templates.' : MAIL_MESSAGES.generic };
  return { ok: true, data: { id: data as string } };
}

export async function deleteTemplateAction(input: { id: string }): Promise<Result<null>> {
  const parsed = z.object({ id: z.uuid() }).safeParse(input);
  if (!parsed.success) return { ok: true, data: null };
  const g = await gate();
  if ('message' in g) return { ok: false, message: g.message };
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('mail_template_delete', { p_id: parsed.data.id });
  return error ? { ok: false, message: 'That template can’t be deleted by you.' } : { ok: true, data: null };
}

/** Body preview for a source message, sanitised like any inbound mail. */
export async function sourcePreviewAction(input: { messageId: string }): Promise<string> {
  const g = await readGate();
  if ('message' in g) return '';
  const parsed = z.object({ messageId: z.uuid() }).safeParse(input);
  if (!parsed.success) return '';
  await authorize();
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from('mail_messages').select('body_html').eq('id', parsed.data.messageId).maybeSingle();
  return data?.body_html ? sanitizeEmail(data.body_html as string).html : '';
}
