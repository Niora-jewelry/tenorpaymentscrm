/**
 * Drafts that live in Outlook.
 *
 * The first autosave creates a real Outlook draft — for a reply or forward,
 * through Graph's createReply / createReplyAll / createForward, so Outlook
 * writes the quoted history and keeps a forward's attachments. What Outlook
 * generated is stored once (mail_drafts.quote_html) and every later save is
 * "the person's words + that quote", so the history is never lost and never
 * doubled. The draft shows up in the Drafts folder of Outlook and the CRM
 * alike, and a draft started in Outlook can be finished here.
 *
 * Only from a mailbox the person connected themselves: writing as someone is
 * never borrowed from another person's sign-in.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { AuthContext } from '@/lib/records/permissions';
import { graphForIdentity } from '../tokens';
import { GraphError, type GraphTransport } from '../graph/transport';
import { rootFor } from '../sync/folders';
import { sanitizeOutgoing } from '../content/sanitize';
import type { Addr, ComposeKind } from '../viewTypes';
import { toGraphRecipients } from './recipients';

export class ComposeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeError';
  }
}

export type Sender = { mailboxId: string; address: string; identityId: string; root: string; graph: GraphTransport };

/** The person's own connection to a mailbox, or a refusal they can read. */
export async function senderFor(ctx: AuthContext, mailboxId: string): Promise<Sender> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase
    .from('mail_connections')
    .select('identity_id, status, mail_mailboxes(address, graph_user_id)')
    .eq('mailbox_id', mailboxId)
    .eq('user_id', ctx.userId)
    .is('disconnected_at', null)
    .maybeSingle<{ identity_id: string; status: string; mail_mailboxes: { address: string; graph_user_id: string | null } | null }>();
  if (!data?.mail_mailboxes) throw new ComposeError('You can only write from a mailbox you connected.');
  if (data.status === 'broken') throw new ComposeError(`The connection to ${data.mail_mailboxes.address} needs to be reconnected before you can send from it.`);
  return {
    mailboxId,
    address: data.mail_mailboxes.address,
    identityId: data.identity_id,
    root: rootFor({ graph_user_id: data.mail_mailboxes.graph_user_id, address: data.mail_mailboxes.address }),
    graph: graphForIdentity(data.identity_id),
  };
}

/** The Graph id of a message this person can see, in this mailbox (RLS read). */
export async function sourceGraphId(mailboxId: string, messageId: string): Promise<string> {
  const supabase = await createSupabaseServerClient();
  const { data } = await supabase.from('mail_messages').select('graph_id, mailbox_id').eq('id', messageId).maybeSingle();
  if (!data) throw new ComposeError('That message is no longer here.');
  if (data.mailbox_id !== mailboxId) throw new ComposeError('Reply from the mailbox the message is in.');
  return data.graph_id as string;
}

type GraphDraft = { id?: string; body?: { content?: string } };

const CREATE: Record<Exclude<ComposeKind, 'new'>, string> = {
  reply: 'createReply',
  replyAll: 'createReplyAll',
  forward: 'createForward',
};

/** Creates the Outlook draft. Returns its id and, for replies/forwards, Outlook's quote. */
export async function createGraphDraft(
  s: Pick<Sender, 'graph' | 'root'>,
  kind: ComposeKind,
  source: string | null,
): Promise<{ id: string; quote: string }> {
  if (kind === 'new') {
    const d = await s.graph.request<GraphDraft>({ method: 'POST', path: `${s.root}/messages`, body: { subject: '', body: { contentType: 'HTML', content: '' } } });
    if (!d?.id) throw new ComposeError('Outlook did not create the draft.');
    return { id: d.id, quote: '' };
  }
  if (!source) throw new ComposeError('A reply needs the message it answers.');
  const d = await s.graph.request<GraphDraft>({
    method: 'POST',
    path: `${s.root}/messages/${encodeURIComponent(source)}/${CREATE[kind]}`,
    headers: { Prefer: 'outlook.body-content-type="html"' },
    body: {},
  });
  if (!d?.id) throw new ComposeError('Outlook did not create the draft.');
  return { id: d.id, quote: quoteFragment(d.body?.content ?? '') };
}

/**
 * Outlook returns a reply draft's body as a whole HTML document. Keep its
 * <style> blocks (Outlook's quote formatting depends on them) and the body's
 * content; drop the document wrapper so it can sit under the person's text.
 */
export function quoteFragment(doc: string): string {
  if (!/<body[\s>]/i.test(doc)) return doc;
  const styles = (doc.match(/<style[\s\S]*?<\/style>/gi) ?? []).join('');
  const body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(doc)?.[1] ?? doc;
  return styles + body.trim();
}

/**
 * Writes subject, body (+ Outlook's quote) and recipients onto an Outlook
 * draft. Returns Outlook's new changeKey, and the draft's internetMessageId
 * (kept by the send engine to recognise the message in Sent Items later).
 */
export async function patchGraphDraft(
  s: Pick<Sender, 'graph' | 'root'>,
  draftGraphId: string,
  content: { subject: string; html: string; quote: string; to: Addr[]; cc: Addr[]; bcc: Addr[] },
): Promise<{ changeKey: string | null; internetMessageId: string | null }> {
  const m = await s.graph.request<{ changeKey?: string; internetMessageId?: string }>({
    method: 'PATCH',
    path: `${s.root}/messages/${encodeURIComponent(draftGraphId)}`,
    body: {
      subject: content.subject,
      body: { contentType: 'HTML', content: joinBody(content.html, content.quote) },
      toRecipients: toGraphRecipients(content.to),
      ccRecipients: toGraphRecipients(content.cc),
      bccRecipients: toGraphRecipients(content.bcc),
    },
  });
  return { changeKey: m?.changeKey?.slice(0, 200) ?? null, internetMessageId: m?.internetMessageId?.slice(0, 1000) ?? null };
}

/** The person's words, a gap, then Outlook's quote — exactly once. */
export function joinBody(html: string, quote: string): string {
  if (!quote) return html;
  return `${html}<br>${quote}`;
}

export type DraftSave = {
  draftId: string | null;
  mailboxId: string;
  kind: ComposeKind;
  sourceMessageId: string | null;
  subject: string;
  /** The full body to write to Outlook: the person's words plus (optionally) the signature. */
  html: string;
  /** The person's words alone, as the editor holds them — what reopening the draft restores. */
  editorHtml: string;
  includeSignature: boolean;
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
};

export async function saveDraft(ctx: AuthContext, d: DraftSave): Promise<{ draftId: string; savedAt: string }> {
  const admin = supabaseAdmin();
  const s = await senderFor(ctx, d.mailboxId);
  const html = sanitizeOutgoing(d.html);

  type DraftRow = { id: string; draft_graph_id: string | null; quote_html: string; kind: string; source_graph_id: string | null };
  let row: DraftRow | null = null;
  if (d.draftId) {
    const { data } = await admin
      .from('mail_drafts')
      .select('id, draft_graph_id, quote_html, kind, source_graph_id, user_id, mailbox_id')
      .eq('id', d.draftId)
      .is('deleted_at', null)
      .maybeSingle();
    if (!data || data.user_id !== ctx.userId || data.mailbox_id !== d.mailboxId) throw new ComposeError('That draft is gone.');
    row = data as DraftRow;
  }

  const content = { subject: d.subject.slice(0, 255), html, to: d.to, cc: d.cc, bcc: d.bcc };
  const kept = { editor_html: sanitizeOutgoing(d.editorHtml), include_signature: d.includeSignature };
  if (row?.draft_graph_id) {
    try {
      const { changeKey } = await patchGraphDraft(s, row.draft_graph_id, { ...content, quote: row.quote_html });
      const savedAt = new Date().toISOString();
      await admin.from('mail_drafts').update({ ...kept, change_key: changeKey, saved_at: savedAt, updated_at: savedAt }).eq('id', row.id);
      await queueDraftSync(d.mailboxId, row.draft_graph_id);
      return { draftId: row.id, savedAt };
    } catch (e) {
      // Deleted or sent from Outlook meanwhile: start a fresh draft below.
      if (!(e instanceof GraphError) || e.classified.code !== 'not_found') throw e;
    }
  }

  const source = d.kind === 'new' ? null : d.sourceMessageId ? await sourceGraphId(d.mailboxId, d.sourceMessageId) : (row?.source_graph_id ?? null);
  const created = await createGraphDraft(s, d.kind, source);
  const { changeKey } = await patchGraphDraft(s, created.id, { ...content, quote: created.quote });
  const savedAt = new Date().toISOString();
  let draftId = row?.id ?? null;
  if (draftId) {
    await admin
      .from('mail_drafts')
      .update({ ...kept, change_key: changeKey, draft_graph_id: created.id, quote_html: created.quote, saved_at: savedAt, updated_at: savedAt })
      .eq('id', draftId);
  } else {
    const { data, error } = await admin
      .from('mail_drafts')
      .insert({
        mailbox_id: d.mailboxId,
        user_id: ctx.userId,
        identity_id: s.identityId,
        kind: d.kind,
        source_graph_id: source,
        draft_graph_id: created.id,
        quote_html: created.quote,
        ...kept,
        change_key: changeKey,
        saved_at: savedAt,
      })
      .select('id')
      .single();
    if (error) throw new Error(`mail_drafts insert failed: ${error.code ?? 'db'}`);
    draftId = data.id as string;
  }
  await queueDraftSync(d.mailboxId, created.id);
  return { draftId: draftId!, savedAt };
}

/** Pull the draft into the Drafts folder here, soon (it is already in Outlook's). */
async function queueDraftSync(mailboxId: string, draftGraphId: string): Promise<void> {
  await supabaseAdmin().rpc('mail_enqueue', { p_mailbox_id: mailboxId, p_kind: 'message_changed', p_target: draftGraphId, p_priority: 3, p_delay_seconds: 2 });
}

export async function discardDraft(ctx: AuthContext, draftId: string): Promise<void> {
  const admin = supabaseAdmin();
  const { data } = await admin
    .from('mail_drafts')
    .select('id, mailbox_id, draft_graph_id, user_id')
    .eq('id', draftId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!data || data.user_id !== ctx.userId) return;
  if (data.draft_graph_id) {
    const s = await senderFor(ctx, data.mailbox_id as string);
    try {
      await s.graph.request({ method: 'DELETE', path: `${s.root}/messages/${encodeURIComponent(data.draft_graph_id as string)}` });
    } catch (e) {
      if (!(e instanceof GraphError) || e.classified.code !== 'not_found') throw e;
    }
    await admin.rpc('mail_soft_delete_messages', { p_mailbox_id: data.mailbox_id, p_graph_ids: [data.draft_graph_id], p_folder_id: null });
    await admin.rpc('mail_bump_seq', { p_mailbox_id: data.mailbox_id });
  }
  await admin.from('mail_drafts').update({ deleted_at: new Date().toISOString() }).eq('id', draftId);
}

/** What the CRM last wrote to a draft — enough to reopen it exactly, if Outlook hasn't changed it since. */
export type KeptDraft = {
  kind: ComposeKind;
  sourceGraphId: string | null;
  editorHtml: string;
  includeSignature: boolean;
  changeKey: string | null;
};

/** A draft that already exists in the Drafts folder (written here or in Outlook), opened for editing. */
export async function adoptDraft(
  ctx: AuthContext,
  messageId: string,
): Promise<{ draftId: string; mailboxId: string; graphId: string; kept: KeptDraft | null }> {
  const supabase = await createSupabaseServerClient();
  const { data: m } = await supabase.from('mail_messages').select('id, mailbox_id, graph_id, is_draft').eq('id', messageId).maybeSingle();
  if (!m || !m.is_draft) throw new ComposeError('That draft is no longer here.');
  const s = await senderFor(ctx, m.mailbox_id as string);
  const admin = supabaseAdmin();
  const { data: existing } = await admin
    .from('mail_drafts')
    .select('id, user_id, saved_at, kind, source_graph_id, editor_html, include_signature, change_key')
    .eq('mailbox_id', m.mailbox_id)
    .eq('draft_graph_id', m.graph_id)
    .is('deleted_at', null)
    .maybeSingle();
  const base = { mailboxId: m.mailbox_id as string, graphId: m.graph_id as string };
  if (existing && existing.user_id !== ctx.userId) {
    // A co-connector of a shared mailbox is writing it in TapDash right now.
    const fresh = existing.saved_at && Date.now() - Date.parse(existing.saved_at as string) < 3_600_000;
    if (fresh) throw new ComposeError('Someone else is writing this draft in TapDash. Open it in Outlook, or ask them to finish it.');
    // Abandoned: take it over, from Outlook's copy — never from their saved words.
    await admin.from('mail_drafts').update({ user_id: ctx.userId, identity_id: s.identityId }).eq('id', existing.id);
    await forgetKept(existing.id as string);
    return { ...base, draftId: existing.id as string, kept: null };
  }
  if (existing) {
    await admin.from('mail_drafts').update({ identity_id: s.identityId }).eq('id', existing.id);
    return {
      ...base,
      draftId: existing.id as string,
      kept: {
        kind: existing.kind as ComposeKind,
        sourceGraphId: (existing.source_graph_id as string | null) ?? null,
        editorHtml: (existing.editor_html as string) ?? '',
        includeSignature: Boolean(existing.include_signature),
        changeKey: (existing.change_key as string | null) ?? null,
      },
    };
  }
  const { data, error } = await admin
    .from('mail_drafts')
    .insert({ mailbox_id: m.mailbox_id, user_id: ctx.userId, identity_id: s.identityId, kind: 'new', draft_graph_id: m.graph_id, quote_html: '', include_signature: false })
    .select('id')
    .single();
  if (error) throw new Error(`mail_drafts insert failed: ${error.code ?? 'db'}`);
  return { ...base, draftId: data.id as string, kept: null };
}

/**
 * Outlook changed the draft since the CRM last wrote it: from now on its body
 * (quote and signature included) is the whole message, edited as one.
 */
export async function forgetKept(draftId: string): Promise<void> {
  await supabaseAdmin()
    .from('mail_drafts')
    .update({ kind: 'new', quote_html: '', editor_html: '', include_signature: false, change_key: null, updated_at: new Date().toISOString() })
    .eq('id', draftId);
}
