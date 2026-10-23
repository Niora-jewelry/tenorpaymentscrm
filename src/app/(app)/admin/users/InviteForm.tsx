'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { InvitePermissionsStep } from './InvitePermissionsStep';
import type { ModuleOption } from '../ModuleScopePicker';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { inviteUserAction, type InviteState } from './actions';
import type { RoleOption } from '@/lib/records/adminUsers';
import type { TemplateOption } from '@/lib/records/adminTemplates';

const initial: InviteState = { ok: false };

/** Split out of `InviteUserDialog.tsx` so the parent can remount it (via a
 * `key`) fresh on every open — this component's own `useActionState`
 * naturally resets to `initial` on remount, without needing an effect that
 * sets state in response to state (`react-hooks/set-state-in-effect`). */
export function InviteForm({
  roles,
  templates,
  modules,
  onClose,
  onStepChange,
}: {
  roles: RoleOption[];
  templates: TemplateOption[];
  /** Non-admin-only modules, for step two's per-module picker. */
  modules: ModuleOption[];
  onClose: () => void;
  /** Lets the dialog widen for the matrix — a 440px modal cannot hold it. */
  onStepChange?: (step: 'form' | 'permissions') => void;
}) {
  // `isPending` — the third element, previously discarded. Sending an invite
  // writes a row and, once a mailer is configured, sends an email; on the live
  // remote database that is a visible wait during which this dialog gave no
  // sign at all, and the obvious response to a button that looks inert is to
  // press it again.
  const [state, action, isPending] = useActionState(inviteUserAction, initial);
  const inputRef = useRef<HTMLInputElement>(null);
  // Kept so step two can name the person without re-reading the form, which
  // has been replaced by then.
  const [submittedEmail, setSubmittedEmail] = useState('');
  // The role picked so far. An admin role is exempt from every permission rule
  // (the Permissions screen's own words), so offering a template with it only
  // invites the question "why does nothing I set apply?" — seen 23 Oct 2026.
  const [roleId, setRoleId] = useState(roles.find((r) => !r.isAdmin)?.id ?? '');
  const pickedRole = roles.find((r) => r.id === roleId);
  const adminRole = Boolean(pickedRole?.isAdmin);

  const onPermissions = Boolean(state.ok && state.inviteId);
  useEffect(() => {
    onStepChange?.(onPermissions ? 'permissions' : 'form');
  }, [onPermissions, onStepChange]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /*
   * ── STEP TWO, IN THE SAME DIALOG ──────────────────────────────────────
   * The client asked to adjust permissions "before sending invite". Sending
   * the admin to another page to do it is not that, and it loses the invite
   * they were halfway through. So the created invite stays on screen and the
   * matrix swaps in against it.
   *
   * The invite genuinely exists by this point — that is what makes the matrix
   * writable, since `invite_grants` has to point at an invite — and nothing
   * has been emailed, so "before sending" still holds.
   */
  if (state.ok && state.inviteId) {
    return (
      <InvitePermissionsStep
        inviteId={state.inviteId}
        email={submittedEmail}
        modules={modules}
        onDone={onClose}
      />
    );
  }

  // Invite created but no id came back — nothing to adjust, so just confirm it.
  if (state.ok) {
    return (
      <div className="mt-4">
        <p className="flex items-center gap-1.5 text-[13px] text-ok">
          <Icon name="check" size={14} strokeWidth={2.5} />
          Invite created.
        </p>
        <div className="mt-5 flex justify-end">
          <Button type="button" variant="primary" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="mt-4">
      <label className="block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Email</label>
      <input
        ref={inputRef}
        name="email"
        type="email"
        required
        // Kept because step two names the person, and the form is gone by then.
        onChange={(e) => setSubmittedEmail(e.target.value)}
        disabled={isPending}
        placeholder="name@company.com"
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      />

      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Role</label>
      {/*
        The default is the least-privileged role, chosen by the DATA rather than
        by name. This used to look up the slug 'member' and fall back to the
        first role in the list, which is sorted alphabetically — so deleting or
        renaming that one row would silently have made Super Admin the default
        selection on the invite form. Reading `is_admin` cannot fail that way,
        and it stops this being the one place in the codebase that types a role
        name, which the specification forbids outright.
      */}
      <select
        name="roleId"
        required
        disabled={isPending}
        value={roleId}
        onChange={(e) => setRoleId(e.target.value)}
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      >
        {roles.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>
      {adminRole ? (
        <p className="mt-1.5 rounded-lg bg-canvas px-3 py-2 text-[12px] leading-relaxed text-ink-500">
          A {pickedRole?.name} sees and can edit everything. Templates and permissions do not limit this role, so there is nothing to
          pick here; choose {roles.find((r) => !r.isAdmin)?.name ?? 'the other role'} to invite someone whose access a template should set.
        </p>
      ) : null}

      {/*
        ── PERMISSIONS, AT INVITE TIME ──────────────────────────────────
        The client's request: "when inviting a user I should be able to
        immediately assign permissions". A template IS a named set of
        permissions, so picking one here is the whole answer — and it is
        applied by `complete_signup` in the same transaction that creates the
        profile, so there is never a moment where the account exists
        unconfigured.

        That moment is the reason this matters. An unset scope resolves to
        EDIT, not Hidden — the rule the Permissions screen warns about in its
        own words — so the gap between someone accepting an invite and an admin
        getting round to them was a window of full access.

        A scope-by-scope matrix is deliberately NOT offered here: it would
        duplicate the Permissions screen and the two would drift.
      */}
      {adminRole ? null : (
      <>
      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
        Permissions
      </label>
      <select
        name="templateId"
        disabled={isPending}
        defaultValue=""
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      >
        {/* Not a template is a real choice, not an empty state — an admin may
            intend to configure someone by hand. It is named accordingly, and
            says what it means rather than leaving a blank row. */}
        <option value="">No template — full access until configured</option>
        {templates.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11.5px] text-ink-400">
        Applied the moment they finish signing up. Editing the template later reaches them too.
      </p>
      </>
      )}

      {state.message ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {state.message}
        </p>
      ) : (
        <p className="mt-1.5 text-[11.5px] text-ink-400">Expires in 7 days if not accepted.</p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" disabled={isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" icon="check" loading={isPending} loadingLabel="Sending…">
          Send invite
        </Button>
      </div>
    </form>
  );
}
