'use client';

/**
 * The New field and Edit field forms — UI/UX Redesign spec §6:
 *
 *   Label · Field type (the 17 allowed) · Module(s) (nothing to choose — fields
 *   are shared) · Tab and section · Position (dragged on a preview of the
 *   4-column grid) · Options · Helper text · Required · Show in Vital Info ·
 *   Show as list column · Allow notes · and, for Auto-populated, where the
 *   value comes from.
 *
 * Everything the create form collects is saved in one transaction
 * (`create_field_with_setup`, migration 9805), so a failure never leaves a
 * half-made field behind.
 */
import { useActionState, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import {
  DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, rectSortingStrategy, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { SWATCHES as SWATCH_TOKENS } from '@/proto/ui/tokens';
import {
  NEW_FIELD_TYPES, NEW_FIELD_TYPE_LABELS, AUTO_SOURCES, AUTO_SOURCE_LABELS, CHOICE_FIELD_TYPES, SWATCHES,
} from '@/lib/records/adminSchemas';
import type { AdminFieldRow } from '@/lib/records/adminFields';
import type { AdminTabRow, AdminSubtabRow } from '@/lib/records/adminPresets';
import { createFieldAction, updateFieldAction, changeFieldTypeAction, type PresetFormState } from './actions';

type NewType = (typeof NEW_FIELD_TYPES)[number];
type Swatch = (typeof SWATCHES)[number];
export type ModuleChoice = { id: string; label: string };

const FULL_ROW = new Set(['address', 'percent_split', 'repeat_group', 'grid']);
const NEW_ID = '__new';

const inputClass =
  'mt-1 w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none transition-colors hover:border-ink-300 focus-field';
const labelClass = 'block text-[11.5px] font-semibold uppercase tracking-[.05em] text-ink-500';

/* -------------------------------------------------------------------------- */
/* Shared pieces                                                              */
/* -------------------------------------------------------------------------- */

function Group({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <fieldset className="border-t border-line-soft pt-4 first:border-t-0 first:pt-0">
      <legend className="sr-only">{title}</legend>
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="text-[12px] font-semibold uppercase tracking-[.08em] text-ink-700">{title}</h3>
        {aside}
      </div>
      {children}
    </fieldset>
  );
}

/** A labelled on/off switch that submits like a checkbox. */
function Toggle({
  name, label, hint, defaultChecked, checked, onChange,
}: {
  name?: string;
  label: string;
  hint?: string;
  defaultChecked?: boolean;
  checked?: boolean;
  onChange?: (on: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 py-1.5">
      <span className="min-w-0">
        <span className="block text-[13px] font-medium text-ink-800">{label}</span>
        {hint ? <span className="block text-[11.5px] leading-snug text-ink-400">{hint}</span> : null}
      </span>
      <span className="relative mt-0.5 inline-flex shrink-0">
        <input
          type="checkbox"
          name={name}
          defaultChecked={defaultChecked}
          checked={checked}
          onChange={onChange ? (e) => onChange(e.currentTarget.checked) : undefined}
          className="peer sr-only"
        />
        <span className="h-[18px] w-8 rounded-full bg-line transition-colors peer-checked:bg-brand-600 peer-focus-visible:ring-2 peer-focus-visible:ring-brand-600/30" />
        <span className="absolute left-0.5 top-0.5 size-[14px] rounded-full bg-white shadow transition-transform peer-checked:translate-x-[14px]" />
      </span>
    </label>
  );
}

function FormError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <p role="alert" className="mt-3 flex items-center gap-1.5 rounded-lg border border-bad/25 bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
      <Icon name="alert-triangle" size={12} />
      {message}
    </p>
  );
}

function Done({ what, onClose }: { what: string; onClose: () => void }) {
  return (
    <div className="mt-4">
      <p className="flex items-center gap-1.5 text-[13px] text-ok">
        <Icon name="check" size={14} strokeWidth={2.5} />
        {what}
      </p>
      <div className="mt-5 flex justify-end">
        <Button type="button" variant="primary" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

/** Tab, sub-tab and section, kept together: the preview and the section list
 *  both depend on all three. */
function usePlacement(tabs: AdminTabRow[], subtabs: AdminSubtabRow[], init: { tabId: string; subtabId: string | null; section: string }) {
  const [tabId, setTabId] = useState(init.tabId);
  const [subtabId, setSubtabId] = useState<string>(init.subtabId ?? '');
  const [section, setSection] = useState(init.section);
  const available = subtabs.filter((s) => s.tabId === tabId);
  return { tabId, setTabId: (id: string) => { setTabId(id); setSubtabId(''); }, subtabId, setSubtabId, section, setSection, available, tabs };
}

function PlacementInputs({ p, sections }: { p: ReturnType<typeof usePlacement>; sections: string[] }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className={labelClass}>Tab</span>
        <select name="tabId" required value={p.tabId} onChange={(e) => p.setTabId(e.target.value)} className={inputClass}>
          {p.tabs.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <label className="block">
        <span className={labelClass}>Sub-tab</span>
        <select
          name="subtabId"
          value={p.subtabId}
          onChange={(e) => p.setSubtabId(e.target.value)}
          disabled={p.available.length === 0}
          className={inputClass}
        >
          <option value="">{p.available.length ? '— directly on the tab —' : 'This tab has no sub-tabs'}</option>
          {p.available.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <label className="block sm:col-span-2">
        <span className={labelClass}>Section <span className="font-normal normal-case tracking-normal text-ink-400">(optional)</span></span>
        <input
          name="section"
          list="field-form-sections"
          value={p.section}
          onChange={(e) => p.setSection(e.target.value)}
          placeholder={sections.length ? `e.g. ${sections[0]}` : 'Leave empty for the top of the tab'}
          className={inputClass}
        />
        <datalist id="field-form-sections">
          {sections.map((s) => <option key={s} value={s} />)}
        </datalist>
      </label>
    </div>
  );
}

/** Options for Dropdown, Multiple picker, Status (with colours) and
 *  Percentage = 100% (the parts that must total 100). */
function OptionsEditor({
  type, rows, onChange,
}: {
  type: NewType;
  rows: { value: string; swatch: Swatch | '' }[];
  onChange: (rows: { value: string; swatch: Swatch | '' }[]) => void;
}) {
  const coloured = type === 'status';
  const set = (i: number, patch: Partial<{ value: string; swatch: Swatch | '' }>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((r, i) => (
        <div key={i} className="flex items-center gap-2">
          {coloured ? (
            <select
              aria-label={`Colour of option ${i + 1}`}
              value={r.swatch}
              onChange={(e) => set(i, { swatch: e.target.value as Swatch })}
              className="w-[108px] shrink-0 rounded-lg border border-line bg-white px-2 py-2 text-[12.5px] outline-none focus-field"
              style={r.swatch ? { color: SWATCH_TOKENS[r.swatch].text, background: SWATCH_TOKENS[r.swatch].bg } : undefined}
            >
              <option value="">No colour</option>
              {SWATCHES.map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}
            </select>
          ) : (
            <span className="w-5 shrink-0 text-right text-[11.5px] tabular text-ink-400">{i + 1}</span>
          )}
          <input
            aria-label={`Option ${i + 1}`}
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            placeholder={type === 'percent_split' ? `Part ${i + 1}, e.g. Business` : `Option ${i + 1}`}
            className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] outline-none hover:border-ink-300 focus-field"
          />
          <button
            type="button"
            aria-label={`Remove option ${i + 1}`}
            disabled={rows.length <= 1}
            onClick={() => onChange(rows.filter((_, j) => j !== i))}
            className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 transition-colors hover:bg-bad-bg hover:text-bad disabled:opacity-30"
          >
            <Icon name="x" size={13} />
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...rows, { value: '', swatch: '' }])}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12.5px] font-semibold text-brand-700 hover:bg-brand-50"
      >
        <Icon name="plus" size={11} strokeWidth={2.4} />
        {type === 'percent_split' ? 'Add part' : 'Add option'}
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Position — drag the new field into place on the 4-column grid              */
/* -------------------------------------------------------------------------- */

function PreviewCell({ id, label, type, isSelf }: { id: string; label: string; type: string; isSelf: boolean }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id, disabled: !isSelf });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, gridColumn: FULL_ROW.has(type) ? '1 / -1' : undefined }}
      {...(isSelf ? { ...attributes, ...listeners } : {})}
      aria-label={isSelf ? `${label || 'New field'} — drag to place it` : undefined}
      className={`flex h-11 min-w-0 items-center gap-1.5 rounded-md border px-2 text-[11px] leading-tight ${
        isSelf
          ? `cursor-grab border-brand-600 bg-brand-50 font-semibold text-brand-800 shadow-[0_0_0_3px_rgba(29,78,216,.10)] active:cursor-grabbing ${isDragging ? 'z-10 opacity-80' : ''}`
          : 'border-line bg-white text-ink-500'
      }`}
    >
      {isSelf ? <Icon name="shuffle" size={10} className="shrink-0" /> : null}
      <span className="line-clamp-2 min-w-0">{label || (isSelf ? 'New field' : '')}</span>
    </div>
  );
}

function PositionPreview({
  neighbours, selfLabel, selfType, afterId, onChange,
}: {
  /** Fields already in this tab / sub-tab / section, in drawer order. */
  neighbours: { id: string; label: string; type: string }[];
  selfLabel: string;
  selfType: string;
  /** The field this one follows; null = first. */
  afterId: string | null;
  onChange: (afterId: string | null) => void;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = useMemo(() => {
    const base = neighbours.map((n) => n.id);
    const at = afterId ? base.indexOf(afterId) + 1 : 0;
    const clamped = afterId && at === 0 ? base.length : at;
    return [...base.slice(0, clamped), NEW_ID, ...base.slice(clamped)];
  }, [neighbours, afterId]);
  const byId = new Map(neighbours.map((n) => [n.id, n]));
  const index = ids.indexOf(NEW_ID);

  const moveTo = (next: number) => {
    const list = arrayMove(ids, index, Math.max(0, Math.min(ids.length - 1, next)));
    const i = list.indexOf(NEW_ID);
    onChange(i === 0 ? null : list[i - 1]!);
  };
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    moveTo(ids.indexOf(String(e.over.id)));
  };

  return (
    <div>
      <div className="rounded-xl border border-line bg-canvas/60 p-2.5">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={ids} strategy={rectSortingStrategy}>
            <div className="grid grid-cols-4 gap-1.5">
              {ids.map((id) =>
                id === NEW_ID ? (
                  <PreviewCell key={id} id={id} label={selfLabel} type={selfType} isSelf />
                ) : (
                  <PreviewCell key={id} id={id} label={byId.get(id)?.label ?? ''} type={byId.get(id)?.type ?? 'text'} isSelf={false} />
                ),
              )}
            </div>
          </SortableContext>
        </DndContext>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 text-[11.5px] text-ink-400">
        <span>
          {index === 0 ? 'First' : `After ${byId.get(ids[index - 1]!)?.label ?? ''}`}
          {' · '}position {index + 1} of {ids.length}
        </span>
        <span className="flex gap-1">
          <button type="button" onClick={() => moveTo(index - 1)} disabled={index === 0} aria-label="Move earlier"
            className="grid size-6 place-items-center rounded border border-line bg-white text-ink-500 hover:text-ink-900 disabled:opacity-40">
            <Icon name="chevron-left" size={12} />
          </button>
          <button type="button" onClick={() => moveTo(index + 1)} disabled={index === ids.length - 1} aria-label="Move later"
            className="grid size-6 place-items-center rounded border border-line bg-white text-ink-500 hover:text-ink-900 disabled:opacity-40">
            <Icon name="chevron-right" size={12} />
          </button>
        </span>
      </div>
    </div>
  );
}

/** The neighbours a field is placed among: same tab, sub-tab and section. */
function neighboursOf(fields: AdminFieldRow[], tabId: string, subtabId: string, section: string, selfId?: string) {
  const sec = section.trim() || null;
  return fields
    .filter((f) => !f.archivedAt && f.id !== selfId && f.tabId === tabId && (f.subtabId ?? '') === subtabId && (f.section?.trim() || null) === sec)
    .sort((a, b) => a.position - b.position)
    .map((f) => ({ id: f.id, label: f.label, type: f.type }));
}

function sectionsIn(fields: AdminFieldRow[], tabId: string, subtabId: string): string[] {
  return [...new Set(fields.filter((f) => !f.archivedAt && f.tabId === tabId && (f.subtabId ?? '') === subtabId && f.section).map((f) => f.section!.trim()))];
}

function ShowsIn({ modules, inVital, columnModuleIds }: { modules: ModuleChoice[]; inVital: boolean; columnModuleIds: string[] }) {
  const [listOn, setListOn] = useState(columnModuleIds.length > 0);
  const [picked, setPicked] = useState<string[]>(columnModuleIds.length ? columnModuleIds : modules.map((m) => m.id));
  return (
    <>
      <p className="mb-1.5 flex items-start gap-2 rounded-lg bg-canvas px-3 py-2 text-[12px] leading-snug text-ink-500">
        <Icon name="link" size={12} className="mt-0.5 shrink-0 text-brand-600" />
        <span>
          <strong className="font-semibold text-ink-700">Every module.</strong> Fields are shared, so this one appears in{' '}
          {modules.map((m) => m.label).join(', ')} with the same value.
        </span>
      </p>
      <Toggle name="showInVital" label="Show in Vital Info" hint="Adds it to the Vital Info section at the top of every record." defaultChecked={inVital} />
      <Toggle label="Show as list column" hint="A column in the record list, in the modules you pick." checked={listOn} onChange={setListOn} />
      {listOn ? (
        <div className="mb-1 mt-0.5 flex flex-wrap gap-1.5 pl-0.5">
          {modules.map((m) => {
            const on = picked.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                aria-pressed={on}
                onClick={() => setPicked((p) => (on ? p.filter((x) => x !== m.id) : [...p, m.id]))}
                className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-[3px] text-[12px] font-semibold transition-colors ${
                  on ? 'border-brand-100 bg-brand-50 text-brand-700' : 'border-line bg-white text-ink-400 hover:text-ink-700'
                }`}
              >
                {on ? <Icon name="check" size={10} strokeWidth={2.6} /> : null}
                {m.label}
              </button>
            );
          })}
        </div>
      ) : null}
      <input type="hidden" name="columnModuleIds" value={JSON.stringify(listOn ? picked : [])} />
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* New field                                                                  */
/* -------------------------------------------------------------------------- */

const initial: PresetFormState = { ok: false };

export function CreateFieldForm({
  tabs, subtabs, fields, modules, onClose,
}: {
  tabs: AdminTabRow[];
  subtabs: AdminSubtabRow[];
  fields: AdminFieldRow[];
  modules: ModuleChoice[];
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState(createFieldAction, initial);
  const [label, setLabel] = useState('');
  const [type, setType] = useState<NewType>('text');
  const [digitsOnly, setDigitsOnly] = useState(false);
  const [autoSource, setAutoSource] = useState<string>('');
  const [options, setOptions] = useState<{ value: string; swatch: Swatch | '' }[]>([{ value: '', swatch: '' }, { value: '', swatch: '' }]);
  const p = usePlacement(tabs, subtabs, { tabId: tabs[0]?.id ?? '', subtabId: null, section: '' });
  const neighbours = useMemo(() => neighboursOf(fields, p.tabId, p.subtabId, p.section), [fields, p.tabId, p.subtabId, p.section]);
  const [afterId, setAfterId] = useState<string | null>(null);
  // A new placement starts the field at the end of it.
  const placementKey = `${p.tabId}|${p.subtabId}|${p.section.trim()}`;
  const [lastPlacement, setLastPlacement] = useState(placementKey);
  if (placementKey !== lastPlacement) {
    setLastPlacement(placementKey);
    setAfterId(neighbours.at(-1)?.id ?? null);
  }
  const labelRef = useRef<HTMLInputElement>(null);
  useEffect(() => labelRef.current?.focus(), []);

  const mccFields = useMemo(
    () => fields.filter((f) => !f.archivedAt && (f.type === 'identifier' || f.type === 'text')),
    [fields],
  );
  const keyPreview = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

  if (state.ok) return <Done what={`${label || 'Field'} created — it is in every module now.`} onClose={onClose} />;

  return (
    <form action={action} className="mt-4">
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Group title="Field">
            <label className="block">
              <span className={labelClass}>Label</span>
              <input ref={labelRef} name="label" required value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Gateway provider" className={inputClass} />
            </label>
            {keyPreview ? <p className="mt-1 text-[11.5px] text-ink-400">Stored as <code className="font-mono text-ink-500">{keyPreview}</code></p> : null}

            <label className="mt-3 block">
              <span className={labelClass}>Field type</span>
              <select name="type" value={type} onChange={(e) => setType(e.target.value as NewType)} className={inputClass}>
                {NEW_FIELD_TYPES.map((t) => <option key={t} value={t}>{NEW_FIELD_TYPE_LABELS[t]}</option>)}
              </select>
            </label>

            {type === 'text' ? (
              <div className="mt-2 rounded-lg border border-line-soft px-3 py-1">
                <Toggle name="digitsOnly" label="Digits only" hint="For IDs like MCC or MID — leading zeros are kept." checked={digitsOnly} onChange={setDigitsOnly} />
                {digitsOnly ? (
                  <label className="mb-2 block">
                    <span className={labelClass}>Allowed length <span className="font-normal normal-case tracking-normal text-ink-400">(optional)</span></span>
                    <input name="digits" placeholder="e.g. 4, or 4, 9" className={inputClass} />
                  </label>
                ) : null}
              </div>
            ) : null}

            {type === 'auto' ? (
              <div className="mt-2 space-y-2 rounded-lg border border-line-soft p-3">
                <label className="block">
                  <span className={labelClass}>Value comes from</span>
                  <select name="autoSource" required value={autoSource} onChange={(e) => setAutoSource(e.target.value)} className={inputClass}>
                    <option value="">Choose…</option>
                    {AUTO_SOURCES.map((s) => <option key={s} value={s}>{AUTO_SOURCE_LABELS[s]}</option>)}
                  </select>
                </label>
                {autoSource === 'mcc_lookup' ? (
                  <label className="block">
                    <span className={labelClass}>MCC code field</span>
                    <select name="autoSourceField" required defaultValue={mccFields.find((f) => f.key === 'mcc_code')?.key ?? ''} className={inputClass}>
                      <option value="">Choose…</option>
                      {mccFields.map((f) => <option key={f.id} value={f.key}>{f.label}</option>)}
                    </select>
                  </label>
                ) : null}
                <p className="text-[11.5px] text-ink-400">Filled in by the system on every record. Nobody can edit it.</p>
              </div>
            ) : null}
          </Group>

          {(CHOICE_FIELD_TYPES as readonly string[]).includes(type) ? (
            <Group title={type === 'percent_split' ? 'Parts (must total 100%)' : 'Options'}>
              <OptionsEditor type={type} rows={options} onChange={setOptions} />
              <input type="hidden" name="choices" value={JSON.stringify(options.filter((o) => o.value.trim()))} />
            </Group>
          ) : null}

          <Group title="Where it lives">
            <PlacementInputs p={p} sections={sectionsIn(fields, p.tabId, p.subtabId)} />
          </Group>

          <Group title="Helper text">
            <input name="hint" placeholder="Optional — shown in an (i) beside the label" className={`${inputClass} mt-0`} />
          </Group>

          <Group title="Behaviour">
            <div className="divide-y divide-line-faint">
              <Toggle name="required" label="Required" hint="Marked until it is filled in." />
              <Toggle name="notesEnabled" label="Allow notes" hint="Gives the field its own notes thread, like Seasonal and Inventory." />
              <Toggle name="sensitive" label="Sensitive" hint="Masked until revealed; every reveal is logged." />
            </div>
          </Group>

          <Group title="Where it shows">
            <ShowsIn modules={modules} inVital={false} columnModuleIds={[]} />
          </Group>
        </div>

        <aside className="md:sticky md:top-0 md:self-start">
          <Group title="Position" aside={<span className="text-[11.5px] text-ink-400">drag the blue box</span>}>
            <PositionPreview neighbours={neighbours} selfLabel={label} selfType={type} afterId={afterId} onChange={setAfterId} />
            <input type="hidden" name="afterFieldId" value={afterId ?? ''} />
            <p className="mt-2 text-[11.5px] leading-snug text-ink-400">
              {p.section.trim() ? `Inside the "${p.section.trim()}" section. ` : ''}Address and Percentage = 100% always take a full row.
            </p>
          </Group>
        </aside>
      </div>

      <FormError message={state.message} />

      <div className="mt-5 flex items-center justify-end gap-2 border-t border-line-soft pt-4">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon="check" disabled={pending}>{pending ? 'Creating…' : 'Create field'}</Button>
      </div>
    </form>
  );
}

/* -------------------------------------------------------------------------- */
/* Edit field                                                                 */
/* -------------------------------------------------------------------------- */

export function EditFieldForm({
  field, tabs, subtabs, fields, modules, typeLabel, onClose,
}: {
  field: AdminFieldRow;
  tabs: AdminTabRow[];
  subtabs: AdminSubtabRow[];
  fields: AdminFieldRow[];
  modules: ModuleChoice[];
  typeLabel: string;
  onClose: () => void;
}) {
  const [state, action, pending] = useActionState(updateFieldAction, initial);
  const [label, setLabel] = useState(field.label);
  const p = usePlacement(tabs, subtabs, { tabId: field.tabId, subtabId: field.subtabId, section: field.section ?? '' });
  const neighbours = useMemo(() => neighboursOf(fields, p.tabId, p.subtabId, p.section, field.id), [fields, p.tabId, p.subtabId, p.section, field.id]);
  const initialAfter = useMemo(() => {
    const before = neighbours.filter((n) => (fields.find((f) => f.id === n.id)?.position ?? 0) < field.position);
    return before.at(-1)?.id ?? null;
    // Computed once, from where the field sits when the dialog opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [afterId, setAfterId] = useState<string | null>(initialAfter);
  const [moved, setMoved] = useState(false);
  const placementKey = `${p.tabId}|${p.subtabId}|${p.section.trim()}`;
  const [lastPlacement, setLastPlacement] = useState(placementKey);
  if (placementKey !== lastPlacement) {
    setLastPlacement(placementKey);
    setAfterId(neighbours.at(-1)?.id ?? null);
    setMoved(true);
  }

  if (state.ok) return <Done what="Field updated." onClose={onClose} />;

  const choiceType = (CHOICE_FIELD_TYPES as readonly string[]).includes(field.type);

  return (
    <form action={action} className="mt-4">
      <input type="hidden" name="fieldId" value={field.id} />
      <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-4">
          <Group title="Field">
            <label className="block">
              <span className={labelClass}>Label</span>
              <input name="label" required value={label} onChange={(e) => setLabel(e.target.value)} className={inputClass} />
            </label>
            <TypeChanger field={field} typeLabel={typeLabel} />
            {choiceType ? (
              <a
                href={`/admin/presets?section=choices&field=${field.id}`}
                className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline"
              >
                <Icon name="circle-dot" size={12} />
                Edit its options
              </a>
            ) : null}
          </Group>

          <Group title="Where it lives">
            <PlacementInputs p={p} sections={sectionsIn(fields, p.tabId, p.subtabId)} />
          </Group>

          <Group title="Helper text">
            <input name="hint" defaultValue={field.hint ?? ''} placeholder="Optional — shown in an (i) beside the label" className={`${inputClass} mt-0`} />
          </Group>

          <Group title="Behaviour">
            <div className="divide-y divide-line-faint">
              <Toggle name="required" label="Required" hint="Marked until it is filled in." defaultChecked={field.required} />
              <Toggle name="notesEnabled" label="Allow notes" hint="Gives the field its own notes thread." defaultChecked={field.notesEnabled} />
              <Toggle name="sensitive" label="Sensitive" hint="Masked until revealed; every reveal is logged." defaultChecked={field.sensitive} />
            </div>
          </Group>

          <Group title="Where it shows">
            <ShowsIn modules={modules} inVital={field.inVital} columnModuleIds={field.columnModuleIds} />
          </Group>
        </div>

        <aside className="md:sticky md:top-0 md:self-start">
          <Group title="Position" aside={<span className="text-[11.5px] text-ink-400">drag the blue box</span>}>
            <PositionPreview
              neighbours={neighbours}
              selfLabel={label}
              selfType={field.type}
              afterId={afterId}
              onChange={(id) => { setAfterId(id); setMoved(true); }}
            />
            <input type="hidden" name="afterFieldId" value={afterId ?? ''} />
            <input type="hidden" name="placeIt" value={moved ? 'on' : ''} />
          </Group>
        </aside>
      </div>

      <FormError message={state.message} />

      <div className="mt-5 flex items-center justify-end gap-2 border-t border-line-soft pt-4">
        <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" icon="check" disabled={pending}>{pending ? 'Saving…' : 'Save changes'}</Button>
      </div>
    </form>
  );
}

/** Type change. Free while no record holds a value; otherwise refused, or
 *  asked once for types that store values the same way (spec §6). */
function TypeChanger({ field, typeLabel }: { field: AdminFieldRow; typeLabel: string }) {
  const [open, setOpen] = useState(false);
  const [next, setNext] = useState<NewType | ''>('');
  const [ask, setAsk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();
  const locked = field.isSystem || ['repeat_group', 'grid', 'auto'].includes(field.type);

  const run = (confirm: boolean) =>
    start(async () => {
      setError(null);
      const r = await changeFieldTypeAction({ fieldId: field.id, type: next, confirm });
      if (r.ok) { setDone(true); setAsk(null); setOpen(false); return; }
      if (r.needsConfirm) setAsk(r.message ?? null);
      else setError(r.message ?? 'That did not work.');
    });

  return (
    <div className="mt-3 rounded-lg border border-line-soft bg-canvas/50 px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-[12.5px]">
        <span className="text-ink-500">
          Type <strong className="font-semibold text-ink-800">{done && next ? NEW_FIELD_TYPE_LABELS[next] : typeLabel}</strong>
          <span className="ml-1.5 font-mono text-[11px] text-ink-400">{field.key}</span>
        </span>
        {locked ? (
          <span className="text-[11.5px] text-ink-400">{field.isSystem ? 'System field' : 'Fixed'}</span>
        ) : (
          <button type="button" onClick={() => setOpen((o) => !o)} className="text-[12px] font-semibold text-brand-700 hover:underline">
            Change type
          </button>
        )}
      </div>
      {open ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <select value={next} onChange={(e) => { setNext(e.target.value as NewType); setAsk(null); setError(null); }} className="rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] outline-none focus-field">
            <option value="">New type…</option>
            {NEW_FIELD_TYPES.filter((t) => t !== field.type && t !== 'auto').map((t) => <option key={t} value={t}>{NEW_FIELD_TYPE_LABELS[t]}</option>)}
          </select>
          <Button type="button" size="sm" variant="secondary" disabled={!next || pending} onClick={() => run(false)}>Change</Button>
        </div>
      ) : null}
      {ask ? (
        <div className="mt-2 rounded-md border border-warn/40 bg-warn-bg/40 px-2.5 py-2 text-[12px] text-ink-700">
          <p>{ask}</p>
          <div className="mt-1.5 flex gap-2">
            <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => run(true)}>Change type</Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setAsk(null)}>Keep it</Button>
          </div>
        </div>
      ) : null}
      {error ? <p className="mt-1.5 text-[12px] text-bad">{error}</p> : null}
      {!open && !ask && !error ? (
        <p className="mt-0.5 text-[11.5px] text-ink-400">
          {locked ? 'This type cannot change.' : 'Changing it is blocked when stored values would not convert, and asks first when they would.'}
        </p>
      ) : null}
    </div>
  );
}
