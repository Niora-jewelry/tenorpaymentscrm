'use client';

/**
 * The way back. Deliberately the only control on the banner.
 *
 * `useTransition` rather than a bare form so the button can say what it is
 * doing — restoring a session is a round trip and a silent button invites a
 * second click, which would try to restore an already-cleared stash.
 */
import { useTransition } from 'react';
import { stopImpersonationAction } from './admin/users/impersonateActions';

export function StopImpersonating() {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(async () => { await stopImpersonationAction(); })}
      className="rounded-lg bg-white/95 px-3 py-1 text-[12.5px] font-semibold text-warn transition-colors hover:bg-white disabled:opacity-70"
    >
      {pending ? 'Returning…' : 'Return to my account'}
    </button>
  );
}
