'use client';

import { useEffect, useRef, useState, useTransition, useActionState } from 'react';
import { Button, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { createTabAction, assignTabToModulesAction, renameTabAction, type PresetFormState } from './actions';
import { ActionCell, ChipCell, ListHeader, NameCell, PresetRow, TAB_GRID } from './PresetRow';
import type { AdminTabRow, ModuleOption } from '@/lib/records/adminPresets';

export function TabsSection({ tabs, modules }: { tabs: AdminTabRow[]; modules: ModuleOption[] }) {
  const [open, setOpen] = useState(false);
  const [openCount, setOpenCount] = useState(0);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">
          Tabs <span className="ml-1 font-normal text-ink-400">({tabs.length})</span>
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
          New tab
        </Button>
      </div>

      {tabs.length > 0 ? <ListHeader grid={TAB_GRID} columns={['Tab', 'Kind', 'Shown on modules', '']} /> : null}

      <div>
        {tabs.map((t, i) => (
          <TabRow key={t.id} tab={t} index={i} modules={modules} />
        ))}
        {tabs.length === 0 ? <p className="px-4 py-6 text-[13px] text-ink-400">No tabs yet.</p> : null}
      </div>

      {open ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
          <div className="absolute inset-0 animate-fade-in bg-brand-950/35 backdrop-blur-[2px]" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-[440px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]"
          >
            <h2 className="text-[16px] font-semibold text-ink-900">New tab</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-400">
              A tab is shared across every module — pick which modules show it now, or leave it unassigned and add it later.
            </p>
            <CreateTabForm key={openCount} modules={modules} onClose={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

const initial: PresetFormState = { ok: false };

function CreateTabForm({ modules, onClose }: { modules: ModuleOption[]; onClose: () => void }) {
  const [state, action] = useActionState(createTabAction, initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (state.ok) {
    return (
      <div className="mt-4">
        <p className="flex items-center gap-1.5 text-[13px] text-ok">
          <Icon name="check" size={14} strokeWidth={2.5} />
          Tab created.
        </p>
        <div className="mt-5 flex justify-end">
          <Button type="button" variant="primary" onClick={onClose}>Done</Button>
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
        placeholder="e.g. Compliance"
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      />

      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Key</label>
      <input
        name="key"
        required
        placeholder="e.g. compliance"
        className="mt-1 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none focus-field"
      />
      <p className="mt-1 text-[11.5px] text-ink-400">Lowercase, no spaces — used internally, never shown.</p>

      <label className="mt-3 block text-[12px] font-semibold uppercase tracking-wide text-ink-400">Show on modules</label>
      <div className="mt-1.5 space-y-1.5 rounded-md border border-line p-2.5">
        {modules.map((m) => (
          <label key={m.id} className="flex items-center gap-2 text-[13px] text-ink-700">
            <input type="checkbox" name="moduleIds" value={m.id} className="size-3.5 accent-[#1d4ed8]" />
            {m.label}
          </label>
        ))}
      </div>

      {state.message ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {state.message}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon="check">Create tab</Button>
      </div>
    </form>
  );
}

function TabRow({ tab, index, modules }: { tab: AdminTabRow; index: number; modules: ModuleOption[] }) {
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(tab.label);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const unassigned = modules.filter((m) => !tab.moduleIds.includes(m.id));

  /*
   * Rename was impossible until now — this section was additive-only, so a
   * typo in a tab label was permanent, and that label is what every user reads
   * on every record in every module. There is no second place a tab's name
   * appears, so there was no workaround either.
   *
   * The KEY stays read-only: it is what `fields.tab_id`, `module_tab_order`,
   * every grant row and every saved per-user field order point at.
   */
  const save = () => {
    const next = draft.trim();
    if (!next || next === tab.label) { setRenaming(false); setDraft(tab.label); return; }
    setError(null);
    startTransition(async () => {
      const form = new FormData();
      form.set('tabId', tab.id);
      form.set('label', next);
      const result = await renameTabAction({ ok: false }, form);
      if (result.ok) setRenaming(false);
      else { setError(result.message ?? 'Could not rename this tab.'); setDraft(tab.label); }
    });
  };

  return (
    <PresetRow grid={TAB_GRID} index={index}>
      {renaming && !tab.isSystem ? (
        <div className="min-w-0">
          <input
            autoFocus
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); save(); }
              if (e.key === 'Escape') { setDraft(tab.label); setRenaming(false); }
            }}
            className="w-full rounded border border-line px-2 py-1 text-[13.5px] outline-none field-editing"
          />
          <p className="mt-0.5 truncate text-[11.5px] text-ink-400">
            {error ?? (pending ? 'Saving…' : `${tab.key} — the key cannot change`)}
          </p>
        </div>
      ) : (
        /* A system tab is orderable but not renamable (Admin Module Plan
           §3.1), so it is plain text with no affordance rather than a control
           that opens and then refuses. */
        tab.isSystem ? (
          <NameCell label={tab.label} itemKey={tab.key} />
        ) : (
          <button
            type="button"
            onClick={() => setRenaming(true)}
            title="Rename this tab"
            className="min-w-0 rounded text-left transition-colors hover:text-brand-700"
          >
            <NameCell label={tab.label} itemKey={tab.key} />
          </button>
        )
      )}

      <ChipCell>
        {tab.isSystem ? <OutlineChip>System</OutlineChip> : <OutlineChip tone="brand">Custom</OutlineChip>}
      </ChipCell>

      <ChipCell>
        {tab.moduleIds.length === 0 ? (
          <span className="text-[11.5px] text-ink-300">Not on any module yet</span>
        ) : (
          tab.moduleIds.map((id) => {
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
                     just closed and the tab was never added to the module,
                     with nothing said. */
                  try {
                    setAssignError(null);
                    await assignTabToModulesAction(tab.id, [moduleId]);
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
