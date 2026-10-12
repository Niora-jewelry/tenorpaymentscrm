'use client';

import { useEffect, useRef, useState, useTransition, useActionState } from 'react';
import { Button, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { createTabAction, setTabModulesAction, renameTabAction, type PresetFormState } from './actions';
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
          <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={() => setOpen(false)} />
          <div
            role="dialog"
            aria-modal="true"
            className="relative w-full max-w-[440px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]"
          >
            <h2 className="text-[16px] font-semibold text-ink-900">New tab</h2>
            <p className="mt-0.5 text-[12.5px] text-ink-400">
              A tab is shared across every module — choose at least one module that should show it.
              You can change this later.
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
  /* Controlled so the requirement can be shown BEFORE the form is submitted.
     The server still enforces it - `createTabSchema` refuses an empty list -
     but a disabled button with a reason beside it beats a round trip that
     comes back saying no. */
  const [chosen, setChosen] = useState<string[]>([]);

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

      <div className="mt-3 flex items-baseline justify-between gap-2">
        <label className="block text-[12px] font-semibold uppercase tracking-wide text-ink-400">
          Show on modules
        </label>
        {/*
          Counted beside the label, because this is now a requirement rather
          than a nicety: the client's instruction is that a tab cannot be
          created with no module assigned. Saying "0 selected" while the
          button is disabled explains the disabled button.
        */}
        <span
          className={`text-[11.5px] tabular ${
            chosen.length === 0 ? 'font-medium text-[#8a5a09]' : 'text-ink-400'
          }`}
        >
          {chosen.length} selected
        </span>
      </div>
      <div className="mt-1.5 space-y-1.5 rounded-md border border-line p-2.5">
        {modules.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-700">
            <input
              type="checkbox"
              name="moduleIds"
              value={m.id}
              checked={chosen.includes(m.id)}
              onChange={() =>
                setChosen((prev) =>
                  prev.includes(m.id) ? prev.filter((x) => x !== m.id) : [...prev, m.id],
                )
              }
              className="size-3.5 accent-[#1d4ed8]"
            />
            {m.label}
          </label>
        ))}
      </div>
      {chosen.length === 0 ? (
        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">
          A tab with no module is shown to nobody, so at least one is required.
        </p>
      ) : null}

      {state.message ? (
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} />
          {state.message}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon="check" disabled={chosen.length === 0}>
          Create tab
        </Button>
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
        {/*
          "Edit" rather than "+ Assign". The old control could only ADD: a tab
          put on the wrong module stayed there, because the only way back was a
          different screen that does not look like it undoes an assignment.
          The client asked for the ability to edit these, so this opens the
          full set and writes whatever is left ticked.
        */}
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setAssigning(true)}>
          Edit modules
        </Button>
      </ActionCell>

      {assigning ? (
        <ModuleAssignmentEditor
          tab={tab}
          modules={modules}
          onClose={() => setAssigning(false)}
          onError={setAssignError}
        />
      ) : null}
    </PresetRow>
  );
}

/**
 * Which modules show this tab — add and remove in one place.
 *
 * ── WHY A MODAL AND NOT AN INLINE PICKER ─────────────────────────────────
 * The row is a fixed four-column grid; a fifth child would break it. More to
 * the point, this is a set of checkboxes that has to be confirmed rather than
 * a single choice applied on selection: unticking a module is a real change
 * and the admin must see the whole set before committing to it.
 *
 * ── REMOVING SAYS WHAT IT ACTUALLY DOES ──────────────────────────────────
 * Taking a tab off a module reads as though it might destroy what is on that
 * tab. It does not — one `module_tab_order` row goes, the tab and every value
 * entered on it are untouched, and putting it back restores the view. Stated
 * plainly at the moment of the decision, because an admin who assumes the
 * worst will simply never use the control the client asked for.
 */
function ModuleAssignmentEditor({
  tab,
  modules,
  onClose,
  onError,
}: {
  tab: AdminTabRow;
  modules: ModuleOption[];
  onClose: () => void;
  onError: (message: string | null) => void;
}) {
  const [selected, setSelected] = useState<string[]>(tab.moduleIds);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const removing = tab.moduleIds.filter((id) => !selected.includes(id));
  const adding = selected.filter((id) => !tab.moduleIds.includes(id));
  const changed = removing.length > 0 || adding.length > 0;

  const nameOf = (id: string) => modules.find((m) => m.id === id)?.label ?? 'a module';

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await setTabModulesAction(tab.id, selected);
      if (result.ok) {
        onError(null);
        onClose();
      } else {
        setError(result.message ?? 'Those modules could not be saved.');
      }
    });
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center p-4">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/35" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Modules for ${tab.label}`}
        className="relative w-full max-w-[460px] animate-dialog-in rounded-panel border border-line bg-white p-5 shadow-[0_24px_64px_-12px_rgba(8,32,47,.4)]"
      >
        <h2 className="text-[16px] font-semibold text-ink-900">
          Modules for “{tab.label}”
        </h2>
        <p className="mt-0.5 text-[12.5px] text-ink-400">
          Tick every module that should show this tab. Untick one to take it off.
        </p>

        <div className="mt-4 space-y-1 rounded-lg border border-line p-2.5">
          {modules.map((m) => {
            const on = selected.includes(m.id);
            return (
              <label
                key={m.id}
                className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 text-[13px] text-ink-700 transition-colors hover:bg-canvas"
              >
                <input
                  type="checkbox"
                  checked={on}
                  disabled={pending}
                  onChange={() => toggle(m.id)}
                  className="size-3.5 accent-[#1d4ed8]"
                />
                <span className="flex-1">{m.label}</span>
                {/* The client's "do not work on it yet" flag. Shown so nobody
                    reconfigures that module without knowing. */}
                {m.frozen ? <OutlineChip>Frozen</OutlineChip> : null}
              </label>
            );
          })}
        </div>

        {selected.length === 0 ? (
          <p className="mt-2.5 flex items-start gap-1.5 rounded-lg bg-warn-bg px-2.5 py-2 text-[12px] leading-relaxed text-[#8a5a09]">
            <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
            <span>
              With no modules ticked this tab is shown nowhere. It is not deleted, but nobody will
              see it until a module is ticked again.
            </span>
          </p>
        ) : null}

        {removing.length > 0 ? (
          <p className="mt-2.5 rounded-lg bg-canvas px-2.5 py-2 text-[12px] leading-relaxed text-ink-600">
            Taking this tab off <strong className="text-ink-900">{removing.map(nameOf).join(', ')}</strong>{' '}
            hides it there. Nothing entered on it is deleted — tick the module again and it all comes
            back.
          </p>
        ) : null}

        {error ? (
          <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-[12.5px] text-danger">
            <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
            {error}
          </p>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            icon="check"
            disabled={pending || !changed}
            onClick={save}
          >
            {pending ? 'Saving…' : 'Save modules'}
          </Button>
        </div>
      </div>
    </div>
  );
}
