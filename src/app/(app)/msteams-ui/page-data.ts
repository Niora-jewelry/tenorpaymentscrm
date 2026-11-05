/** What both module pages work out before drawing anything. */
import 'server-only';
import { currentImpersonation } from '@/lib/auth/impersonation';
import { mailReady } from '@/lib/integrations/resolve';
import { connectErrorMessage, isConnectErrorCode } from '@/lib/mail/messages';
import { dataOwner, identitiesOf, peopleFor, TeamsError, toAccountView } from '@/lib/msteams/access';
import { adminRequestText, isWaitingForAdmin } from '@/lib/msteams/approvals';
import type { AccountView, PersonChoice, TeamsKind } from '@/lib/msteams/types';
import type { AuthContext } from '@/lib/records/permissions';

export type ModulePage = {
  configured: boolean;
  impersonating: boolean;
  /** The viewer's own accounts: they decide the Connect screen, whoever is being looked at. */
  accounts: AccountView[];
  /** The accounts of whoever is on screen. */
  shownAccounts: AccountView[];
  waiting: boolean;
  requestText: string;
  errorText: string | null;
  people: PersonChoice[];
  ownerId: string;
  own: boolean;
  /** Set when the requested person cannot be looked at. */
  refused: string | null;
};

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export async function modulePage(ctx: AuthContext, kind: TeamsKind, sp: Record<string, string | string[] | undefined>): Promise<ModulePage> {
  const blank = { accounts: [], shownAccounts: [], waiting: false, requestText: '', errorText: null, people: [], ownerId: ctx.userId, own: true, refused: null };
  if (!(await mailReady())) return { configured: false, impersonating: false, ...blank };
  if (await currentImpersonation()) return { configured: true, impersonating: true, ...blank };

  const [mine, waiting, people] = await Promise.all([identitiesOf(ctx.userId), isWaitingForAdmin(ctx.userId), peopleFor(ctx, kind)]);
  const accounts = mine.map(toAccountView);
  const err = first(sp.mail_error);
  const errorText = isConnectErrorCode(err) && err !== 'consent_required' ? connectErrorMessage(err) : null;
  // Always, not only when waiting: backing out of Microsoft's "Need admin approval" page
  // comes back as an ordinary cancel, so the app cannot tell that person needs it.
  const requestText = await adminRequestText();

  let ownerId = ctx.userId;
  let own = true;
  let refused: string | null = null;
  try {
    const who = await dataOwner(ctx, kind, first(sp.as));
    ownerId = who.ownerId;
    own = who.own;
  } catch (e) {
    if (!(e instanceof TeamsError)) throw e;
    refused = e.message;
  }
  const shownAccounts = own ? accounts : (await identitiesOf(ownerId)).map(toAccountView);
  return { configured: true, impersonating: false, accounts, shownAccounts, waiting, requestText, errorText, people, ownerId, own, refused };
}

/** A user with no approved account sees only the Connect screen, even with All users. */
export const needsConnect = (p: ModulePage): boolean => p.impersonating || !p.accounts.some((a) => a.approved);
