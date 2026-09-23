'use client';

/**
 * Everything you can do to one user, behind one control.
 *
 * ── WHY A MENU AND NOT FOUR BUTTONS ──────────────────────────────────────
 * The row previously carried "Sign in as", Pause, Remove AND a template
 * select, all competing for the same inches. At any realistic window width
 * that is more than the column can hold, so the buttons wrapped, rows grew to
 * different heights, and the table had to scroll sideways to exist at all.
 *
 * Collapsing them is the standard answer — "when actions exceed available
 * space, use an overflow menu instead of cramming" — and it is what lets the
 * table fit without a horizontal scrollbar.
 *
 * ── THE TEMPLATE CONTROL LIVES HERE TOO, AND KEEPS ITS TEETH ─────────────
 * Assigning a template DELETES every personal override that person has, which
 * is why it stages a choice and asks before writing rather than acting on
 * selection. All of that behaviour is unchanged; it has simply moved somewhere
 * it has room to explain itself, instead of being a 90px select wedged beside
 * a badge.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import type { AdminUserRow } from '@/lib/records/adminUsers';
import type { TemplateOption } from '@/lib/records/adminTemplates';

export function UserRowMenu({
  user,
  templates,
  busy,
  stagedId,
  notice,
  noTemplateValue,
  onStage,
  onApply,
  onCancelStage,
  onImpersonate,
  onPause,
  onResume,
  onRemove,
}: {
  user: AdminUserRow;
  templates: TemplateOption[];
  busy: boolean;
  /** `undefined` = nothing staged. Distinct from `''`, the select placeholder. */
  stagedId: string | undefined;
  notice: string | null;
  noTemplateValue: string;
  onStage: (value: string | null) => void;
  onApply: (staged: string, confirm: boolean) => void;
  onCancelStage: () => void;
  onImpersonate: () => void;
  onPause: () => void;
  onResume: () => void;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  /*
   * A staged template or a server refusal must not be hidden behind a closed
   * menu -- the admin has to see the warning they are being asked to confirm.
   * DERIVED rather than forced open in an effect: setting state from an effect
   * triggers a cascading render, and this says the same thing without one.
   */
  const shown = open || stagedId !== undefined || Boolean(notice);


  // Click-away and Escape. Without both, a menu left open under another row's
  // menu is a stack of overlapping panels.
  useEffect(() => {
    if (!shown) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [shown]);

  const item =
    'flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] text-ink-700 transition-colors hover:bg-canvas disabled:opacity-50';

  return (
    <div ref={wrapRef} className="relative inline-block text-left">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={shown}
        aria-label={`Actions for ${user.email}`}
        disabled={busy}
        onClick={() => setOpen((o) => !o)}
        className="grid size-8 place-items-center rounded-lg border border-transparent text-ink-400 transition-colors hover:border-line hover:bg-canvas hover:text-ink-900 disabled:opacity-50"
      >
        {busy ? <Icon name="clock" size={14} /> : <Icon name="sliders" size={15} />}
      </button>

      {shown ? (
        <div
          role="menu"
          className="absolute right-0 z-30 mt-1 w-[280px] rounded-xl border border-line bg-white p-1.5 shadow-[0_16px_40px_-12px_rgba(8,32,47,.32)]"
        >
          {!user.isAdmin && user.status === 'active' ? (
            <button type="button" role="menuitem" className={item} disabled={busy} onClick={onImpersonate}>
              <Icon name="eye" size={14} className="text-ink-400" />
              Sign in as this user
            </button>
          ) : null}

          <div className="my-1 border-t border-line-faint" />

          <div className="px-2.5 pb-1 pt-1.5">
            <p className="text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
              Permission template
            </p>
            <select
              aria-label={`Assign template to ${user.email}`}
              disabled={busy}
              value={stagedId ?? ''}
              onChange={(e) => onStage(e.target.value || null)}
              className="mt-1.5 w-full rounded-md border border-line bg-white px-2 py-1.5 text-[12.5px] text-ink-700 outline-none focus-field"
            >
              <option value="">Assign template…</option>
              {/* Detaching is a real choice and needs its own value, because
                  '' already means "nothing staged". */}
              <option value={noTemplateValue}>No template</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>

            {notice ? (
              <p className="mt-1.5 flex items-start gap-1.5 rounded-md bg-warn-bg px-2 py-1.5 text-[11.5px] leading-relaxed text-[#8a5a09]">
                <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
                <span>{notice}</span>
              </p>
            ) : null}

            {stagedId !== undefined ? (
              <div className="mt-1.5 flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onApply(stagedId, Boolean(notice))}
                  className="rounded-md bg-brand-600 px-2.5 py-1 text-[12px] font-semibold text-white transition-colors hover:bg-brand-700 disabled:opacity-60"
                >
                  {notice ? 'Confirm' : 'Apply'}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancelStage}
                  className="rounded-md px-2 py-1 text-[12px] font-medium text-ink-500 transition-colors hover:bg-canvas"
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </div>

          <div className="my-1 border-t border-line-faint" />

          {user.status === 'active' ? (
            <button type="button" role="menuitem" className={item} disabled={busy} onClick={onPause}>
              <Icon name="lock" size={14} className="text-ink-400" />
              Pause access
            </button>
          ) : (
            <button type="button" role="menuitem" className={item} disabled={busy} onClick={onResume}>
              <Icon name="check" size={14} className="text-ink-400" />
              Resume access
            </button>
          )}

          {/* Destructive actions sit apart from the rest, deliberately. */}
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              onRemove();
            }}
            className={`${item} text-danger hover:bg-danger-bg`}
          >
            <Icon name="trash" size={14} />
            Remove from the CRM
          </button>
        </div>
      ) : null}
    </div>
  );
}
