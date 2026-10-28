/**
 * Sharing one update, case or tab note, and hiding a reply (Permissions spec:
 * "Updates, cases and tab notes").
 *
 *   * A user who sees all of a kind ("See all + grant") can give access to one
 *     item to a user type or one person — only someone who can already open
 *     the record (`grant_item_access` refuses anyone else).
 *   * The author of a reply can hide it from specific people.
 *
 * Every rule is decided in the database (migration 9815); this module reads
 * what the drawer needs and passes writes through.
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { permissionsFor, type AuthContext } from './permissions';

export type ItemKind = 'case' | 'update' | 'note';
export type ReplyKind = 'update' | 'case_reply';

export const USER_TYPE_LABELS: Record<string, string> = {
  super_admin: 'Super admin',
  admin: 'Admin',
  underwriter: 'Underwriter',
  accounting: 'Accounting',
  customer_service: 'Customer service',
  sales_agent: 'Sales agent',
};

export type ItemGrant = { id: string; kind: ItemKind; itemId: string; userId: string | null; userType: string | null };

export type ItemAccessData = {
  grants: ItemGrant[];
  /** `${replyKind}:${replyId}` → people the viewer hid their reply from. */
  hiddenByMe: Record<string, string[]>;
  /** May the viewer give access to items of this kind (See all + grant)? */
  canGrant: Record<ItemKind, boolean>;
  /** Everyone who can open this record — the only people access can go to. */
  openers: string[];
};

export async function itemAccessFor(ctx: AuthContext, recordId: string): Promise<ItemAccessData> {
  const supabase = await createSupabaseServerClient();
  const [grants, hidden, openers, perms] = await Promise.all([
    supabase.from('item_access_grants').select('id, item_kind, item_id, grantee_user, grantee_type').eq('record_id', recordId),
    supabase.from('reply_hidden_from').select('reply_kind, reply_id, user_id').eq('hidden_by', ctx.userId),
    supabase.rpc('record_openers', { p_record: recordId }),
    permissionsFor(ctx),
  ]);
  if (grants.error) throw grants.error;
  if (hidden.error) throw hidden.error;
  if (openers.error) throw openers.error;

  const hiddenByMe: Record<string, string[]> = {};
  for (const h of hidden.data ?? []) {
    const key = `${h.reply_kind}:${h.reply_id}`;
    (hiddenByMe[key] ??= []).push(h.user_id as string);
  }
  const all = (k: string) => ctx.isAdmin || perms.settings[k] === 'all';
  return {
    grants: (grants.data ?? []).map((g) => ({
      id: g.id as string,
      kind: g.item_kind as ItemKind,
      itemId: g.item_id as string,
      userId: (g.grantee_user as string | null) ?? null,
      userType: (g.grantee_type as string | null) ?? null,
    })),
    hiddenByMe,
    canGrant: { case: all('items.cases'), update: all('items.updates'), note: all('items.notes') },
    openers: (openers.data as string[] | null) ?? [],
  };
}

export async function grantItemAccess(
  ctx: AuthContext,
  input: { kind: ItemKind; itemId: string; userId: string | null; userType: string | null },
): Promise<void> {
  void ctx;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('grant_item_access', {
    p_kind: input.kind, p_item: input.itemId, p_user: input.userId, p_type: input.userType,
  });
  if (error) throw new Error(error.message);
}

export async function revokeItemAccess(ctx: AuthContext, grantId: string): Promise<void> {
  void ctx;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('revoke_item_access', { p_grant: grantId });
  if (error) throw new Error(error.message);
}

export async function setReplyHidden(
  ctx: AuthContext,
  input: { kind: ReplyKind; replyId: string; userIds: string[] },
): Promise<void> {
  void ctx;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('set_reply_hidden_from', {
    p_kind: input.kind, p_reply: input.replyId, p_users: input.userIds,
  });
  if (error) throw new Error(error.message);
}
