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
import type { TemplateOption } from '@/lib/records/adminTemplates';
import type { ModuleOption } from '../ModuleScopePicker';
import { InviteForm } from './InviteForm';

export function InviteUserDialog({
  roles,
  templates,
  modules,
}: {
  roles: RoleOption[];
  templates: TemplateOption[];
  /** Non-admin-only modules, for the per-module picker in step two. */
  modules: ModuleOption[];
}) {
  const [open, setOpen] = useState(false);
  /*
   * Step two holds the full permission matrix, which does not fit a 440px
   * modal — the dialog grows for it and shrinks back when reopened. Without
   * this the matrix rendered inside a column narrower than one of its rows.
   */
  const [step, setStep] = useState<'form' | 'permissions'>('form');
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
          setStep('form');
          setOpen(true);
        }}
      >
        Invite a user
      </Button>

      {open ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 animate-fade-in bg-brand-950/35"
            onClick={() => setOpen(false)}
          />
          <div
            role="dialog"
            aria-modal="true"
            className={`relative w-full animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)] ${
              step === 'permissions' ? 'max-w-[1040px]' : 'max-w-[440px]'
            }`}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-brand-50 text-brand-700">
                <Icon name="users" size={16} strokeWidth={2} />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="text-[16px] font-semibold text-ink-900">Invite a user</h2>
                <p className="mt-0.5 text-[12.5px] text-ink-400">
                  {step === 'permissions'
                    ? 'Adjust anything for this person alone. The template supplies every value you do not change.'
                    : 'Creates an invite only — never an account or password. They complete signup themselves.'}
                </p>
              </div>
            </div>

            {/*
              A two-step flow has to SAY it is two steps, or the first screen
              reads as the whole thing and the second arrives as a surprise.
              Shown above the form so it frames both steps rather than
              appearing only once you are already in one.
            */}
            <ol className="mt-4 flex items-center gap-2" aria-label="Invite progress">
              {[
                { n: 1, label: 'Account' },
                { n: 2, label: 'Permissions' },
              ].map((s2, i) => {
                const active = step === 'form' ? s2.n === 1 : s2.n === 2;
                const done = step === 'permissions' && s2.n === 1;
                return (
                  <li key={s2.n} className="flex flex-1 items-center gap-2">
                    <span
                      aria-current={active ? 'step' : undefined}
                      className={`grid size-[22px] shrink-0 place-items-center rounded-full text-[11.5px] font-semibold transition-colors ${
                        done
                          ? 'bg-ok text-white'
                          : active
                            ? 'bg-brand-600 text-white'
                            : 'bg-canvas text-ink-400'
                      }`}
                    >
                      {done ? <Icon name="check" size={12} strokeWidth={3} /> : s2.n}
                    </span>
                    <span
                      className={`whitespace-nowrap text-[12.5px] ${
                        active ? 'font-semibold text-ink-900' : 'text-ink-400'
                      }`}
                    >
                      {s2.label}
                    </span>
                    {i === 0 ? (
                      <span
                        aria-hidden
                        className={`h-px flex-1 transition-colors ${done ? 'bg-ok/40' : 'bg-line'}`}
                      />
                    ) : null}
                  </li>
                );
              })}
            </ol>

            <InviteForm
              key={openCount}
              roles={roles}
              templates={templates}
              modules={modules}
              onClose={() => setOpen(false)}
              onStepChange={setStep}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
