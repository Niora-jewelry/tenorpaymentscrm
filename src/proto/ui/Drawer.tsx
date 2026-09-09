'use client';

/**
 * PROTOTYPE — the record drawer.
 *
 * Under the Global Amendment the drawer is GLOBAL: the same tabs, subtabs and
 * fields in every module. A module contributes two ordered lists and nothing
 * else, so this file reads `tabsForModule` and draws whatever comes back.
 *
 * The module control at the top is still the clearest demonstration here: tick
 * Deals and the record appears in Deals immediately, with every value intact,
 * because there was only ever one copy of it.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Module, ModuleSlug, RecordRow, Tab } from '../schema';
import {
  DISPLAY_MODULES,
  MODULES,
  subtabsForModule,
  tabsForModule,
} from '../modules';
import { headerFieldsFor, tabHasFields } from '../fields';
import { isNewestChange } from '../changelog';
import { useStore } from '../store';
import { CAMPAIGN_BY_ID, FILES, LOGINS, MESSAGES, USER_BY_ID } from '../data';
import { CellValue } from './value';
import {
  Avatar, Button, CountPill, Dialog, IconButton, NewBadge, OutlineChip, Popover, StatusPill,
} from './kit';
import { Icon } from './icons';
import { SWATCHES } from './tokens';
import { anim, usePresence } from './motion';
import {
  ActivityTab, CasesTab, CommunicationTab, FieldsTab, FilesTab,
  LoginsTab, OtherTab, StatementsTab, UpdatesTab,
} from './tabs';

export function RecordDrawer({
  record,
  module,
  onClose,
}: {
  record: RecordRow;
  module: Module;
  onClose: () => void;
}) {
  const { updates, cases, setMemberships, deleteRecord, grantFor, readValue } = useStore();

  /*
   * The drawer owns an `open` flag so closing plays its slide-out before the
   * parent unmounts it.
   */
  const [open, setOpen] = useState(true);
  const { mounted, state } = usePresence(open, 170);
  const dismiss = useCallback(() => setOpen(false), []);

  const tabs = useMemo(() => tabsForModule(module), [module]);

  const [tabId, setTabId] = useState(tabs[0]!.id);
  const [subtabId, setSubtabId] = useState<string | undefined>(tabs[0]!.subtabs?.[0]?.id);
  const [confirm, setConfirm] = useState<null | { kind: 'archive' | 'delete' }>(null);

  /*
   * Switching modules reorders the tabs, so the selected one may no longer be
   * first — and in a frozen module may not be appropriate at all. Reset during
   * render, not in an effect, so the drawer never commits showing a stale tab.
   */
  const [lastModule, setLastModule] = useState(module.slug);
  if (module.slug !== lastModule) {
    setLastModule(module.slug);
    setTabId(tabs[0]!.id);
    setSubtabId(tabs[0]!.subtabs?.[0]?.id);
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && dismiss();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [dismiss]);

  useEffect(() => {
    if (!mounted) onClose();
  }, [mounted, onClose]);

  const tab = tabs.find((t) => t.id === tabId) ?? tabs[0]!;
  const subtabs = useMemo(() => subtabsForModule(module, tab), [module, tab]);

  const counts = useMemo(
    () => ({
      updates: updates.filter((u) => u.recordId === record.id && !u.parentId).length,
      cases: cases.filter((c) => c.recordId === record.id).length,
      files: FILES.filter((f) => f.recordId === record.id && f.files.length > 0).length,
      logins: LOGINS.filter((l) => l.recordId === record.id).length,
      communication: MESSAGES.filter((m) => m.recordId === record.id).length,
    }),
    [record.id, updates, cases],
  );

  // Header-strip membership varies per module — property (e).
  const headerFields = headerFieldsFor(module.slug).filter((f) => grantFor(f) !== 'hidden');
  const archived = record.memberships.length === 0;

  if (!mounted) return null;

  return (
    <>
      <div className="fixed inset-0 z-[60] flex justify-end">
        <div
          className={`absolute inset-0 bg-brand-950/25 ${anim(state, 'animate-fade-in', 'animate-fade-out')}`}
          onClick={dismiss}
        />

        <aside
          className={`relative flex h-full w-full max-w-[1120px] flex-col bg-canvas shadow-[-24px_0_64px_-24px_rgba(8,32,47,.45)] md:w-[68%] ${anim(
            state, 'animate-sheet-in', 'animate-sheet-out',
          )}`}
        >
          {/* ---------------- header ---------------- */}
          <header className="shrink-0 border-b border-line bg-white px-5 pt-4">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-[19px] font-semibold tracking-[-.01em] text-ink-900">
                  {record.dealName}
                </h2>

                {/* Header strip — the fields this module flags "Top of drawer".
                    A plain wrapping line, not individual boxed cards (tried
                    that, it read worse) — a light dot separator between pairs
                    is enough to keep a dozen values scannable. */}
                <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[12.5px] text-ink-500">
                  {headerFields.map((f, i) => {
                    const v = readValue(record, f, module.slug);
                    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
                    return (
                      <span key={f.id} className="inline-flex items-center gap-2.5">
                        {i > 0 ? <span className="text-line" aria-hidden>·</span> : null}
                        <span className="inline-flex items-center gap-1.5">
                          <span className="text-[11px] uppercase tracking-[.05em] text-ink-400">
                            {f.label}
                          </span>
                          <CellValue field={f} value={v} moduleSlug={module.slug} />
                        </span>
                      </span>
                    );
                  })}
                  <span className="text-line" aria-hidden>·</span>
                  <CreatorChip record={record} />
                  {archived ? <OutlineChip icon="archive">Archived</OutlineChip> : null}
                </div>
              </div>

              <IconButton icon="x" title="Close" onClick={dismiss} size={32} />
            </div>

            {/* ---------------- module control ---------------- */}
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-line-soft bg-canvas/60 px-2.5 py-2">
              <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
                In modules
              </span>

              {DISPLAY_MODULES.map((m) => {
                const on = record.memberships.includes(m.slug);
                return (
                  <span
                    key={m.slug}
                    className={`inline-flex items-center gap-1 rounded-full border px-2 py-[2px] text-[11.5px] font-semibold transition-colors duration-200 ${
                      on
                        ? 'border-brand-100 bg-brand-50 text-brand-700'
                        : 'border-line bg-white text-ink-400/70'
                    }`}
                  >
                    {on ? <Icon name="check" size={10} strokeWidth={2.5} /> : null}
                    {m.label}
                  </span>
                );
              })}

              <ModuleControl
                record={record}
                onApply={(next) => {
                  if (next.length === 0 && record.memberships.length > 0) setConfirm({ kind: 'archive' });
                  else setMemberships(record.id, next);
                }}
              />

              {/* Delete exists in exactly one module: the Records List. */}
              {module.slug === 'records' ? (
                <div className="ml-auto">
                  <Button
                    size="sm"
                    variant="danger"
                    icon="trash"
                    disabled={!archived}
                    title={
                      archived
                        ? 'Soft delete to the Recycle Bin'
                        : 'Archive this record first — it is still displayed in a module'
                    }
                    onClick={() => setConfirm({ kind: 'delete' })}
                  >
                    Delete
                  </Button>
                </div>
              ) : null}
            </div>

            {/* ---------------- pipeline ---------------- */}
            {module.pipelines.length ? (
              <div className="mt-1 border-t border-line-soft">
                <PipelineBar record={record} module={module} />
              </div>
            ) : (
              <div className="h-2" />
            )}

            {/* ---------------- tabs ---------------- */}
            <nav className="-mb-px flex gap-0.5 overflow-x-auto">
              {tabs.map((t) => {
                const active = t.id === tabId;
                const n = countFor(t, counts);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => {
                      setTabId(t.id);
                      setSubtabId(subtabsForModule(module, t)[0]?.id);
                    }}
                    className={`flex shrink-0 items-center whitespace-nowrap border-b-2 px-2.5 py-2 text-[13px] font-medium transition-colors duration-150 ${
                      active
                        ? 'border-brand-600 text-brand-700'
                        : 'border-transparent text-ink-500 hover:border-line hover:text-ink-900'
                    } ${t.system ? '' : 'font-semibold'}`}
                  >
                    {t.label}
                    {n != null ? <CountPill n={n} active={active} /> : null}
                    {isNewestChange(t.id) ? <NewBadge compact /> : null}
                  </button>
                );
              })}
            </nav>
          </header>

          {/* ---------------- subtabs ---------------- */}
          {subtabs.length ? (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-white px-5 py-1.5">
              {subtabs.map((s) => {
                const active = s.id === (subtabId ?? subtabs[0]!.id);
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => setSubtabId(s.id)}
                    className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium transition-colors duration-150 ${
                      active ? 'bg-brand-600 text-white' : 'text-ink-500 hover:bg-canvas'
                    }`}
                  >
                    {s.label}
                    {s.comingSoon ? (
                      <Icon name="clock" size={10} className={active ? 'opacity-70' : 'opacity-50'} />
                    ) : null}
                    {isNewestChange(`${tab.id}/${s.id}`) ? <NewBadge compact /> : null}
                  </button>
                );
              })}
            </div>
          ) : null}

          {/* ---------------- body ---------------- */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
            {module.frozen ? <FrozenNotice module={module} /> : null}
            <SubtabDescription subtab={subtabs.find((s) => s.id === (subtabId ?? subtabs[0]?.id))} />
            <TabBody record={record} module={module} tab={tab} subtabId={subtabId} />
          </div>

          {/* ---------------- footer ---------------- */}
          <footer className="flex shrink-0 items-center gap-2 border-t border-line bg-white px-5 py-1.5 text-ink-400">
            <Icon name="link" size={11} />
            <span className="text-[11px]">
              Deep-linkable — <code className="font-mono">/{module.slug}?record={record.id}</code>
            </span>
            <span className="ml-auto text-[11px]">
              Same drawer in every module — only the tab order differs
            </span>
          </footer>
        </aside>
      </div>

      {/* ---------------- confirmations ---------------- */}
      {confirm?.kind === 'archive' ? (
        <Dialog
          title="Archive this record?"
          confirmLabel="Archive"
          confirmIcon="archive"
          onClose={() => setConfirm(null)}
          onConfirm={() => setMemberships(record.id, [])}
        >
          <p>
            <strong>{record.dealName}</strong> will no longer appear in any display module. It stays
            stored in the Records List with every field value, file, message, case and history entry
            intact, and can be displayed again at any time.
          </p>
          <p className="text-ink-400">Nothing is deleted. Nothing enters the Recycle Bin.</p>
        </Dialog>
      ) : null}

      {confirm?.kind === 'delete' ? (
        <Dialog
          title="Delete this record?"
          tone="danger"
          confirmLabel="Delete to Recycle Bin"
          confirmIcon="trash"
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            deleteRecord(record.id);
            dismiss();
          }}
        >
          <p>
            <strong>{record.dealName}</strong> will move to the Recycle Bin, where an admin can
            restore it or permanently purge it.
          </p>
          <p className="text-ink-400">
            A restored record always comes back <strong>archived</strong> — active in the Records
            List with no display memberships.
          </p>
        </Dialog>
      ) : null}
    </>
  );
}

/** Record creator — a team member, or a marketing campaign. */
function CreatorChip({ record }: { record: RecordRow }) {
  if (record.creator.kind === 'campaign') {
    const campaign = CAMPAIGN_BY_ID.get(record.creator.id);
    return (
      <span
        title="Record creator — a marketing campaign, not a person. Read-only, and grants no access."
        className="inline-flex items-center gap-1.5"
      >
        <span className="text-[11px] uppercase tracking-[.05em] text-ink-400">Created by</span>
        <OutlineChip tone="brand" icon="target">
          {campaign?.name ?? 'Campaign'}
        </OutlineChip>
      </span>
    );
  }
  const user = USER_BY_ID.get(record.creator.id);
  if (!user) return null;
  return (
    <span
      title="Record creator — read-only, and grants no access."
      className="inline-flex items-center gap-1.5"
    >
      <span className="text-[11px] uppercase tracking-[.05em] text-ink-400">Created by</span>
      <Avatar user={user} size={18} />
      <span className="text-[12.5px]">{user.name}</span>
    </span>
  );
}

function FrozenNotice({ module }: { module: Module }) {
  return (
    <div className="mb-3 flex gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[12.5px] leading-relaxed text-[#8a5a09]">
      <Icon name="alert-triangle" size={14} className="mt-0.5 shrink-0" />
      <span>
        <strong>{module.label} is on hold.</strong> The client has someone else designing its
        structure — <em>&ldquo;do not work on it yet&rdquo;</em>. The tab order below is from the
        spreadsheet; nothing beyond it has been built here.
      </span>
    </div>
  );
}

/**
 * 19 Aug amendment: Pricing's four subtabs each carry explanatory text the
 * client wrote himself — e.g. "TapDash participates in these fees" versus
 * "The Merchant does not participate in these costs" for the neighbouring
 * subtab. Deliberately NOT styled like `SpecNote` (our own architecture
 * commentary, tinted brand-blue) — this is the client's own description of
 * what belongs on the screen, so it reads as plain body text with a light
 * quote treatment rather than as us explaining the build to him.
 */
function SubtabDescription({ subtab }: { subtab?: { description?: string } }) {
  if (!subtab?.description) return null;
  return (
    <p className="mb-3 border-l-2 border-line pl-3 text-[12.5px] italic leading-relaxed text-ink-500">
      {subtab.description}
    </p>
  );
}

function countFor(tab: Tab, counts: Record<string, number>): number | null {
  switch (tab.kind) {
    case 'updates': return counts.updates!;
    case 'cases': return counts.cases!;
    case 'files': return counts.files!;
    case 'logins': return counts.logins!;
    case 'communication': return counts.communication!;
    default: return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Tab body — dispatches on tab KIND, never on a module or tab name            */
/* -------------------------------------------------------------------------- */

function TabBody({
  record,
  module,
  tab,
  subtabId,
}: {
  record: RecordRow;
  module: Module;
  tab: Tab;
  subtabId?: string;
}) {
  const fields = (
    <FieldsTab record={record} moduleSlug={module.slug} tabId={tab.id} subtabId={subtabId} />
  );

  switch (tab.kind) {
    case 'communication':
      return <CommunicationTab record={record} subtabId={subtabId ?? 'email'} />;
    case 'updates':
      return <UpdatesTab record={record} />;
    case 'cases':
      return <CasesTab record={record} />;
    case 'freeform':
      // The "Other" tab — per-record entries, not schema fields.
      return <OtherTab record={record} />;
    case 'files':
      return (
        <div className="space-y-5">
          <FilesTab record={record} subtabId={subtabId ?? 'application'} />
          {/* Files, Logins and Statements MAY hold admin-added fields. */}
          {tabHasFields(tab.id) ? fields : null}
        </div>
      );
    case 'logins':
      return (
        <div className="space-y-5">
          <LoginsTab record={record} />
          {tabHasFields(tab.id) ? fields : null}
        </div>
      );
    case 'statements':
      return (
        <div className="space-y-5">
          <StatementsTab record={record} />
          {tabHasFields(tab.id) ? fields : null}
        </div>
      );
    default:
      /*
       * Overview carries the record's history as well as its fields — under the
       * global drawer there is no "Details" tab left to host it.
       */
      return tab.id === 'overview' ? (
        <div className="space-y-5">
          {fields}
          <ActivityTab record={record} />
        </div>
      ) : (
        fields
      );
  }
}

/* -------------------------------------------------------------------------- */
/* Module control                                                              */
/* -------------------------------------------------------------------------- */

function ModuleControl({
  record,
  onApply,
}: {
  record: RecordRow;
  onApply: (next: ModuleSlug[]) => void;
}) {
  const [draft, setDraft] = useState<ModuleSlug[]>(record.memberships);

  const [lastSaved, setLastSaved] = useState(record.memberships);
  if (record.memberships !== lastSaved) {
    setLastSaved(record.memberships);
    setDraft(record.memberships);
  }

  return (
    <Popover
      width={290}
      trigger={(open) => (
        <span className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2 py-[2px] text-[11.5px] font-semibold text-ink-500 transition-colors hover:border-ink-400 hover:text-ink-900">
          Change
          <Icon
            name="chevron-down"
            size={10}
            className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`}
          />
        </span>
      )}
    >
      {(close) => (
        <div className="p-1">
          <p className="px-2 pb-2 text-[11.5px] leading-relaxed text-ink-400">
            Generated from the modules table — a new module appears here automatically. The Records
            List is never listed: membership there is permanent.
          </p>
          {DISPLAY_MODULES.map((m) => {
            const on = draft.includes(m.slug);
            return (
              <label
                key={m.slug}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13.5px] transition-colors hover:bg-canvas"
              >
                <input
                  type="checkbox"
                  checked={on}
                  className="size-3.5 accent-[#1d4ed8]"
                  onChange={() =>
                    setDraft((prev) => (on ? prev.filter((s) => s !== m.slug) : [...prev, m.slug]))
                  }
                />
                {m.label}
                {m.frozen ? <OutlineChip tone="warn">On hold</OutlineChip> : null}
              </label>
            );
          })}

          {draft.length === 0 ? (
            <p className="mx-1 mt-2 flex gap-1.5 rounded-md border border-[#f7e0af] bg-[#fdf1d8] px-2 py-1.5 text-[11.5px] leading-relaxed text-[#8a5a09]">
              <Icon name="archive" size={12} className="mt-0.5 shrink-0" />
              <span>
                Unchecking every module is the <strong>Archive</strong> action. The record stays in
                the Records List.
              </span>
            </p>
          ) : null}

          <div className="mt-2 flex justify-end gap-2 border-t border-line pt-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(record.memberships);
                close();
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              icon="check"
              onClick={() => {
                onApply(draft);
                close();
              }}
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/* -------------------------------------------------------------------------- */
/* Pipeline bar                                                                */
/* -------------------------------------------------------------------------- */

function PipelineBar({ record, module }: { record: RecordRow; module: Module }) {
  const { setPipelineStep, clearPipeline } = useStore();
  const assignment = record.pipeline[module.slug];
  const pipeline = module.pipelines.find((p) => p.id === assignment?.pipelineId);

  if (!assignment || !pipeline) {
    return (
      <div className="flex flex-wrap items-center gap-2 py-2">
        <Icon name="route" size={13} className="text-ink-400" />
        <span className="text-[12px] text-ink-400">No pipeline on this record in {module.label}.</span>
        {module.pipelines.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => setPipelineStep(record.id, module.slug, p.id, p.steps[0]!.id)}
            className="text-[12px] font-semibold text-brand-700 hover:underline"
          >
            Assign “{p.label}”
          </button>
        ))}
      </div>
    );
  }

  const index = pipeline.steps.findIndex((s) => s.id === assignment.stepId);

  return (
    <div className="py-2">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="route" size={13} className="text-ink-400" />
        <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
          {pipeline.label}
        </span>
        <span className="text-[11.5px] text-ink-400 tabular">
          step {index + 1} of {pipeline.steps.length}
        </span>
        <button
          type="button"
          onClick={() => clearPipeline(record.id, module.slug)}
          className="text-[11px] text-ink-400 transition-colors hover:text-brand-700 hover:underline"
        >
          Remove
        </button>
        <span className="ml-auto text-[11px] text-ink-400">
          Independent per module
        </span>
      </div>

      <div className="mt-1.5 flex items-center gap-1 overflow-x-auto pb-1">
        {pipeline.steps.map((step, i) => {
          const done = i < index;
          const current = i === index;
          const s = SWATCHES[step.swatch];
          return (
            <button
              key={step.id}
              type="button"
              onClick={() => setPipelineStep(record.id, module.slug, pipeline.id, step.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-[3px] text-[11.5px] font-semibold transition-all duration-200 active:scale-95 ${
                current
                  ? ''
                  : done
                    ? 'border-line bg-white text-ink-500 hover:border-ink-400'
                    : 'border-line bg-white text-ink-400/70 hover:border-ink-400 hover:text-ink-700'
              }`}
              style={current ? { background: s.bg, color: s.text, borderColor: s.border } : undefined}
            >
              {done ? (
                <Icon name="check" size={10} strokeWidth={2.5} style={{ color: s.dot }} />
              ) : (
                <span
                  aria-hidden
                  className="size-[5px] rounded-full"
                  style={{ background: current ? s.dot : '#c7d3dd' }}
                />
              )}
              {step.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { MODULES, StatusPill };
