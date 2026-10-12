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
 * ── THE ASSIGN CONTROL IS DESTRUCTIVE, AS OF PHASE 6c ────────────────────
 * Attaching a template deletes every personal permission override that person
 * has — deliberately, because "Template: X" without "(edited)" has to mean they
 * have none (`adminUsers.ts` carries the full reasoning). That cost nothing
 * while nothing in the build could create an override; now the grant matrix can,
 * and a dozen hand-set grants can vanish behind a badge that simply changes.
 *
 * So the dropdown does not act on selection any more. It stages the choice, the
 * row states how many overrides the assignment will destroy, and the server
 * refuses the write until that has been acknowledged — the count coming from the
 * database at write time, not from this table's possibly-stale render.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { StatusPill, OutlineChip, Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { formatDateTime } from '@/proto/ui/tokens';
import { pauseUserAction, resumeUserAction, assignTemplateAction } from './actions';
import { OffboardDialog } from './OffboardDialog';
import type { AdminUserRow } from '@/lib/records/adminUsers';
import type { TemplateOption } from '@/lib/records/adminTemplates';
import { startImpersonationAction } from './impersonateActions';
import { UserRowMenu } from './UserRowMenu';

/** The client's three labels, plus the state he did not name (no template and
 * no overrides). Computed from real rows every render, never stored. */
/**
 * The three labels from the client's spec §8, as one chip.
 *
 * `max-w` + `truncate` because a template may be called anything — "Demo Rep
 * (permissions tour)" is real, and unconstrained it wrapped to three lines and
 * pushed the row's other cells out of shape. The full text stays available as
 * a tooltip rather than being lost.
 */
function templateBadge(u: AdminUserRow) {
  const hasOverrides = u.overrideCount > 0;
  /*
   * The truncation has to happen INSIDE the chip, not on a wrapper around it.
   * Wrapping it clipped the chip's own border and cut the text mid-word with
   * no ellipsis — "Template: Demo Rep (permissions tou" in the client's
   * screenshot. The chip keeps its shape; only its label shortens.
   */
  const chip = (tone: 'brand' | 'warn', text: string) => (
    <OutlineChip tone={tone}>
      <span title={text} className="block max-w-[200px] truncate">
        {text}
      </span>
    </OutlineChip>
  );
  /*
   * ⚠️ A TEMPLATE DOES NOT LIMIT AN ADMIN, SO DO NOT SAY THAT IT DOES.
   *
   * A Super Admin bypasses the permission chain entirely — `moduleGrant` and
   * friends short-circuit on `ctx.isAdmin`, and `auth_is_admin()` does the
   * same in RLS — so whatever template or overrides are attached to them
   * describe nothing that is currently in force.
   *
   * Rendering "Template: P2 (edited)" on a Super Admin row is therefore a
   * claim about their access that is not true, and it is the SAME confusion
   * the client already reported once from the other direction: he set a field
   * to View while inviting, saw Edit in the result, and asked why. The answer
   * both times is "because they are an admin". `GrantMatrix` says so in a
   * banner; this row said the opposite.
   *
   * The assignment is NOT hidden — it is real, it is editable from the menu on
   * this row, and it takes effect the moment the role changes. So the chip
   * names it in its tooltip and states plainly that it is not applied.
   *
   * Only when there is something to misread: an admin with no template and no
   * overrides already reads "Default", which claims nothing.
   */
  if (u.isAdmin && (u.templateLabel || hasOverrides)) {
    const assigned = u.templateLabel
      ? `Template: ${u.templateLabel}${hasOverrides ? ' (edited)' : ''}`
      : `${u.overrideCount} personal override${u.overrideCount === 1 ? '' : 's'}`;
    return (
      <OutlineChip tone="warn">
        <span
          title={`${assigned} — not in force. A Super Admin bypasses every module, tab, subtab and field permission, so this neither grants nor restricts anything today. It would apply if their role were changed to a non-admin one.`}
          className="block max-w-[200px] truncate"
        >
          Not applied &mdash; admin
        </span>
      </OutlineChip>
    );
  }

  if (u.templateLabel && hasOverrides) return chip('brand', `Template: ${u.templateLabel} (edited)`);
  if (u.templateLabel) return chip('brand', `Template: ${u.templateLabel}`);
  if (hasOverrides) return chip('warn', 'Custom');
  return <span className="text-ink-400">Default</span>;
}

/**
 * "Detach whatever template this person has" — 6a's finding, that the dropdown
 * could never un-assign even though `assignTemplate` has always accepted null.
 *
 * A sentinel rather than `''`, because the select's empty value already means
 * "nothing staged"; the action takes `''` and `adminUsers.ts` turns that into
 * NULL. Not a uuid, so a stray one reaching the server is rejected by
 * `assignTemplateSchema` rather than looked up.
 */
const NO_TEMPLATE = '__none__';

const toTemplateId = (staged: string): string => (staged === NO_TEMPLATE ? '' : staged);

/** The template a staged assignment names, for the confirmation sentence. */
function templateName(templates: TemplateOption[], staged: string): string {
  if (staged === NO_TEMPLATE) return 'no template';
  return templates.find((t) => t.id === staged)?.label ?? 'that template';
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

  /**
   * Two calls, not one. The first is unconfirmed and comes back refused if the
   * person has overrides, carrying the count; the second is the admin's answer.
   * The confirmation therefore quotes a number read from the database at that
   * moment rather than one this table rendered minutes ago.
   */
  const runAssign = (id: string, staged: string, confirm: boolean) => {
    setBusyId(id);
    setFor(setNotice, id, null);
    startTransition(async () => {
      const result = await assignTemplateAction(id, toTemplateId(staged), confirm);
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
                  <div className="flex flex-col items-start gap-1.5">
                    <span className="text-[12.5px] text-ink-600">
                      {u.roleName}
                      {u.isAdmin ? (
                        <span className="ml-1.5 text-[11px] font-medium text-brand-600">admin</span>
                      ) : null}
                    </span>
                    {/* The badge is the summary; the link is the scopes behind
                        it, template grant and override side by side. */}
                    <Link
                      href={`/admin/users/${u.id}/permissions`}
                      title={`Permissions for ${u.email}`}
                      className="rounded transition-opacity hover:opacity-80"
                    >
                      {templateBadge(u)}
                    </Link>
                  </div>
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
                      noTemplateValue={NO_TEMPLATE}
                      onStage={(value) => {
                        setFor(setStaged, u.id, value);
                        setFor(setNotice, u.id, null);
                      }}
                      onApply={(sel, confirm) => runAssign(u.id, sel, confirm)}
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
