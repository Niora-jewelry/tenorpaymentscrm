'use client';

/**
 * Real user table — role, permission-template badge (live from
 * `user_templates`/`user_grants`, not the prototype's `i % 4` fake logic),
 * status, last login, pause/resume, and assigning an existing template.
 *
 * No optimistic local state here the way `RecordsTable.tsx` has: pause/
 * resume/assign are infrequent, low-latency-sensitive admin actions, not the
 * dense drawer-field-editing hot path that pattern exists for — a plain
 * `router.refresh()`-free `revalidatePath` round trip (already how every
 * action here works) is the right amount of engineering for this screen.
 *
 * ── USER TYPE ───────────────────────────────────────────────────────────
 * Everyone has exactly one user type (Permissions spec), and their role follows
 * it (`perm_assign_type`). Changing it KEEPS their personal overrides — "Only
 * the settings that were overridden for them stay as they are" — so the row
 * menu stages the choice and applies it, with no destructive confirmation.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { StatusPill, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { formatDateTime } from '@/proto/ui/tokens';
import { pauseUserAction, resumeUserAction, assignTemplateAction } from './actions';
import { OffboardDialog } from './OffboardDialog';
import type { AdminUserRow } from '@/lib/records/adminUsers';
import type { TemplateOption } from '@/lib/records/adminTemplates';
import { startImpersonationAction } from './impersonateActions';
import { UserRowMenu } from './UserRowMenu';

/**
 * The user's type, as one chip, with their personal overrides counted beside
 * it ("clearly mark which settings on a user are overrides"). A Super admin
 * has everything whatever is set, so overrides are not counted on them.
 */
function typeBadge(u: AdminUserRow) {
  if (!u.templateLabel) return <OutlineChip tone="warn">No user type</OutlineChip>;
  const n = u.isAdmin ? 0 : u.overrideCount;
  return (
    <OutlineChip tone={n ? 'warn' : 'brand'}>
      <span title={u.templateLabel} className="block max-w-[200px] truncate">
        {u.templateLabel}
        {n ? ` · ${n} override${n === 1 ? '' : 's'}` : ''}
      </span>
    </OutlineChip>
  );
}

export function UsersTable({
  users,
  templates,
  currentUserId,
}: {
  users: AdminUserRow[];
  templates: TemplateOption[];
  currentUserId: string;
}) {
  const [pending, startTransition] = useTransition();
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The template each row has selected but not yet committed. */
  const [staged, setStaged] = useState<Map<string, string>>(new Map());
  /** Whatever the server said about a row — the override-count refusal, or a
   * real error. Keyed by user, cleared when that row is touched again. */
  const [notice, setNotice] = useState<Map<string, string>>(new Map());
  /** The user whose Remove flow is open, if any — Admin §2.1's second and third
   * levels, which are a two-step flow rather than a single button and therefore
   * live in their own dialog. */
  const [offboarding, setOffboarding] = useState<string | null>(null);

  const setFor = <T,>(set: (fn: (prev: Map<string, T>) => Map<string, T>) => void, id: string, value: T | null) =>
    set((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(id);
      else next.set(id, value);
      return next;
    });

  const router = useRouter();

  const runPause = (id: string) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await pauseUserAction(id);
      setBusyId(null);
      setFor(setNotice, id, result.ok ? null : (result.message ?? 'That did not work.'));
    });
  };
  /*
   * Unlike pause/resume this REPLACES the session, so there is nothing
   * sensible to do on success — the page the admin is looking at belongs to
   * somebody else now. `router.refresh()` re-renders the whole tree under the
   * new session, which is what puts the banner up and swaps the sidebar.
   */
  const runImpersonate = (id: string) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await startImpersonationAction(id);
      setBusyId(null);
      if (result.ok) {
        router.refresh();
        return;
      }
      setFor(setNotice, id, result.message ?? 'That did not work.');
    });
  };

  const runResume = (id: string) => {
    setBusyId(id);
    startTransition(async () => {
      const result = await resumeUserAction(id);
      setBusyId(null);
      setFor(setNotice, id, result.ok ? null : (result.message ?? 'That did not work.'));
    });
  };

  const runAssign = (id: string, staged: string) => {
    setBusyId(id);
    setFor(setNotice, id, null);
    startTransition(async () => {
      const result = await assignTemplateAction(id, staged);
      setBusyId(null);
      if (result.ok) {
        setFor(setStaged, id, null);
        return;
      }
      setFor(setNotice, id, result.message);
    });
  };

  const offboardingUser = users.find((u) => u.id === offboarding) ?? null;

  return (
    /*
     * FOUR COLUMNS, NOT SEVEN.
     *
     * The previous version had seven, one of which held a permission badge AND
     * a template select side by side. Nothing could make that fit, so it was
     * given a minimum width and a horizontal scrollbar -- which is an
     * anti-pattern, not a layout, and the client said so.
     *
     * The fix is structural rather than cosmetic: group the columns that
     * answer the same question, and collapse the row's four buttons into one
     * overflow menu.
     *
     *   USER      who they are         name, address, whether the account is live
     *   ACCESS    what they can do     role + permission label, both linked
     *   ACTIVITY  what they have done  last login + how many records they see
     *   (menu)    everything you can do to them
     *
     * Status folds into USER because "paused" is a property of the person, not
     * a fact worth its own column; record access folds into ACTIVITY because
     * it is a count, not an action. Nothing was removed -- every link and
     * control from the old row is still reachable.
     */
    <div className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <table className="w-full border-separate border-spacing-0 text-[13.5px]">
        <thead>
          <tr>
            {[
              { label: 'User', className: 'w-[38%]' },
              { label: 'Access', className: 'w-[30%]' },
              { label: 'Activity', className: 'w-[26%]' },
              { label: '', className: 'w-[6%]' },
            ].map((h) => (
              <th
                key={h.label}
                className={`${h.className} whitespace-nowrap border-b border-line-soft bg-canvas/40 px-4 py-2.5 text-left text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400`}
              >
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isSelf = u.id === currentUserId;
            const busy = pending && busyId === u.id;
            const stagedId = staged.get(u.id);
            const rowNotice = notice.get(u.id) ?? null;
            const paused = u.status !== 'active';

            return (
              <tr key={u.id} className="group align-middle transition-colors hover:bg-canvas/40">
                <td className="border-b border-line-faint px-4 py-3">
                  <div className="flex items-center gap-3">
                    {/* A monogram rather than an avatar image: there are no
                        photos in this system, and a coloured initial gives the
                        eye something to track down a long list. */}
                    <span
                      aria-hidden
                      className={`grid size-8 shrink-0 place-items-center rounded-full text-[12.5px] font-semibold ${
                        paused ? 'bg-canvas text-ink-400' : 'bg-brand-50 text-brand-700'
                      }`}
                    >
                      {(u.fullName ?? u.email).trim().charAt(0).toUpperCase()}
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate font-medium text-ink-900">
                          {u.fullName ?? u.email}
                        </span>
                        {isSelf ? (
                          <span className="shrink-0 rounded bg-canvas px-1.5 py-[1px] text-[10.5px] font-semibold uppercase tracking-[.04em] text-ink-400">
                            You
                          </span>
                        ) : null}
                        {paused ? <StatusPill label="Paused" swatch="amber" /> : null}
                      </div>
                      {u.fullName ? (
                        <div className="truncate text-[12px] text-ink-400">{u.email}</div>
                      ) : null}
                    </div>
                  </div>
                </td>

                <td className="border-b border-line-faint px-4 py-3">
                  {/* The type is the summary; the link is everything behind it —
                      settings, tabs and fields, and their own overrides. */}
                  <Link
                    href={`/admin/users/${u.id}/permissions`}
                    title={`Permissions for ${u.email}`}
                    className="inline-block rounded transition-opacity hover:opacity-80"
                  >
                    {typeBadge(u)}
                  </Link>
                </td>

                <td className="border-b border-line-faint px-4 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <Link
                      href={`/admin/users/${u.id}/login-history`}
                      title={`Login history for ${u.email}`}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] text-ink-600 transition-colors hover:text-brand-700 hover:underline"
                    >
                      <Icon name="clock" size={12} className="shrink-0 text-ink-400" />
                      <span className="tabular">
                        {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never signed in'}
                      </span>
                    </Link>
                    <Link
                      href={`/admin/users/${u.id}/record-access`}
                      title={`Record visibility for ${u.email}`}
                      className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12px] text-ink-500 transition-colors hover:text-brand-700 hover:underline"
                    >
                      <Icon name="eye" size={12} className="shrink-0 text-ink-400" />
                      {u.visibilityGrantCount === 0
                        ? 'No extra record access'
                        : `${u.visibilityGrantCount} record grant${u.visibilityGrantCount === 1 ? '' : 's'}`}
                    </Link>
                  </div>
                </td>

                <td className="border-b border-line-faint px-4 py-3 text-right">
                  {isSelf ? (
                    <span className="text-[11.5px] text-ink-300">&mdash;</span>
                  ) : (
                    <UserRowMenu
                      user={u}
                      templates={templates}
                      busy={busy}
                      stagedId={stagedId}
                      notice={rowNotice}
                      onStage={(value) => {
                        setFor(setStaged, u.id, value);
                        setFor(setNotice, u.id, null);
                      }}
                      onApply={(sel) => runAssign(u.id, sel)}
                      onCancelStage={() => {
                        setFor(setStaged, u.id, null);
                        setFor(setNotice, u.id, null);
                      }}
                      onImpersonate={() => runImpersonate(u.id)}
                      onPause={() => runPause(u.id)}
                      onResume={() => runResume(u.id)}
                      onRemove={() => setOffboarding(u.id)}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {users.length === 0 ? (
        <p className="flex items-center gap-2 px-3 py-6 text-[13px] text-ink-400">
          <Icon name="users" size={14} />
          No users yet.
        </p>
      ) : null}

      {offboardingUser ? (
        <OffboardDialog
          user={offboardingUser}
          // Active people other than the one leaving. `reassign_user_records`
          // checks this too and refuses a suspended or deleted target, so this
          // list is what the admin is offered, not what the rule is.
          candidates={users.filter((u) => u.id !== offboardingUser.id && u.status === 'active')}
          onClose={() => setOffboarding(null)}
        />
      ) : null}
    </div>
  );
}
