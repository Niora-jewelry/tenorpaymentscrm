'use client';

/**
 * The permission-template list, with create and rename.
 *
 * Two things on this screen are statements rather than decoration, and both
 * exist because the alternative is an admin being quietly misled:
 *
 *   - **The banner.** A template's grants cannot be edited yet, so every
 *     template here has none, and `effective_grant()` falls through to *Edit*
 *     for every scope. Creating "Read only" and assigning it restricts
 *     nothing. Saying that plainly is the same posture the Integrations screen
 *     took ("reads only — nothing writes") and the reason neither offers a
 *     control that does nothing.
 *   - **The per-row "Grants nothing yet" chip.** Once 6c ships, a template
 *     with zero grants stops being the normal case and becomes a real, visible
 *     state worth noticing — the chip already reads correctly for it, and
 *     turns into a grant count the moment there is one.
 *
 * The dialog and inline-edit patterns are the ones `TabsSection`/
 * `PipelinesSection` established, deliberately unchanged: same shell, same
 * `useActionState` form, same single error line.
 */
import { useEffect, useRef, useState, useTransition, useActionState } from 'react';
import Link from 'next/link';
import { Button, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { formatDate } from '@/proto/ui/tokens';
import { PlaceholderNotice } from '../PlaceholderNotice';
import { createTemplateAction, renameTemplateAction, type TemplateFormState } from './actions';
import type { AdminTemplateRow } from '@/lib/records/adminTemplates';

export function TemplatesSection({ templates }: { templates: AdminTemplateRow[] }) {
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);

  return (
    <div className="space-y-4">
      <PlaceholderNotice title="A template's grants can be read, not yet changed">
        <p>
          <strong>Permissions</strong> on any row opens the full matrix — every module, tab and field,
          with what the template grants and what it resolves to. Choosing those values is the next piece
          of work; until it ships, a template created here holds an empty set.
        </p>
        <p>
          An empty set is not a locked-down one. A scope with no entry resolves to <strong>Edit</strong>,
          so attaching one of these templates to a user changes nothing about what they can see or change.
        </p>
      </PlaceholderNotice>

      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
        <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink-900">
            Templates <span className="ml-1 font-normal text-ink-400">({templates.length})</span>
          </h2>
          <Button
            size="sm"
            variant="primary"
            icon="plus"
            onClick={() => {
              setOpenCount((c) => c + 1);
              setOpen(true);
            }}
          >
            New template
          </Button>
        </div>

        <div className="divide-y divide-line-faint">
          {templates.map((t) => (
            <TemplateRow key={t.id} template={t} />
          ))}
          {templates.length === 0 ? (
            <p className="px-4 py-6 text-[13px] text-ink-400">
              No templates yet. Users with none resolve every permission to Edit, which is this build&rsquo;s
              default for anything not listed.
            </p>
          ) : null}
        </div>

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
              <h2 className="text-[16px] font-semibold text-ink-900">New template</h2>
              <p className="mt-0.5 text-[12.5px] text-ink-400">
                Name it for the role it describes — the label is what identifies it when assigning a user.
              </p>
              <CreateTemplateForm key={openCount} onClose={() => setOpen(false)} />
            </div>
          </div>
        ) : null}
      </section>
    </div>
  );
}

const initial: TemplateFormState = { ok: false };

function CreateTemplateForm({ onClose }: { onClose: () => void }) {
  const [state, action] = useActionState(createTemplateAction, initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (state.ok) {
    return (
      <div className="mt-4">
        <p className="flex items-center gap-1.5 text-[13px] text-ok">
          <Icon name="check" size={14} strokeWidth={2.5} />
          Template created.
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
      <label className="block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Label</label>
      <input
        ref={inputRef}
        name="label"
        required
        placeholder="e.g. Sales rep"
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      />
      <p className="mt-1 text-[11.5px] text-ink-400">Must be unique — two templates cannot share a name.</p>

      {state.message ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {state.message}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" icon="check">
          Create template
        </Button>
      </div>
    </form>
  );
}

function TemplateRow({ template }: { template: AdminTemplateRow }) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(template.label);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    const next = label.trim();
    if (!next || next === template.label) {
      setEditing(false);
      setLabel(template.label);
      return;
    }
    startTransition(async () => {
      const result = await renameTemplateAction(template.id, next);
      if (result.ok) {
        setEditing(false);
        setMessage(null);
      } else {
        // Stay in edit mode with the typed value intact — the two failures a
        // rename can hit (a duplicate label, a template removed elsewhere) are
        // both corrected by editing what is already in the box.
        setMessage(result.message ?? 'That rename did not save.');
      }
    });
  };

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <input
              autoFocus
              value={label}
              disabled={pending}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
                if (e.key === 'Escape') {
                  setEditing(false);
                  setLabel(template.label);
                  setMessage(null);
                }
              }}
              className="w-full max-w-[280px] rounded-md border border-line px-2 py-1 text-[13.5px] outline-none focus-field"
            />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink-900">{template.label}</span>
              {template.grantCount === 0 ? (
                <OutlineChip tone="warn">Grants nothing yet</OutlineChip>
              ) : (
                <OutlineChip tone="brand">
                  {template.grantCount} grant{template.grantCount === 1 ? '' : 's'}
                </OutlineChip>
              )}
              <OutlineChip>
                {template.attachedUsers} user{template.attachedUsers === 1 ? '' : 's'}
              </OutlineChip>
            </div>
          )}
          <p className="mt-1 text-[11.5px] text-ink-400">Created {formatDate(template.createdAt)}</p>
        </div>

        {editing ? (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => {
                setEditing(false);
                setLabel(template.label);
                setMessage(null);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="primary" icon="check" disabled={pending} onClick={save}>
              Save
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 gap-2">
            <Button size="sm" variant="ghost" icon="pencil" onClick={() => setEditing(true)}>
              Rename
            </Button>
            {/* Phase 6b — the grants themselves, read-only. The chip above says
                how many there are; this is where you see which. */}
            <Link
              href={`/admin/templates/${template.id}`}
              className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1 text-[12.5px] font-medium text-ink-600 transition-colors hover:border-brand-600 hover:bg-brand-50 hover:text-brand-700"
            >
              <Icon name="key" size={12} />
              Permissions
            </Link>
          </div>
        )}
      </div>

      {message ? (
        <p className="mt-1.5 flex items-center gap-1.5 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {message}
        </p>
      ) : null}
    </div>
  );
}
