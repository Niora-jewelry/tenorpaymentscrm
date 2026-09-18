'use client';

import { useEffect, useRef, useState, useTransition, useActionState } from 'react';
import { Button, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import {
  createSubtabAction, assignSubtabToModulesAction, renameSubtabAction, type PresetFormState,
} from './actions';
import { ActionCell, ChipCell, ListHeader, NameCell, PresetRow, TAB_GRID } from './PresetRow';
import type { AdminSubtabRow, AdminTabRow, ModuleOption } from '@/lib/records/adminPresets';

export function SubtabsSection({
  subtabs,
  tabs,
  modules,
}: {
  subtabs: AdminSubtabRow[];
  tabs: AdminTabRow[];
  modules: ModuleOption[];
}) {
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);
  const tabById = new Map(tabs.map((t) => [t.id, t]));

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">
          Subtabs <span className="ml-1 font-normal text-ink-400">({subtabs.length})</span>
        </h2>
        <Button
          size="sm"
          variant="primary"
          icon="plus"
          disabled={tabs.length === 0}
          title={tabs.length === 0 ? 'Create a tab first' : undefined}
          onClick={() => {
            setOpenCount((c) => c + 1);
            setOpen(true);
          }}
        >
          New subtab
        </Button>
      </div>

      {subtabs.length > 0 ? (
        <ListHeader grid={TAB_GRID} columns={['Subtab', 'Inside tab', 'Shown on modules', '']} />
      ) : null}

      <div>
        {subtabs.map((s, i) => (
          <SubtabRow
            key={s.id}
            subtab={s}
            index={i}
            tabLabel={tabById.get(s.tabId)?.label ?? '(unknown tab)'}
            modules={modules}
          />
        ))}
        {subtabs.length === 0 ? <p className="px-4 py-6 text-[13px] text-ink-400">No subtabs yet.</p> : null}
      </div>

      {open ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <div className="absolute inset-0 animate-fade-in bg-brand-950/35 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-[440px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]"
          >
            <h2 className="text-[16px] font-semibold text-ink-900">New subtab</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-400">Belongs to one tab. Shown on whichever modules that tab appears in.</p>
            <CreateSubtabForm key={openCount} tabs={tabs} modules={modules} onClose={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

const initial: PresetFormState = { ok: false };

function CreateSubtabForm({
  tabs,
  modules,
  onClose,
}: {
  tabs: AdminTabRow[];
  modules: ModuleOption[];
  onClose: () => void;
}) {
  const [state, action] = useActionState(createSubtabAction, initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (state.ok) {
    return (
      <div className="mt-4">
        <p className="flex items-center gap-1.5 text-[13px] text-ok">
          <Icon name="check" size={14} strokeWidth={2.5} />
          Subtab created.
        </p>
        <div className="mt-5 flex justify-end">
          <Button type="button" variant="primary" onClick={onClose}>Done</Button>
        </div>
      </div>
    );
  }

  return (
    <form action={action} className="mt-4">
      <label className="block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Tab</label>
      <select
        name="tabId"
        required
        defaultValue={tabs[0]?.id ?? ''}
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      >
        {tabs.map((t) => (
          <option key={t.id} value={t.id}>{t.label}</option>
        ))}
      </select>

      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Label</label>
      <input
        ref={inputRef}
        name="label"
        required
        placeholder="e.g. Processor-TD Merchant Pricing"
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      />

      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Key</label>
      <input
        name="key"
        required
        placeholder="e.g. td_merchant"
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      />

      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
        Description <span className="font-normal normal-case text-ink-400">(optional)</span>
      </label>
      <textarea
        name="description"
        rows={2}
        placeholder="Shown at the top of this subtab, like Pricing's explanatory text."
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      />

      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Show on modules</label>
      <div className="mt-1.5 space-y-1.5 rounded-md border border-line p-2.5">
        {modules.map((m) => (
          <label key={m.id} className="flex items-center gap-2 text-[13px] text-ink-700">
            <input type="checkbox" name="moduleIds" value={m.id} className="size-3.5 accent-[#1d4ed8]" />
            {m.label}
          </label>
        ))}
      </div>
      <p className="mt-1 text-[11.5px] text-ink-400">Only shows up on a module where its parent tab is also assigned.</p>

      {state.message ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {state.message}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon="check">Create subtab</Button>
      </div>
    </form>
  );
}

function SubtabRow({
  subtab,
  index,
  tabLabel,
  modules,
}: {
  subtab: AdminSubtabRow;
  index: number;
  tabLabel: string;
  modules: ModuleOption[];
}) {
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftLabel, setDraftLabel] = useState(subtab.label);
  const [draftDescription, setDraftDescription] = useState(subtab.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const unassigned = modules.filter((m) => !subtab.moduleIds.includes(m.id));

  /*
   * Rename and re-describe — Admin §3.2, and unreachable until now.
   *
   * `renameSubtab` and its action have existed since sub-step 2 and nothing
   * called either: this section was create-and-assign only, so a subtab's label
   * was permanent from the moment it was typed. The DESCRIPTION matters just as
   * much and for a more specific reason — it is the client's own explanatory
   * blurb rendered at the top of a Pricing subtab (19 Aug), written by him, and
   * therefore the sentence most likely to need a correction.
   *
   * The KEY stays read-only. It is what `fields.subtab_id`, every subtab grant
   * (migration 50) and every saved per-user field order point at.
   *
   * Both fields save together in one write, so a description edit cannot land
   * without its label or leave the two briefly disagreeing.
   */
  const save = () => {
    const label = draftLabel.trim();
    const description = draftDescription.trim();
    if (!label) {
      setDraftLabel(subtab.label);
      setDraftDescription(subtab.description ?? '');
      setRenaming(false);
      return;
    }
    if (label === subtab.label && description === (subtab.description ?? '')) {
      setRenaming(false);
      return;
    }
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set('subtabId', subtab.id);
      form.set('label', label);
      form.set('description', description);
      const result = await renameSubtabAction({ ok: false }, form);
      if (result.ok) setRenaming(false);
      else {
        setError(result.message ?? 'Could not rename this subtab.');
        setDraftLabel(subtab.label);
        setDraftDescription(subtab.description ?? '');
      }
    });
  };

  const cancel = () => {
    setDraftLabel(subtab.label);
    setDraftDescription(subtab.description ?? '');
    setError(null);
    setRenaming(false);
  };

  return (
    <PresetRow grid={TAB_GRID} index={index}>
      {renaming ? (
        <div className="min-w-0 space-y-1.5">
          <input
            autoFocus
            aria-label="Subtab name"
            value={draftLabel}
            disabled={pending}
            onChange={(e) => setDraftLabel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); save(); }
              if (e.key === 'Escape') cancel();
            }}
            className="w-full rounded border border-line px-2 py-1 text-[13.5px] outline-none field-editing"
          />
          {/* A textarea, not an input: this is the paragraph a user reads at the
              top of the subtab, and a single-line box invites a single line. */}
          <textarea
            aria-label="Subtab description"
            value={draftDescription}
            disabled={pending}
            rows={2}
            placeholder="Description shown at the top of this subtab (optional)"
            onChange={(e) => setDraftDescription(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancel();
            }}
            className="w-full resize-y rounded border border-line px-2 py-1 text-[12px] outline-none focus-field"
          />
          <div className="flex items-center gap-2">
            <Button size="sm" variant="primary" icon="check" disabled={pending} onClick={save}>
              {pending ? 'Saving…' : 'Save'}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={cancel}>
              Cancel
            </Button>
            <span className="truncate text-[11.5px] text-ink-400">
              {error ?? `${subtab.key} — the key cannot change`}
            </span>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setRenaming(true)}
          title="Rename this subtab or change its description"
          className="min-w-0 rounded text-left transition-colors hover:text-brand-700"
        >
          <NameCell label={subtab.label} itemKey={subtab.key}>
            {subtab.description ? (
              <p className="mt-0.5 text-[12px] italic text-ink-500">{subtab.description}</p>
            ) : (
              <p className="mt-0.5 text-[12px] italic text-ink-300">No description</p>
            )}
          </NameCell>
        </button>
      )}

      <ChipCell>
        <OutlineChip tone="brand">{tabLabel}</OutlineChip>
      </ChipCell>

      <ChipCell>
        {subtab.moduleIds.length === 0 ? (
          <span className="text-[11.5px] text-ink-300">Not on any module yet</span>
        ) : (
          subtab.moduleIds.map((id) => {
            const m = modules.find((mm) => mm.id === id);
            return m ? <OutlineChip key={id}>{m.label}</OutlineChip> : null;
          })
        )}
      </ChipCell>

      <ActionCell>
        {assignError ? (
          <p role="alert" className="mb-1 text-[11px] text-danger">
            {assignError}
          </p>
        ) : null}
        {unassigned.length > 0 ? (
          assigning ? (
            <select
              autoFocus
              disabled={pending}
              onBlur={() => setAssigning(false)}
              onChange={(e) => {
                const moduleId = e.target.value;
                if (!moduleId) return;
                startTransition(async () => {
                  /* Returns void and throws on refusal — unguarded, the picker
                     just closed and the subtab was never added to the module,
                     with nothing said. */
                  try {
                    setAssignError(null);
                    await assignSubtabToModulesAction(subtab.id, [moduleId]);
                    setAssigning(false);
                  } catch (err) {
                    setAssignError(
                      err instanceof Error ? err.message : 'Could not add it to that module.',
                    );
                  }
                });
              }}
              className="w-full rounded border border-line px-2 py-1 text-[12.5px] outline-none focus-field"
            >
              <option value="">Add to module…</option>
              {unassigned.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          ) : (
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAssigning(true)}>
              + Assign
            </Button>
          )
        ) : null}
      </ActionCell>
    </PresetRow>
  );
}
