'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { InvitePermissionsStep } from './InvitePermissionsStep';
import type { ModuleOption } from '../ModuleScopePicker';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { inviteUserAction, type InviteState } from './actions';
import type { TemplateOption } from '@/lib/records/adminTemplates';

const initial: InviteState = { ok: false };

/** Split out of `InviteUserDialog.tsx` so the parent can remount it (via a
 * `key`) fresh on every open — this component's own `useActionState`
 * naturally resets to `initial` on remount, without needing an effect that
 * sets state in response to state (`react-hooks/set-state-in-effect`). */
export function InviteForm({
  templates,
  canInviteSuper,
  modules,
  onClose,
  onStepChange,
}: {
  templates: TemplateOption[];
  canInviteSuper: boolean;
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
  // Everyone has one user type, and their role follows it (Permissions spec).
  // The default is the least-privileged type.
  const offered = templates.filter((t) => t.userType !== 'super_admin' || canInviteSuper);
  const [typeId, setTypeId] = useState(
    offered.find((t) => t.userType === 'sales_agent')?.id ?? offered[offered.length - 1]?.id ?? '',
  );
  const superPicked = templates.find((t) => t.id === typeId)?.userType === 'super_admin';

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

      {/*
        The client's request: "when inviting a user I should be able to
        immediately assign permissions". The user type is applied by
        `complete_signup` in the same transaction that creates the profile, so
        the account never exists without one. Step two can then adjust single
        tabs and fields for this one person.
      */}
      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">User type</label>
      <select
        name="templateId"
        required
        disabled={isPending}
        value={typeId}
        onChange={(e) => setTypeId(e.target.value)}
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      >
        {offered.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
      <p className="mt-1 text-[11.5px] text-ink-400">
        {superPicked
          ? 'A Super admin sees and can change everything, including other Super admins.'
          : 'Applied the moment they finish signing up. Changes to the type later reach them too.'}
      </p>

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
