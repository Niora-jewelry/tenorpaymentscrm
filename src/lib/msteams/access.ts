/**
 * Who may see whose Calendar and Chat, and whose token acts.
 *
 * Own only: the accounts you connected. All users: also pick anyone else's, look
 * only, enforced here rather than by hiding buttons:
 *
 *   * `dataOwner` answers "may this person read that person's data?".
 *   * `ownIdentity` is the only way to get an account to WRITE with, and it refuses
 *     anything that is not the caller's own. Every send, edit, cancel and answer goes
 *     through it, so looking at someone else cannot turn into acting as them.
 */
import 'server-only';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { permissionsFor, seesAll, type AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { teamsGranted } from '@/lib/mail/scopes';
import type { AccountView, PersonChoice, TeamsKind } from './types';

export class TeamsError extends Error {}

export type Identity = {
  id: string;
  userId: string;
  microsoftUserId: string;
  tenantId: string | null;
  email: string;
  name: string;
  status: string;
  scopes: string[];
};

const COLUMNS = 'id, user_id, microsoft_user_id, tenant_id, primary_email, display_name, status, scopes';

type Row = { id: string; user_id: string; microsoft_user_id: string; tenant_id: string | null; primary_email: string; display_name: string; status: string; scopes: string[] | null };

const toIdentity = (r: Row): Identity => ({
  id: r.id,
  userId: r.user_id,
  microsoftUserId: r.microsoft_user_id,
  tenantId: r.tenant_id,
  email: r.primary_email,
  name: r.display_name,
  status: r.status,
  scopes: r.scopes ?? [],
});

export async function identitiesOf(userId: string): Promise<Identity[]> {
  const { data, error } = await supabaseAdmin().from('mail_identities').select(COLUMNS).eq('user_id', userId).is('deleted_at', null).order('created_at');
  if (error) throw new TeamsError('Your Microsoft accounts could not be read. Try again.');
  return ((data ?? []) as Row[]).map(toIdentity);
}

export const usable = (i: Identity): boolean => i.status === 'ok' || i.status === 'degraded';

export const toAccountView = (i: Identity): AccountView => ({
  identityId: i.id,
  email: i.email,
  name: i.name,
  status: usable(i) ? 'ok' : 'reconnect',
  approved: teamsGranted(i.scopes),
});

const hideColumn = (kind: TeamsKind) => (kind === 'calendar' ? 'hide_my_calendar' : 'hide_my_chat');

async function isHidden(userId: string, kind: TeamsKind): Promise<boolean> {
  const { data } = await supabaseAdmin().from('mail_user_settings').select(`${hideColumn(kind)}`).eq('user_id', userId).maybeSingle();
  return Boolean((data as Record<string, unknown> | null)?.[hideColumn(kind)]);
}

/** "Sign in as" shows nothing of the person's private conversations, as in Email. */
export async function assertNotImpersonating(): Promise<void> {
  if (await currentImpersonation()) throw new TeamsError('This is not available while signed in as someone else.');
}

/**
 * Whose data this request may read. With no one named, the caller's own.
 * Someone else's needs All users, the caller having an account of their own (without
 * one they see only the Connect screen), and that person not having hidden theirs.
 */
export async function dataOwner(ctx: AuthContext, kind: TeamsKind, requested?: string | null): Promise<{ ownerId: string; own: boolean }> {
  await assertNotImpersonating();
  if (!requested || requested === ctx.userId) return { ownerId: ctx.userId, own: true };
  if (!(await seesAll(ctx, kind))) throw new TeamsError('You can only see your own.');
  if ((await identitiesOf(ctx.userId)).length === 0) throw new TeamsError('Connect your Microsoft account first.');
  if (await isHidden(requested, kind)) throw new TeamsError('This person has hidden theirs.');
  return { ownerId: requested, own: false };
}

/** The account to act with. It must be the caller's own and working. */
export async function ownIdentity(ctx: AuthContext, identityId: string): Promise<Identity> {
  await assertNotImpersonating();
  const { data } = await supabaseAdmin().from('mail_identities').select(COLUMNS).eq('id', identityId).is('deleted_at', null).maybeSingle();
  const identity = data ? toIdentity(data as Row) : null;
  if (!identity || identity.userId !== ctx.userId) throw new TeamsError('You can only do this on your own account.');
  if (!usable(identity)) throw new TeamsError('This account needs reconnecting first.');
  return identity;
}

/** An account the caller may read from, on behalf of whoever may see it. */
export async function readableIdentity(ctx: AuthContext, kind: TeamsKind, identityId: string): Promise<{ identity: Identity; own: boolean }> {
  const { data } = await supabaseAdmin().from('mail_identities').select(COLUMNS).eq('id', identityId).is('deleted_at', null).maybeSingle();
  const identity = data ? toIdentity(data as Row) : null;
  if (!identity) throw new TeamsError('That account is no longer connected.');
  const { own } = await dataOwner(ctx, kind, identity.userId);
  return { identity, own };
}

/** The people picker: the caller first, then everyone with an account to look at. */
export async function peopleFor(ctx: AuthContext, kind: TeamsKind): Promise<PersonChoice[]> {
  const admin = supabaseAdmin();
  const { data: me } = await admin.from('profiles').select('full_name, email').eq('id', ctx.userId).maybeSingle();
  const self: PersonChoice = { userId: ctx.userId, name: `${(me?.full_name as string | null)?.trim() || (me?.email as string | null) || 'Me'} (me)`, own: true };
  if (!(await seesAll(ctx, kind))) return [self];

  const { data: rows } = await admin.from('mail_identities').select('user_id').is('deleted_at', null).neq('user_id', ctx.userId);
  const ids = [...new Set((rows ?? []).map((r) => r.user_id as string))];
  if (ids.length === 0) return [self];
  const [{ data: hidden }, { data: profiles }] = await Promise.all([
    admin.from('mail_user_settings').select('user_id').in('user_id', ids).eq(hideColumn(kind), true),
    admin.from('profiles').select('id, full_name, email').in('id', ids).is('deleted_at', null),
  ]);
  const gone = new Set((hidden ?? []).map((r) => r.user_id as string));
  const others = (profiles ?? [])
    .filter((p) => !gone.has(p.id as string))
    .map((p) => ({ userId: p.id as string, name: (p.full_name as string | null)?.trim() || (p.email as string), own: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [self, ...others];
}

/** Admins and Super admins get the two hide switches. */
export async function canHideOwn(ctx: AuthContext): Promise<boolean> {
  if (ctx.isAdmin) return true;
  return (await permissionsFor(ctx)).userType === 'admin';
}

export async function pendingApproval(userId: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from('teams_pending_approvals').select('id').eq('user_id', userId).maybeSingle();
  return Boolean(data);
}
