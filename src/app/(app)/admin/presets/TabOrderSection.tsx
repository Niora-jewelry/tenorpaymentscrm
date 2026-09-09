'use client';

/**
 * Per-module tab order — the last of the client's six per-module settings that
 * an admin could not change.
 *
 * §1 of the specification lists exactly six things that vary per module:
 * column selection, column order, tab order, subtab order, header-strip
 * membership, and the status choice list. Five of them had admin screens.
 * Tab order had none: the only writer that ever touched `module_tab_order` was
 * `appendToModuleOrder`, which appends, so the seeded order was permanent and
 * changing it needed a developer and a migration.
 *
 * ── WHY MOVE BUTTONS AND NOT DRAG ────────────────────────────────────────
 * `ColumnsSection` has both, and its own comment explains why: drag alone is
 * unreachable by keyboard. This list is short (13 tabs at most) and is edited
 * rarely, so it ships with the reachable half only rather than a second
 * dnd-kit surface to maintain. The move buttons ARE the interface here, not a
 * fallback behind one.
 *
 * ── WHY A DRAFT, AND ONE EXPLICIT SAVE ───────────────────────────────────
 * Reordering is a replace-the-whole-list write. Saving on every click would be
 * one round trip per nudge, and a half-finished order briefly live for every
 * user of that module. The draft is local until Save, and the dirty marker
 * says so.
 *
 * ── SUBTAB ORDER LIVES HERE TOO, AND IS SCOPED BY TAB ────────────────────
 * It is the FOURTH of the six per-module settings and was in exactly the state
 * this one was: `setModuleSubtabOrder` shipped with sub-step 2 and no screen
 * ever called it, so the seeded order of Pricing's nine subtabs was permanent.
 *
 * Scoped module + TAB, not module alone. `module_subtab_order` rows carry only
 * (moduleId, subtabId), and a module has many tabs each with their own subtabs,
 * so grouping by module alone puts every subtab in the module into one list —
 * a bug `config.ts`'s `subtabsForModule` already carries a comment about having
 * had. The writer is scoped the same way: it deletes only the ids it is given,
 * so saving one tab's order cannot wipe another's.
 */
import { useState, useTransition } from 'react';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { setModuleTabOrderAction, setModuleSubtabOrderAction } from './actions';
import type { AdminSubtabRow, AdminTabRow, ModuleOption } from '@/lib/records/adminPresets';

export function TabOrderSection({
  tabs,
  subtabs,
  modules,
  order,
  subtabOrder,
}: {
  tabs: AdminTabRow[];
  subtabs: AdminSubtabRow[];
  modules: ModuleOption[];
  /** moduleId → tab ids, already in position order. */
  order: Record<string, string[]>;
  /** `moduleId:tabId` → subtab ids, already in position order. */
  subtabOrder: Record<string, string[]>;
}) {
  const [moduleId, setModuleId] = useState(modules[0]?.id ?? '');
  const [drafts, setDrafts] = useState<Record<string, string[]>>(order);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const tabById = new Map(tabs.map((t) => [t.id, t]));
  const current = drafts[moduleId] ?? [];
  const dirty = JSON.stringify(current) !== JSON.stringify(order[moduleId] ?? []);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= current.length) return;
    const next = [...current];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    setDrafts((d) => ({ ...d, [moduleId]: next }));
    setSaved(null);
  };

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await setModuleTabOrderAction(moduleId, current);
      if (result.ok) setSaved(moduleId);
      else setError(result.message ?? 'Could not save this order.');
    });
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">
          Tab order <span className="ml-1 font-normal text-ink-400">per module</span>
        </h2>
        <select
          value={moduleId}
          disabled={pending}
          onChange={(e) => { setModuleId(e.target.value); setSaved(null); setError(null); }}
          className="rounded-md border border-line px-2.5 py-1.5 text-[13px] outline-none focus-field"
        >
          {modules.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </div>

      <div className="divide-y divide-line-faint">
        {current.map((tabId, i) => {
          const t = tabById.get(tabId);
          if (!t) return null;
          return (
            <div key={tabId} className="flex items-center gap-3 px-4 py-2">
              <span className="w-5 shrink-0 text-[11.5px] tabular text-ink-300">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-900">{t.label}</span>
              <span className="shrink-0 text-[11.5px] text-ink-400">{t.key}</span>
              <span className="flex shrink-0 gap-0.5">
                <button
                  type="button"
                  disabled={i === 0 || pending}
                  onClick={() => move(i, i - 1)}
                  aria-label={`Move ${t.label} earlier`}
                  className="grid size-6 place-items-center rounded text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900 disabled:opacity-25"
                >
                  <Icon name="chevron-up" size={13} />
                </button>
                <button
                  type="button"
                  disabled={i === current.length - 1 || pending}
                  onClick={() => move(i, i + 1)}
                  aria-label={`Move ${t.label} later`}
                  className="grid size-6 place-items-center rounded text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900 disabled:opacity-25"
                >
                  <Icon name="chevron-down" size={13} />
                </button>
              </span>
            </div>
          );
        })}
        {current.length === 0 ? (
          <p className="px-4 py-4 text-[12.5px] text-ink-400">This module has no tabs assigned yet.</p>
        ) : null}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2.5">
        <p className="text-[12px] text-ink-400">
          {error ? (
            <span className="flex items-center gap-1.5 text-[#b02a30]">
              <Icon name="alert-triangle" size={12} />
              {error}
            </span>
          ) : dirty ? (
            'Unsaved changes'
          ) : saved === moduleId ? (
            <span className="flex items-center gap-1.5 text-ok">
              <Icon name="check" size={12} />
              Saved — every user of this module sees the new order on their next page load.
            </span>
          ) : (
            'The order this module shows its drawer tabs in.'
          )}
        </p>
        <Button
          size="sm"
          variant="primary"
          icon="check"
          disabled={!dirty}
          loading={pending}
          loadingLabel="Saving…"
          onClick={save}
        >
          Save order
        </Button>
      </div>

      <SubtabOrder
        subtabs={subtabs}
        tabs={tabs}
        moduleId={moduleId}
        tabIds={current}
        order={subtabOrder}
      />
    </section>
  );
}

/**
 * The subtab half, under the tab list and sharing its module selector — the two
 * are one decision ("what does this module's drawer look like"), and splitting
 * them across two screens would mean choosing the module twice.
 *
 * Only tabs that actually HAVE subtabs on this module are offered. A tab with
 * none has no order to set, and listing it would be a selector leading to an
 * empty list.
 */
function SubtabOrder({
  subtabs,
  tabs,
  moduleId,
  tabIds,
  order,
}: {
  subtabs: AdminSubtabRow[];
  tabs: AdminTabRow[];
  moduleId: string;
  /** This module's tabs, in the order the panel above currently shows. */
  tabIds: string[];
  order: Record<string, string[]>;
}) {
  const [tabId, setTabId] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string[]>>(order);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const subtabById = new Map(subtabs.map((s) => [s.id, s]));
  const tabById = new Map(tabs.map((t) => [t.id, t]));

  const tabsWithSubtabs = tabIds.filter((id) => (order[`${moduleId}:${id}`] ?? []).length > 0);
  // The chosen tab is only valid within the chosen module, and the module can
  // change under this component. Falling back to the first available one keeps
  // the two selectors in agreement without an effect that resets state.
  const activeTabId = tabsWithSubtabs.includes(tabId) ? tabId : (tabsWithSubtabs[0] ?? '');
  const key = `${moduleId}:${activeTabId}`;
  const current = drafts[key] ?? order[key] ?? [];
  const dirty = JSON.stringify(current) !== JSON.stringify(order[key] ?? []);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= current.length) return;
    const next = [...current];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    setDrafts((d) => ({ ...d, [key]: next }));
    setSaved(null);
  };

  const save = () => {
    setError(null);
    startTransition(async () => {
      const result = await setModuleSubtabOrderAction(moduleId, current);
      if (result.ok) setSaved(key);
      else setError(result.message ?? 'Could not save this order.');
    });
  };

  if (tabsWithSubtabs.length === 0) {
    return (
      <div className="border-t border-line px-4 py-3">
        <h3 className="text-[13px] font-semibold text-ink-900">Subtab order</h3>
        <p className="mt-1 text-[12.5px] text-ink-400">
          None of this module&rsquo;s tabs has subtabs assigned to it.
        </p>
      </div>
    );
  }

  return (
    <div className="border-t border-line">
      <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
        <h3 className="text-[13px] font-semibold text-ink-900">
          Subtab order <span className="ml-1 font-normal text-ink-400">within a tab</span>
        </h3>
        <select
          aria-label="Tab whose subtabs to reorder"
          value={activeTabId}
          disabled={pending}
          onChange={(e) => { setTabId(e.target.value); setSaved(null); setError(null); }}
          className="rounded-md border border-line px-2.5 py-1.5 text-[13px] outline-none focus-field"
        >
          {tabsWithSubtabs.map((id) => (
            <option key={id} value={id}>{tabById.get(id)?.label ?? id}</option>
          ))}
        </select>
      </div>

      <div className="divide-y divide-line-faint">
        {current.map((subtabId, i) => {
          const st = subtabById.get(subtabId);
          if (!st) return null;
          return (
            <div key={subtabId} className="flex items-center gap-3 px-4 py-2">
              <span className="w-5 shrink-0 text-[11.5px] tabular text-ink-300">{i + 1}</span>
              <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-900">{st.label}</span>
              <span className="shrink-0 text-[11.5px] text-ink-400">{st.key}</span>
              <span className="flex shrink-0 gap-0.5">
                <button
                  type="button"
                  disabled={i === 0 || pending}
                  onClick={() => move(i, i - 1)}
                  aria-label={`Move ${st.label} earlier`}
                  className="grid size-6 place-items-center rounded text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900 disabled:opacity-25"
                >
                  <Icon name="chevron-up" size={13} />
                </button>
                <button
                  type="button"
                  disabled={i === current.length - 1 || pending}
                  onClick={() => move(i, i + 1)}
                  aria-label={`Move ${st.label} later`}
                  className="grid size-6 place-items-center rounded text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900 disabled:opacity-25"
                >
                  <Icon name="chevron-down" size={13} />
                </button>
              </span>
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line-soft px-4 py-2.5">
        <p className="text-[12px] text-ink-400">
          {error ? (
            <span className="flex items-center gap-1.5 text-[#b02a30]">
              <Icon name="alert-triangle" size={12} />
              {error}
            </span>
          ) : dirty ? (
            'Unsaved changes'
          ) : saved === key ? (
            <span className="flex items-center gap-1.5 text-ok">
              <Icon name="check" size={12} />
              Saved &mdash; this tab&rsquo;s subtabs appear in the new order on the next page load.
            </span>
          ) : (
            'The order this tab shows its subtabs in, on this module only.'
          )}
        </p>
        <Button
          size="sm"
          variant="primary"
          icon="check"
          disabled={!dirty}
          loading={pending}
          loadingLabel="Saving…"
          onClick={save}
        >
          Save order
        </Button>
      </div>
    </div>
  );
}
