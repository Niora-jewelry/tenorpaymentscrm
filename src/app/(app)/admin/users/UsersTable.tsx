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
     * ── WHY THIS SCROLLS INSTEAD OF FITTING ──────────────────────────────
     * Seven columns, one of which holds a permission badge AND a template
     * dropdown side by side. With `overflow-hidden` and no minimum width the
     * browser had to make it fit, so it crushed the columns: the badge wrapped
     * onto three lines, the dropdown collapsed to a sliver, and the two
     * overlapped. That is the "corrupted" screen in the client's screenshot —
     * not corruption, a table with nowhere to go.
     *
     * A minimum width plus horizontal scroll is the honest fix. Below roughly
     * 1100px the table scrolls sideways and every cell stays readable, which
     * is what a dense admin table should do rather than degrade into overlap.
     */
    <div className="overflow-x-auto rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <table className="w-full min-w-[1100px] border-separate border-spacing-0 text-[13.5px]">
        <thead>
          <tr>
            {['User', 'Role', 'Permissions', 'Record access', 'Status', 'Last login', ''].map((h) => (
              <th key={h} className="whitespace-nowrap border-b border-line-soft bg-white px-3 py-2.5 text-left text-[12px] font-semibold uppercase tracking-[.04em] text-ink-400">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const isSelf = u.id === currentUserId;
            const busy = pending && busyId === u.id;
            // `undefined` — not staged — is a different state from `''`, which
            // is the select's own placeholder, so `.get()` is read directly
            // rather than defaulted.
            const stagedId = staged.get(u.id);
            const rowNotice = notice.get(u.id) ?? null;
            return (
              <tr key={u.id} className="group">
                <td className="border-b border-line-faint px-3 py-2.5">
                  <div className="font-medium text-ink-900">{u.fullName ?? u.email}</div>
                  {u.fullName ? <div className="text-[12px] text-ink-400">{u.email}</div> : null}
                </td>
                <td className="whitespace-nowrap border-b border-line-faint px-3 py-2.5 align-middle text-ink-700">
                  {u.roleName}
                  {u.isAdmin ? <span className="ml-1.5 text-[11px] text-brand-600">(admin)</span> : null}
                </td>
                <td className="border-b border-line-faint px-3 py-2.5 align-top">
                  {/* Stacked, not side by side. "Template: Support Agent
                      (edited)" next to a select is wider than any sensible
                      column, and forcing them onto one line is what produced
                      the overlap. */}
                  <div className="flex min-w-[230px] flex-col items-start gap-1.5">
                    {/* The badge summarises this person's permission state in
                        three words; the link is where you see the 148 scopes
                        behind it, template grant and override side by side —
                        and, since 6c, where an override is set. */}
                    <Link
                      href={`/admin/users/${u.id}/permissions`}
                      title={`Permissions for ${u.email}`}
                      className="rounded transition-opacity hover:opacity-80"
                    >
                      {templateBadge(u)}
                    </Link>
                    <select
                      aria-label={`Assign template to ${u.email}`}
                      disabled={busy}
                      value={stagedId ?? ''}
                      onChange={(e) => {
                        // Back to the placeholder is "never mind", not "assign
                        // nothing" — that is what `No template` is for.
                        setFor(setStaged, u.id, e.target.value || null);
                        setFor(setNotice, u.id, null);
                      }}
                      className={`rounded border border-line bg-white px-1 py-0.5 text-[11.5px] text-ink-400 outline-none transition-opacity focus:opacity-100 group-hover:opacity-100 ${
                        stagedId === undefined ? 'opacity-0' : 'opacity-100'
                      }`}
                    >
                      <option value="">Assign template…</option>
                      {/* 6a found the dropdown could never UN-assign, though
                          `assignTemplate` has always accepted null. Needs its
                          own sentinel, because `''` is already "nothing staged"
                          — and the same confirmation applies, since detaching
                          clears overrides too. */}
                      <option value={NO_TEMPLATE}>No template</option>
                      {templates.map((t) => (
                        <option key={t.id} value={t.id}>{t.label}</option>
                      ))}
                    </select>
                    {stagedId !== undefined ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="check"
                          disabled={busy}
                          onClick={() => runAssign(u.id, stagedId, Boolean(rowNotice))}
                        >
                          {rowNotice ? 'Confirm' : 'Apply'}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setFor(setStaged, u.id, null);
                            setFor(setNotice, u.id, null);
                          }}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : null}
                  </div>
                  {rowNotice ? (
                    <p className="mt-1 flex items-start gap-1.5 text-[12px] text-[#8a5a09]">
                      <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
                      <span>
                        {rowNotice}
                        {stagedId !== undefined ? (
                          <>
                            {' '}
                            Assigning <strong>{templateName(templates, stagedId)}</strong>.
                          </>
                        ) : null}
                      </span>
                    </p>
                  ) : null}
                </td>
                {/* A different question from the column beside it, and kept
                    visually separate for that reason: Permissions decides what
                    is shown OF a record this person can see, Record access
                    decides which records exist for them at all
                    (`record_visibility_grants` → `can_see_record()`). */}
                <td className="border-b border-line-faint px-3 py-2.5">
                  <Link
                    href={`/admin/users/${u.id}/record-access`}
                    title={`Record visibility for ${u.email}`}
                    className="inline-flex items-center gap-1 text-[12.5px] text-brand-700 hover:underline"
                  >
                    <Icon name="eye" size={12} />
                    {u.visibilityGrantCount === 0
                      ? 'None'
                      : `${u.visibilityGrantCount} grant${u.visibilityGrantCount === 1 ? '' : 's'}`}
                  </Link>
                </td>
                <td className="border-b border-line-faint px-3 py-2.5 align-middle">
                  <StatusPill label={u.status === 'active' ? 'Active' : 'Paused'} swatch={u.status === 'active' ? 'teal' : 'amber'} />
                </td>
                {/* Admin §2.2: "the user list shows a last-login column;
                    clicking through opens the user's full login history". The
                    column was plain text, so the second half of that sentence
                    had nowhere to go. A person who has never signed in still
                    links — failed attempts and refused signups are exactly what
                    an admin looks for on an account with no successful login. */}
                <td className="whitespace-nowrap border-b border-line-faint px-3 py-2.5 align-middle tabular">
                  <Link
                    href={`/admin/users/${u.id}/login-history`}
                    title={`Login history for ${u.email}`}
                    className="inline-flex items-center gap-1.5 text-ink-500 transition-colors hover:text-brand-700 hover:underline"
                  >
                    <Icon name="clock" size={12} className="shrink-0 text-ink-400" />
                    {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}
                  </Link>
                </td>
                <td className="w-px whitespace-nowrap border-b border-line-faint px-3 py-2.5 text-right align-middle">
                  {isSelf ? (
                    <span className="text-[11.5px] text-ink-400">You</span>
                  ) : (
                    <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                      {/*
                        The client's "I need the ability to sign in as other
                        user types to test". Offered only where it can work and
                        is worth doing: an admin sees everything already, and a
                        paused account must not hold a session at all — the
                        library refuses both, this just does not tempt anyone.
                      */}
                      {!u.isAdmin && u.status === 'active' ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon="eye"
                          disabled={busy}
                          onClick={() => runImpersonate(u.id)}
                          title={`See the CRM exactly as ${u.email} sees it`}
                        >
                          Sign in as
                        </Button>
                      ) : null}
                      {u.status === 'active' ? (
                        <Button size="sm" variant="ghost" icon="lock" disabled={busy} onClick={() => runPause(u.id)}>
                          Pause
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" icon="check" disabled={busy} onClick={() => runResume(u.id)}>
                          Resume
                        </Button>
                      )}
                      {/* Pause's two successors — §2.1's soft and full delete —
                          behind one control, because neither is a single click:
                          both are blocked until this person's records have been
                          handed to someone else. */}
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="trash"
                        disabled={busy}
                        onClick={() => setOffboarding(u.id)}
                      >
                        Remove
                      </Button>
                    </div>
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
