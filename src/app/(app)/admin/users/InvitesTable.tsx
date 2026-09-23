'use client';

/**
 * Pending and past invites — Login spec §2, and the half of Admin Plan §2.1
 * that had no screen.
 *
 * Sending an invite already worked. Seeing what was outstanding did not, so an
 * invite sent to the wrong address could not be taken back, and an admin had no
 * way to answer "did I already invite them?" except by trying again.
 *
 * ── WHY IT SHOWS ACCEPTED AND REVOKED ONES TOO ───────────────────────────
 * The list is the audit of who was let in and by whom. Filtering it down to
 * pending would answer today's question and lose that, so past invites stay,
 * visibly settled, with no actions on them.
 *
 * ── WHY AN EXPIRED INVITE OFFERS "RENEW" AND NOT "RESEND" ────────────────
 * There is no invite email in this build, deliberately: an invite is permission
 * for a person to complete signup, and the code that proves their address is
 * requested by them at /signup. So "resend" would send nothing. What an admin
 * actually wants when someone says their invite expired is more time, which is
 * what Renew gives.
 */
import { useState, useTransition } from 'react';
import { OutlineChip, StatusPill, Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { formatDateTime } from '@/proto/ui/tokens';
import { revokeInviteAction, renewInviteAction } from './actions';
import type { AdminInviteRow } from '@/lib/records/adminUsers';
import Link from 'next/link';

function statusPill(invite: AdminInviteRow) {
  if (invite.status === 'accepted') return <StatusPill label="Accepted" swatch="teal" />;
  if (invite.status === 'revoked') return <StatusPill label="Cancelled" swatch="slate" />;
  if (invite.status === 'expired' || invite.isStale) return <StatusPill label="Expired" swatch="amber" />;
  return <StatusPill label="Pending" swatch="blue" />;
}

export function InvitesTable({ invites }: { invites: AdminInviteRow[] }) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Map<string, string>>(new Map());
  const [showSettled, setShowSettled] = useState(false);

  const setNoticeFor = (id: string, message: string | null) =>
    setNotice((prev) => {
      const next = new Map(prev);
      if (message === null) next.delete(id);
      else next.set(id, message);
      return next;
    });

  const run = (id: string, fn: () => Promise<{ ok: boolean; message?: string }>) => {
    setBusyId(id);
    setNoticeFor(id, null);
    startTransition(async () => {
      try {
        const result = await fn();
        if (!result.ok) setNoticeFor(id, result.message ?? 'That did not work.');
      } catch {
        setNoticeFor(id, 'That did not work. Nothing was changed.');
      } finally {
        setBusyId(null);
      }
    });
  };

  // Anything still actionable comes first and is always shown; settled rows are
  // history and sit behind a toggle so the useful list is not buried.
  // "Actionable" is anything an admin can still act on. An EXPIRED invite belongs
  // here, not in history: renewing one is the single most likely reason to be
  // on this screen, and burying it behind the toggle would hide the fix.
  const actionable = (i: AdminInviteRow) => i.status === 'pending' || i.status === 'expired';
  const open = invites.filter(actionable);
  const settled = invites.filter((i) => !actionable(i));
  const shown = showSettled ? [...open, ...settled] : open;

  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-ink-900">Invites</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">
            An invite is permission to complete signup. The person goes to the sign-up page and
            requests their own code; nothing is emailed from here.
          </p>
        </div>
        {settled.length ? (
          <button
            type="button"
            onClick={() => setShowSettled((v) => !v)}
            className="text-[12.5px] font-semibold text-brand-700 transition-colors hover:underline"
          >
            {showSettled ? 'Hide' : 'Show'} {settled.length} settled
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-6 text-[13px] text-ink-400">
          <Icon name="mail" size={14} />
          No outstanding invites.
        </p>
      ) : (
        <table className="w-full border-separate border-spacing-0 text-[13.5px]">
          <thead>
            <tr>
              {['Email', 'Role', 'Invited by', 'Status', 'Expires', ''].map((h) => (
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
            {shown.map((i) => {
              const busy = pending && busyId === i.id;
              const rowNotice = notice.get(i.id) ?? null;
              return (
                <tr key={i.id}>
                  <td className="border-b border-line-faint px-3 py-2.5">
                    <div className="font-medium text-ink-900">{i.email}</div>
                    {rowNotice ? (
                      <p className="mt-1 flex items-start gap-1.5 text-[12px] text-[#b02a30]">
                        <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
                        {rowNotice}
                      </p>
                    ) : null}
                  </td>
                  <td className="border-b border-line-faint px-3 py-2.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <OutlineChip>{i.roleName}</OutlineChip>
                      {/* The permissions this invite will apply. "No template"
                          is stated rather than left blank, because it is not a
                          missing value — it means the person will land on the
                          default, and the default is Edit on everything unset. */}
                      {i.templateLabel ? (
                        <OutlineChip>{i.templateLabel}</OutlineChip>
                      ) : (
                        <span className="text-[11.5px] text-ink-400">No template</span>
                      )}
                    </span>
                  </td>
                  <td className="border-b border-line-faint px-3 py-2.5 text-ink-600">
                    {i.invitedByName ?? '—'}
                  </td>
                  <td className="border-b border-line-faint px-3 py-2.5">{statusPill(i)}</td>
                  <td className="border-b border-line-faint px-3 py-2.5 tabular text-ink-500">
                    {i.status === 'accepted'
                      ? i.acceptedAt
                        ? `Accepted ${formatDateTime(i.acceptedAt)}`
                        : 'Accepted'
                      : formatDateTime(i.expiresAt)}
                  </td>
                  <td className="border-b border-line-faint px-3 py-2.5 text-right">
                    {!actionable(i) ? (
                      <span className="text-[11.5px] text-ink-300">No action</span>
                    ) : busy ? (
                      <span className="text-[11.5px] text-ink-400">Working…</span>
                    ) : (
                      <span className="flex items-center justify-end gap-1">
                        {/* Permissions stay editable for as long as the invite
                            is pending — the rows are copied into `user_grants`
                            at signup, so after that this link would edit
                            something nothing reads. */}
                        {i.status === 'pending' ? (
                          <Link
                            href={`/admin/users/invites/${i.id}/permissions`}
                            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-ink-600 transition-colors hover:bg-canvas hover:text-ink-900"
                          >
                            <Icon name="sliders" size={12} />
                            Permissions
                          </Link>
                        ) : null}
                        {/* Renew is offered on anything past its date, whether
                            the sweep has relabelled it yet or not. */}
                        {i.status === 'expired' || i.isStale ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="rotate-ccw"
                            onClick={() => run(i.id, () => renewInviteAction(i.id))}
                          >
                            Renew
                          </Button>
                        ) : null}
                        {i.status === 'pending' ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="x"
                            onClick={() => run(i.id, () => revokeInviteAction(i.id))}
                          >
                            Cancel
                          </Button>
                        ) : null}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
