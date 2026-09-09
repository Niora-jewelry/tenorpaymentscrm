'use client';

/**
 * "Invite a user" — same real-modal shape as `[module]/CreateRecordDialog.tsx`
 * (hand-built rather than `kit.tsx`'s generic `Dialog`, for the same reason:
 * it needs to stay open and show a server-side failure message, like a
 * duplicate email, instead of closing itself the instant Confirm is clicked).
 */
import { useEffect, useState } from 'react';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { RoleOption } from '@/lib/records/adminUsers';
import { InviteForm } from './InviteForm';

export function InviteUserDialog({ roles }: { roles: RoleOption[] }) {
  const [open, setOpen] = useState(false);
  // Bumped every time the dialog opens, so `InviteForm` remounts fresh —
  // `useActionState` inside it would otherwise keep showing the PREVIOUS
  // invite's success/error state the next time this reopens.
  const [openCount, setOpenCount] = useState(0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    if (open) document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <Button
        variant="primary"
        icon="plus"
        onClick={() => {
          setOpenCount((c) => c + 1);
          setOpen(true);
        }}
      >
        Invite a user
      </Button>

      {open ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 animate-fade-in bg-brand-950/35 backdrop-blur-[2px]"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-[440px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]"
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700">
                <Icon name="users" size={16} strokeWidth={2} />
              </span>
              <div>
                <h2 className="text-[16px] font-semibold text-ink-900">Invite a user</h2>
                <p className="mt-0.5 text-[12.5px] text-ink-400">
                  Creates an invite only — never an account or password. They complete signup themselves.
                </p>
              </div>
            </div>

            <InviteForm key={openCount} roles={roles} onClose={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </>
  );
}
