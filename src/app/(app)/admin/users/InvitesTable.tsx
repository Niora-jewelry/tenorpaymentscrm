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
 * ── RENEW AND RESEND ARE DIFFERENT THINGS ────────────────────────────────
 * This block used to explain that only Renew was offered, because there was
 * no invite email in this build: an invite is permission for a person to
 * complete signup, and the code proving their address is requested BY THEM at
 * /signup, so there was nothing to resend.
 *
 * That changed when the invite email was added — the person now has to be
 * told they were invited at all. The two actions are still distinct and both
 * are needed:
 *
 *   Renew  — the invite is past its date. Gives it more time. Changes the row.
 *   Resend — the invite is live but the person was never told, or the email
 *            failed. Sends the same invitation again. Changes nothing.
 *
 * Resend is therefore hidden on a stale invite: `sendInviteNotification`
 * refuses an expired one outright, so offering it would only produce an error
 * telling the admin to press Renew, which is already sitting next to it.
 */
import { useState, useTransition } from 'react';
import { OutlineChip, StatusPill, Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { formatDateTime } from '@/proto/ui/tokens';
import { revokeInviteAction, renewInviteAction, sendInviteEmailAction } from './actions';
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
  /* Carries a tone, not just words. Every message here used to be rendered
     red under a warning triangle, which was right while the only outcomes
     were failures. Resend can succeed, and a confirmation drawn as an error
     is worse than no confirmation at all. */
  type RowNotice = { tone: 'ok' | 'bad'; text: string };
  const [notice, setNotice] = useState<Map<string, RowNotice>>(new Map());
  const [showSettled, setShowSettled] = useState(false);

  const setNoticeFor = (id: string, message: string | null, tone: 'ok' | 'bad' = 'bad') =>
    setNotice((prev) => {
      const next = new Map(prev);
      if (message === null) next.delete(id);
      else next.set(id, { tone, text: message });
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
            An invite is permission to complete signup, and an email telling the person to use
            it goes out when you finish the invite dialog &mdash; Resend sends it again. It does
            not carry a code: they go to the sign-up page and request their own.
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
                      <p
                        role="status"
                        className={`mt-1 flex items-start gap-1.5 text-[12px] ${
                          rowNotice.tone === 'ok' ? 'text-ok' : 'text-[#b02a30]'
                        }`}
                      >
                        <Icon
                          name={rowNotice.tone === 'ok' ? 'check' : 'alert-triangle'}
                          size={12}
                          className="mt-[2px] shrink-0"
                        />
                        {rowNotice.text}
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
                        {/* Resend covers the two ways a pending invite ends up
                            unannounced: the admin closed the dialog without
                            sending, or the send itself failed. Not offered on a
                            stale one, because `sendInviteNotification` refuses
                            an expired invite — Renew first, which is the button
                            immediately to the left. */}
                        {i.status === 'pending' && !i.isStale ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="mail"
                            onClick={() =>
                              run(i.id, async () => {
                                const r = await sendInviteEmailAction(i.id);
                                if (r.ok) {
                                  setNoticeFor(i.id, `Invitation email sent to ${i.email}.`, 'ok');
                                }
                                return r;
                              })
                            }
                          >
                            Resend
                          </Button>
                        ) : null}
                        {/*
                          Offered on anything still actionable, which is the
                          same test the list itself uses. It was `pending`
                          only, so an invite that lapsed could be renewed and
                          never cancelled — and "they are not joining after
                          all" is at least as common a reason to be looking at
                          an expired invite as "give them more time".

                          Not offered on accepted or revoked: one has been
                          spent, the other is already cancelled. Those rows
                          are history, and the server refuses both regardless.
                        */}
                        {actionable(i) ? (
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
