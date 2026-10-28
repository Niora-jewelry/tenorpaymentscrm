/**
 * `Admin → Users → one person → Login history` — Admin Plan §2.2.
 *
 * "Login visibility: the user list shows a last-login column; clicking through
 * opens the user's full login history (timestamps, IP addresses, user agents)
 * sourced from the auth audit log."
 *
 * The column existed and led nowhere — it was text, not a link, so the second
 * half of that sentence had no screen. Nothing new is captured here:
 * `auth_audit_log` has carried the ip and the user agent on every
 * authentication event since migration 1, and this page reads them.
 *
 * ── FAILURES ARE THE POINT, NOT AN EXTRA ─────────────────────────────────
 * An admin opening a login history is usually asking one of two questions:
 * "when was this person last in" (already answered on the list) or "is somebody
 * trying to get into this account". The second is answered only by the rows
 * where nobody got in — a failed password, a wrong OTP, a rate-limited burst —
 * so those are included and marked rather than filtered out as noise.
 *
 * ── ADMIN-ONLY, LIKE EVERY OTHER ADMIN ROUTE ─────────────────────────────
 * `ctx.isAdmin` then redirect, checked here and again inside `listLoginHistory`.
 * `auth_audit_log` is not readable by the request-scoped client at all, so
 * there is no path to this data that skips the check.
 */
import { notFound, redirect } from 'next/navigation';
import { authorize, canOpenAdminPage } from '@/lib/records/permissions';
import { listUsers, listLoginHistory } from '@/lib/records/adminUsers';
import { OutlineChip, StatusPill } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { formatDateTime } from '@/proto/ui/tokens';
import { MatrixBackLink } from '../../../GrantMatrix';

/** Audit event types, in the words an admin reads rather than the words the
 *  auth code logs. An unmapped type falls back to its raw name rather than
 *  being hidden — a history that quietly drops rows it does not recognise is
 *  worse than one that shows an ugly string. */
const EVENT_LABEL: Record<string, string> = {
  login_success: 'Signed in',
  login_failure: 'Failed sign-in',
  otp_requested: 'One-time code sent',
  otp_verified: 'One-time code accepted',
  otp_failed: 'One-time code rejected',
  otp_rate_limited: 'Blocked — too many code attempts',
  otp_resend_cooldown: 'Blocked — code re-sent too soon',
  signup_completed: 'Signup completed',
  signup_rejected_no_invite: 'Signup refused — no invite',
  invite_accepted: 'Invite accepted',
  password_reset_completed: 'Password reset',
  user_soft_deleted: 'Account moved to the Recycle Bin',
  user_restored: 'Account restored',
  user_purged: 'Account permanently deleted',
  verify_probe: 'Session check',
};

export default async function UserLoginHistoryPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const { userId } = await params;

  const ctx = await authorize();
  if (!(await canOpenAdminPage(ctx, 'users'))) redirect('/dashboard');

  // The list is already an admin-scoped read and is small; reusing it avoids a
  // second "one profile by id" function that would have to repeat the same
  // role and template joins to render the same header.
  const [users, events] = await Promise.all([listUsers(ctx), listLoginHistory(ctx, userId)]);
  const user = users.find((u) => u.id === userId);
  if (!user) notFound();

  const failures = events.filter((e) => e.failed).length;

  return (
    <div className="space-y-5 p-6">
      <div className="space-y-2">
        <MatrixBackLink href="/admin/users" label="All users" />
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-ink-900">{user.fullName ?? user.email}</h1>
          <OutlineChip>{user.roleName}</OutlineChip>
          <StatusPill
            label={user.status === 'active' ? 'Active' : 'Paused'}
            swatch={user.status === 'active' ? 'teal' : 'amber'}
          />
        </div>
        <p className="text-[13px] text-ink-500">
          {user.email} — every authentication event on this account, newest first, from the auth
          audit log. Attempts that did not get in are included and marked.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-3">
        <Stat label="Last signed in" value={user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'Never'} />
        <Stat label="Events shown" value={String(events.length)} />
        <Stat label="Failed attempts" value={String(failures)} tone={failures > 0 ? 'warn' : undefined} />
      </dl>

      {events.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line px-4 py-8 text-center text-[13px] text-ink-400">
          Nothing recorded for this account yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <table className="w-full border-separate border-spacing-0 text-[13px]">
            <thead>
              <tr>
                {['When', 'Event', 'IP address', 'Device'].map((h) => (
                  <th
                    key={h}
                    className="border-b border-line-soft bg-white px-3 py-2.5 text-left text-[12px] font-semibold uppercase tracking-[.04em] text-ink-400"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td className="border-b border-line-faint px-3 py-2 tabular text-ink-500 whitespace-nowrap">
                    {formatDateTime(e.at)}
                  </td>
                  <td className="border-b border-line-faint px-3 py-2">
                    <span
                      className={`inline-flex items-center gap-1.5 ${
                        e.failed ? 'font-medium text-[#b02a30]' : 'text-ink-900'
                      }`}
                    >
                      {e.failed ? <Icon name="alert-triangle" size={12} className="shrink-0" /> : null}
                      {EVENT_LABEL[e.eventType] ?? e.eventType}
                    </span>
                  </td>
                  <td className="border-b border-line-faint px-3 py-2 tabular text-ink-600">
                    {e.ip ?? <span className="text-ink-300">—</span>}
                  </td>
                  {/* The raw user agent, truncated on screen and complete in the
                      title. Not parsed into "Chrome on Windows": the client
                      asked for user agents, and a parser that guesses wrong on a
                      string an admin may be investigating is worse than the
                      string itself. */}
                  <td
                    className="max-w-[280px] truncate border-b border-line-faint px-3 py-2 text-[12px] text-ink-500"
                    title={e.userAgent ?? undefined}
                  >
                    {e.userAgent ?? <span className="text-ink-300">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="bg-white px-4 py-3">
      <dt className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">{label}</dt>
      <dd className={`mt-0.5 text-[14px] font-semibold tabular ${tone === 'warn' ? 'text-[#b02a30]' : 'text-ink-900'}`}>
        {value}
      </dd>
    </div>
  );
}
