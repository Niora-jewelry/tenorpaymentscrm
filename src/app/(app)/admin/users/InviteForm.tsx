'use client';

import { useActionState, useEffect, useRef } from 'react';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { inviteUserAction, type InviteState } from './actions';
import type { RoleOption } from '@/lib/records/adminUsers';

const initial: InviteState = { ok: false };

/** Split out of `InviteUserDialog.tsx` so the parent can remount it (via a
 * `key`) fresh on every open — this component's own `useActionState`
 * naturally resets to `initial` on remount, without needing an effect that
 * sets state in response to state (`react-hooks/set-state-in-effect`). */
export function InviteForm({ roles, onClose }: { roles: RoleOption[]; onClose: () => void }) {
  // `isPending` — the third element, previously discarded. Sending an invite
  // writes a row and, once a mailer is configured, sends an email; on the live
  // remote database that is a visible wait during which this dialog gave no
  // sign at all, and the obvious response to a button that looks inert is to
  // press it again.
  const [state, action, isPending] = useActionState(inviteUserAction, initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (state.ok) {
    return (
      <div className="mt-4">
        <p className="flex items-center gap-1.5 text-[13px] text-ok">
          <Icon name="check" size={14} strokeWidth={2.5} />
          Invite sent.
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
        disabled={isPending}
        placeholder="name@company.com"
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-underline"
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
        defaultValue={roles.find((r) => !r.isAdmin)?.id ?? ''}
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-underline"
      >
        {roles.map((r) => (
          <option key={r.id} value={r.id}>{r.name}</option>
        ))}
      </select>

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
