/**
 * Teams on a merchant record: conversations linked to a record, shown in the sub-tab
 * flagged `shows_record_chats` (migration 9907). No module, tab or sub-tab is named
 * here, the flag finds them.
 *
 * ── WHAT A LINK GIVES, AND WHAT IT NEVER DOES ─────────────────────────
 * A link is a pointer. It does not share the conversation. The Teams spec is that
 * "only Microsoft's own access rules decide what a user can see inside a connected
 * account", so every read below is made with a token Chat would already let this
 * viewer use:
 *
 *   * their own account, and Microsoft answers whether they are in the conversation;
 *   * or, holding All users, the account that made the link, look only. That is the
 *     same rule and the same refusals (`readableIdentity`) as picking that person in
 *     the Chat module, including a person who has hidden theirs.
 *
 * Being able to open a record is deliberately not a reason to read a chat.
 *
 * The card (name, who linked it, when) follows the Communication setting, which has
 * no Hidden and no tab or sub-tab level. Whole org sees every card, with none of the
 * conversation. Own only ("what they sent or were copied on") sees only what they
 * can read or linked themselves: an untitled chat is named after its members, so the
 * card alone would tell them who is talking about this merchant.
 *
 * The grant chain is still asked, because it is what makes a record they can only
 * read until they take its assignment View, and one they cannot open Hidden.
 *
 * Linking needs Edit on the sub-tab AND the linker's own account being in the
 * conversation, checked with Microsoft here rather than trusted from the browser.
 * The name stored comes from Microsoft for the same reason.
 */
import 'server-only';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { mailReady } from '@/lib/integrations/resolve';
import { EmailAccessError, requireEmailAccess } from '@/lib/mail/access';
import { teamsGranted } from '@/lib/mail/scopes';
import { loadConfig } from '@/lib/records/config';
import { moduleForRecords } from '@/lib/records/notifications';
import { seesAll, type AuthContext, type Grant } from '@/lib/records/permissions';
import { subtabCapsFor } from '@/lib/records/tabAccess';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { assertNotImpersonating, identitiesOf, ownIdentity, readableIdentity, TeamsError, toAccountView, usable, type Identity } from './access';
import { conversationFor, parseKey } from './chat';
import { conversationRefKey, linkedChatTitle } from './format';
import type { ChatKind, ChatRecords, RecordChatAccess, RecordChatLink, RecordChats } from './types';

const NOT_FOUND = 'That record could not be found.';
const NO_EDIT = 'You do not have permission to change the chats on this record.';

type LinkRow = {
  id: string;
  record_id: string;
  conversation_kind: 'chat' | 'channel';
  chat_id: string | null;
  team_id: string | null;
  channel_id: string | null;
  chat_kind: ChatKind;
  title: string;
  team_name: string | null;
  linked_by: string | null;
  linked_identity_id: string | null;
  linked_at: string;
};

const LINK_COLUMNS = 'id, record_id, conversation_kind, chat_id, team_id, channel_id, chat_kind, title, team_name, linked_by, linked_identity_id, linked_at';

/** The flagged sub-tab and its tab. Null means the feature is switched off. */
async function chatsSubtab() {
  const config = await loadConfig();
  const subtab = config.subtabs.find((s) => s.showsRecordChats);
  const tab = subtab ? config.tabs.find((t) => t.id === subtab.tabId) : undefined;
  return subtab && tab ? { subtab, tab } : null;
}

/** The viewer's level on this sub-tab, for each record they can actually open. */
async function capsFor(ctx: AuthContext, recordIds: string[]): Promise<Map<string, Grant>> {
  const out = new Map<string, Grant>();
  const where = await chatsSubtab();
  if (!where || recordIds.length === 0) return out;
  // The chain answers for modules, not for this record: their own client answers that.
  // `records` alone is not enough. A record can be a row in their list without being
  // one they may open: an open assignment before they take it (migration 9843), where
  // the drawer shows only "Take this record to open it". `record_visible` is the
  // drawer's own question, so these chats are refused exactly when it is.
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('records').select('id').in('id', recordIds).is('deleted_at', null);
  if (error) throw error;
  const listed = (data ?? []).map((r) => r.id as string);
  const opens = await Promise.all(
    listed.map(async (rec) => {
      const answer = await supabase.rpc('record_visible', { rec });
      if (answer.error) throw answer.error;
      return Boolean(answer.data);
    }),
  );
  const visible = listed.filter((_, i) => opens[i]);
  const caps = await subtabCapsFor(ctx, visible, where.subtab.id, where.tab.id);
  for (const id of visible) out.set(id, caps.get(id) ?? 'hidden');
  return out;
}

async function capOn(ctx: AuthContext, recordId: string): Promise<Grant> {
  return (await capsFor(ctx, [recordId])).get(recordId) ?? 'hidden';
}

/** Chat reads sit behind the Email grant (`routeGate`), so this has to say the same. */
async function holdsEmailAccess(ctx: AuthContext): Promise<boolean> {
  try {
    await requireEmailAccess(ctx, 'view');
    return true;
  } catch (e) {
    if (e instanceof EmailAccessError) return false;
    throw e;
  }
}

const refOf = (row: LinkRow) =>
  row.conversation_kind === 'chat'
    ? ({ kind: 'chat', chatId: row.chat_id! } as const)
    : ({ kind: 'channel', teamId: row.team_id!, channelId: row.channel_id! } as const);

const canActOn = (i: Identity) => usable(i) && teamsGranted(i.scopes);

/** What this viewer gets of one link. Every Microsoft call is made with a token they may use. */
async function accessFor(
  ctx: AuthContext,
  row: LinkRow,
  mine: Identity[],
  mayLook: boolean,
): Promise<Pick<RecordChatLink, 'access' | 'chat' | 'lookingThrough'>> {
  const ref = refOf(row);
  let unknown = false;
  for (const identity of mine.filter(canActOn)) {
    try {
      const found = await conversationFor(identity, ref);
      if (found) return { access: 'member', chat: found.summary, lookingThrough: null };
    } catch {
      unknown = true;
    }
  }

  if (mayLook && row.linked_identity_id && !mine.some((i) => i.id === row.linked_identity_id)) {
    try {
      const { identity } = await readableIdentity(ctx, 'chat', row.linked_identity_id);
      if (canActOn(identity)) {
        const found = await conversationFor(identity, ref);
        if (found) return { access: 'look', chat: found.summary, lookingThrough: identity.name || identity.email };
      }
    } catch (e) {
      // Refused (they hid theirs, or it was disconnected) is an answer; an outage is not.
      if (!(e instanceof TeamsError)) unknown = true;
    }
  }
  return { access: unknown ? 'unavailable' : 'none', chat: null, lookingThrough: null };
}

/** Own only: what they can read, or linked themselves. */
const ownOnlySees = (access: RecordChatAccess, mine: boolean) => mine || access === 'member' || access === 'look';

/** Everything the record's sub-tab shows. Refused outright when the sub-tab is hidden. */
export async function recordChats(ctx: AuthContext, recordId: string): Promise<RecordChats> {
  const cap = await capOn(ctx, recordId);
  if (cap === 'hidden') throw new TeamsError(NOT_FOUND);

  const admin = supabaseAdmin();
  const { data, error } = await admin.from('record_teams_links').select(LINK_COLUMNS).eq('record_id', recordId).order('linked_at', { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as LinkRow[];

  const linkerIds = [...new Set(rows.map((r) => r.linked_by).filter((x): x is string => Boolean(x)))];
  const { data: people } = linkerIds.length ? await admin.from('profiles').select('id, full_name, email').in('id', linkerIds) : { data: [] };
  const nameOf = new Map((people ?? []).map((p) => [p.id as string, (p.full_name as string | null)?.trim() || (p.email as string | null) || 'Someone']));

  const [configured, impersonating] = await Promise.all([mailReady(), currentImpersonation().then(Boolean)]);
  const canRead = configured && !impersonating && (await holdsEmailAccess(ctx));
  const mine = canRead ? await identitiesOf(ctx.userId) : [];
  // All users needs an account of their own, as it does in the Chat module.
  const mayLook = canRead && mine.length > 0 && (await seesAll(ctx, 'chat'));

  const wholeOrg = await seesAll(ctx, 'communication');
  const all = await Promise.all(
    rows.map(async (row): Promise<RecordChatLink & { mine: boolean }> => ({
      mine: row.linked_by === ctx.userId,
      id: row.id,
      kind: row.chat_kind,
      title: row.title,
      teamName: row.team_name,
      linkedByName: row.linked_by ? (nameOf.get(row.linked_by) ?? 'Someone') : 'Someone',
      linkedAt: row.linked_at,
      ...(await accessFor(ctx, row, mine, mayLook)),
    })),
  );

  const links = all
    .filter((l) => wholeOrg || ownOnlySees(l.access, l.mine))
    .map((l): RecordChatLink => ({ id: l.id, kind: l.kind, title: l.title, teamName: l.teamName, linkedByName: l.linkedByName, linkedAt: l.linkedAt, access: l.access, chat: l.chat, lookingThrough: l.lookingThrough }));
  // Own only, Microsoft down: whether they are in a chat is unknown, so its card stays
  // back, and this says the list may be short rather than letting it look complete.
  const someUnavailable = !wholeOrg && all.some((l) => l.access === 'unavailable' && !l.mine);
  return { configured, impersonating, canEdit: cap === 'edit', accounts: mine.map(toAccountView), links, someUnavailable };
}

/** Links one of the viewer's own conversations. False: it was already on this record. */
export async function linkConversation(ctx: AuthContext, args: { recordId: string; key: string }): Promise<boolean> {
  if ((await capOn(ctx, args.recordId)) !== 'edit') throw new TeamsError(NO_EDIT);
  if (!(await mailReady())) throw new TeamsError('Microsoft is not switched on for this CRM.');
  if (!(await holdsEmailAccess(ctx))) throw new TeamsError(NO_EDIT);

  const ref = parseKey(args.key);
  if (!ref) throw new TeamsError('That conversation could not be found.');
  const identity = await ownIdentity(ctx, ref.identityId);
  if (!teamsGranted(identity.scopes)) throw new TeamsError('This account has not approved chat access yet.');

  const found = await conversationFor(identity, ref);
  if (!found) throw new TeamsError('You can only link a chat you are in.');

  const title = ref.kind === 'chat' ? linkedChatTitle(found.topic, found.summary.members.map((m) => m.name)) : found.summary.name.slice(0, 200);
  const { data, error } = await supabaseAdmin().rpc('record_teams_link', {
    p_record: args.recordId,
    p_actor: ctx.userId,
    p_identity: identity.id,
    p_kind: ref.kind,
    p_chat: ref.kind === 'chat' ? ref.chatId : null,
    p_team: ref.kind === 'channel' ? ref.teamId : null,
    p_channel: ref.kind === 'channel' ? ref.channelId : null,
    p_ref: conversationRefKey(ref),
    p_chat_kind: found.summary.kind,
    p_title: title,
    p_team_name: found.summary.teamName,
  });
  if (error) throw error;
  return Boolean(data);
}

/** Takes the link off the record. Nothing changes in Teams. */
export async function unlinkConversation(ctx: AuthContext, linkId: string): Promise<void> {
  const { data, error } = await supabaseAdmin().from('record_teams_links').select(LINK_COLUMNS).eq('id', linkId).maybeSingle();
  if (error) throw error;
  const row = data as LinkRow | null;
  // The same answer whether the link is gone or was never theirs to see.
  if (!row || (await capOn(ctx, row.record_id)) !== 'edit') throw new TeamsError(NO_EDIT);
  if (row.linked_by !== ctx.userId && !(await seesAll(ctx, 'communication'))) {
    const canRead = (await mailReady()) && !(await currentImpersonation()) && (await holdsEmailAccess(ctx));
    const mine = canRead ? await identitiesOf(ctx.userId) : [];
    const { access } = await accessFor(ctx, row, mine, canRead && mine.length > 0 && (await seesAll(ctx, 'chat')));
    if (access === 'unavailable') throw new TeamsError('Microsoft did not answer. Try again in a moment.');
    if (!ownOnlySees(access, false)) throw new TeamsError(NO_EDIT);
  }
  const { error: rpcError } = await supabaseAdmin().rpc('record_teams_unlink', { p_link: linkId, p_actor: ctx.userId });
  if (rpcError) throw rpcError;
}

/**
 * The records a conversation is linked to, for the Chat module. Only records this
 * viewer can open with the sub-tab showing: one they cannot is not hinted at, not
 * even as a count.
 */
export async function chatRecords(ctx: AuthContext, key: string): Promise<ChatRecords> {
  const ref = parseKey(key);
  if (!ref) throw new TeamsError('That conversation could not be found.');
  const { identity, own } = await readableIdentity(ctx, 'chat', ref.identityId);
  const where = await chatsSubtab();
  if (!where) return { records: [], canLink: false };

  const { data, error } = await supabaseAdmin().from('record_teams_links').select('record_id').eq('ref_key', conversationRefKey(ref));
  if (error) throw error;
  const ids = [...new Set((data ?? []).map((r) => r.record_id as string))];
  const caps = await capsFor(ctx, ids);
  const open = ids.filter((id) => (caps.get(id) ?? 'hidden') !== 'hidden');

  const canLink = own && canActOn(identity);
  if (open.length === 0) return { records: [], canLink };
  const supabase = await createSupabaseServerClient();
  const [{ data: rows, error: rowsError }, modules] = await Promise.all([
    supabase.from('records').select('id, deal_name').in('id', open),
    moduleForRecords(ctx, open),
  ]);
  if (rowsError) throw rowsError;
  const tail = `tab=${encodeURIComponent(where.tab.key)}&subtab=${encodeURIComponent(where.subtab.key)}`;
  const records = (rows ?? []).flatMap((r) => {
    const mod = modules.get(r.id as string);
    if (!mod) return [];
    return [{ recordId: r.id as string, name: (r.deal_name as string | null) ?? '(untitled)', href: `/${mod.slug}?record=${r.id as string}&${tail}` }];
  });
  return { records: records.sort((a, b) => a.name.localeCompare(b.name)), canLink };
}

/** Records this viewer may link a chat to: by name, and only where they hold Edit. */
export async function findRecordsToLink(ctx: AuthContext, query: string): Promise<{ id: string; name: string }[]> {
  await assertNotImpersonating();
  const q = query.trim().slice(0, 80).replace(/[%_,()]/g, ' ').trim();
  if (q.length < 2) return [];
  // Their own client: RLS returns only records they may see. Only the name is read.
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.from('records').select('id, deal_name').ilike('deal_name', `%${q}%`).is('deleted_at', null).order('deal_name').limit(20);
  if (error) throw error;
  const rows = data ?? [];
  const caps = await capsFor(ctx, rows.map((r) => r.id as string));
  return rows.filter((r) => caps.get(r.id as string) === 'edit').slice(0, 10).map((r) => ({ id: r.id as string, name: (r.deal_name as string | null) ?? '(untitled)' }));
}
