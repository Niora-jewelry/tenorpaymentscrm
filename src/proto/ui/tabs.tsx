'use client';

/**
 * PROTOTYPE — the drawer tab bodies.
 *
 * Under the Global Amendment a tab's contents are the SAME in every module, so
 * these components take a record and a tab id, and nothing about which module
 * asked. The module is passed only where it genuinely matters: reading a field
 * whose choices differ per module.
 *
 * Layout note: fields render in a 2–3 column grid rather than one per row —
 * the client asked for "at least two fields per row and preferably 3". Fields
 * that cannot survive a narrow column (long text, addresses, 100% splits,
 * grids) opt out with `wide` and span the full width.
 */
import { useMemo, useState } from 'react';
import type {
  CaseThread, CustomEntry, Field, FileRow, Note, RecordRow, Update,
} from '../schema';
import { fieldsInTab, FIELDS, choicesFor } from '../fields';
import { describePlacement } from '../modules';
import { useStore, userName } from '../store';
import {
  APPLICATION_ROWS, CAMPAIGN_BY_ID, FILES, LOGINS, MESSAGES,
  STATEMENTS, STATEMENT_YEARS, USER_BY_ID,
} from '../data';
import { FieldRenderer } from './value';
import {
  Avatar, Button, CaseStatePill, ComingSoon, CompletenessBadge, CountPill,
  EmptyState, IconButton, OutlineChip, SectionLabel, SpecNote, StatusPill,
} from './kit';
import { ACTIVITY_ICON, CHANNEL_ICON, Icon, type IconName } from './icons';
import { formatDateTime, monthLabel, relative, MONTH_NAMES } from './tokens';

/* ========================================================================== */
/* Fields — the body of every custom tab                                       */
/* ========================================================================== */

export function FieldsTab({
  record,
  moduleSlug,
  tabId,
  subtabId,
}: {
  record: RecordRow;
  moduleSlug: string;
  tabId: string;
  subtabId?: string;
}) {
  const { grantFor } = useStore();
  const placement = subtabId ? `${tabId}/${subtabId}` : tabId;

  const fields = useMemo(
    () => fieldsInTab(tabId, subtabId).filter((f) => grantFor(f) !== 'hidden'),
    [tabId, subtabId, grantFor],
  );

  // Repeatable sets render as numbered blocks; everything else fills the grid.
  const { repeats, plain } = useMemo(() => {
    const groups = new Map<string, Field[]>();
    const rest: Field[] = [];
    for (const f of fields) {
      if (f.repeatGroup) {
        const list = groups.get(f.repeatGroup.key) ?? [];
        list.push(f);
        groups.set(f.repeatGroup.key, list);
      } else rest.push(f);
    }
    return { repeats: [...groups.entries()], plain: rest };
  }, [fields]);

  if (!fields.length) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon="sliders"
          title={`No fields on ${describePlacement(placement)} yet`}
          body="An admin assigns fields to a tab in the Presets screen. Values already stored on the record are untouched."
        />
        <TabNotes record={record} scopeId={placement} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {plain.length ? (
        <FieldGrid record={record} moduleSlug={moduleSlug} fields={plain} placement={placement} />
      ) : null}

      {repeats.map(([key, template]) => (
        <RepeatGroup
          key={key}
          record={record}
          moduleSlug={moduleSlug}
          template={template}
          groupKey={key}
          max={template[0]!.repeatGroup!.max}
        />
      ))}

      <TabNotes record={record} scopeId={placement} />
    </div>
  );
}

/**
 * Two-to-three per row was the client's opening suggestion, not a fixed rule
 * — the actual ask is "use the space efficiently". A short field (a date, a
 * checkbox, a status pill) doesn't need the same width as an email address,
 * so cells flex-wrap at a basis chosen by the field's own type rather than
 * being forced into uniform CSS-grid columns: narrow fields pack three or
 * four to a row on a wide drawer, a `wide` field (percent-split, address,
 * long text, the typed grids) still takes the full row.
 */
const NARROW_FIELD_TYPES = new Set<Field['type']>([
  'checkbox', 'date', 'percentage', 'currency', 'number', 'identifier', 'status', 'dropdown',
]);

function basisFor(field: Field): string {
  if (field.wide) return '100%';
  return NARROW_FIELD_TYPES.has(field.type) ? '190px' : '250px';
}

function FieldGrid({
  record,
  moduleSlug,
  fields,
  placement,
}: {
  record: RecordRow;
  moduleSlug: string;
  fields: Field[];
  /** Tab id, or `tabId/subtabId` — the key `user_field_order` resolves against. */
  placement: string;
}) {
  const { fieldOrderFor, setFieldOrder, resetFieldOrder, hasCustomFieldOrder } = useStore();
  const [draggedId, setDraggedId] = useState<string | null>(null);

  /*
   * "Because the drawer is global, one personalization per tab covers every
   * module." `placement` alone is the key — no moduleSlug in it — so a user
   * who reorders Contact fields here sees that same order opening Contact
   * from Leads, Deals, anywhere.
   */
  const adminIds = fields.map((f) => f.id);
  const orderedIds = fieldOrderFor(placement, adminIds);
  const byId = new Map(fields.map((f) => [f.id, f]));
  const ordered = orderedIds.map((id) => byId.get(id)).filter((f): f is Field => Boolean(f));

  const moveField = (fromId: string, toId: string) => {
    if (fromId === toId) return;
    const ids = [...orderedIds];
    const from = ids.indexOf(fromId);
    const to = ids.indexOf(toId);
    if (from === -1 || to === -1) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    setFieldOrder(placement, ids);
  };

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white">
      {hasCustomFieldOrder(placement) ? (
        <div className="flex items-center gap-2 border-b border-line-soft bg-brand-50/60 px-3 py-1.5">
          <Icon name="shuffle" size={11} className="text-brand-600" />
          <span className="text-[11.5px] text-brand-700">
            Reordered by you — applies to this tab in every module.
          </span>
          <button
            type="button"
            onClick={() => resetFieldOrder(placement)}
            className="ml-auto text-[11.5px] font-semibold text-brand-700 hover:underline"
          >
            Reset to default
          </button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-stretch">
        {ordered.map((f) => (
          <div
            key={f.id}
            draggable
            onDragStart={() => setDraggedId(f.id)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (draggedId) moveField(draggedId, f.id);
              setDraggedId(null);
            }}
            onDragEnd={() => setDraggedId(null)}
            style={{ flex: `1 1 ${basisFor(f)}`, minWidth: basisFor(f) }}
            className={`border-b border-r border-line-soft bg-white last:border-r-0 ${draggedId === f.id ? 'opacity-40' : ''}`}
          >
            <FieldCell record={record} moduleSlug={moduleSlug} field={f} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * One field, label stacked above value.
 *
 * Label-on-the-left costs 150–240px per column; at three columns that is half
 * the drawer spent on labels. Stacking gives the value the full cell width and
 * is what makes three columns readable at all.
 */
function FieldCell({
  record,
  moduleSlug,
  field,
}: {
  record: RecordRow;
  moduleSlug: string;
  field: Field;
}) {
  const { grantFor, setValue, readValue, notesFor } = useStore();
  const [notesOpen, setNotesOpen] = useState(false);

  const grant = grantFor(field) as 'view' | 'edit';
  const value = readValue(record, field, moduleSlug);
  const notes = field.notes ? notesFor(record.id, 'field', field.id) : [];
  const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0);

  return (
    <div className="h-full bg-white px-3 py-2 transition-colors hover:bg-brand-50/40">
      <div className="group/label flex min-h-[18px] cursor-grab items-center gap-1.5 active:cursor-grabbing">
        <Icon
          name="shuffle"
          size={9}
          className="shrink-0 text-ink-300 opacity-0 transition-opacity group-hover/label:opacity-60"
          aria-hidden="true"
        />
        <span className="truncate text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
          {field.label}
        </span>
        {field.system ? <Icon name="lock" size={10} className="text-ink-400" /> : null}
        {field.sync ? (
          <Icon name="link" size={10} className="text-brand-600" aria-label="Sync-enabled" />
        ) : null}
        {field.placeholder ? (
          <Icon name="clock" size={10} className="text-[#c07714]" aria-label="Placeholder" />
        ) : null}
        {field.required && empty ? (
          <Icon name="alert-triangle" size={10} className="text-[#c07714]" />
        ) : null}

        <span className="ml-auto flex items-center gap-1">
          {field.notes ? (
            <button
              type="button"
              onClick={() => setNotesOpen((o) => !o)}
              title={`${notes.length} note${notes.length === 1 ? '' : 's'} on this field`}
              className={`inline-flex items-center gap-0.5 rounded px-1 py-px text-[10.5px] font-semibold transition-colors ${
                notes.length
                  ? 'bg-brand-50 text-brand-700 hover:bg-brand-100'
                  : 'text-ink-400 hover:bg-canvas hover:text-ink-700'
              }`}
            >
              <Icon name="sticky-note" size={10} />
              {notes.length || ''}
            </button>
          ) : null}
        </span>
      </div>

      <div className={field.required && empty ? 'border-l-2 border-[#c07714] pl-1' : ''}>
        <FieldRenderer
          field={field}
          value={value}
          grant={grant}
          moduleSlug={moduleSlug}
          onChange={(v) => setValue(record.id, field.id, v, moduleSlug)}
        />
      </div>

      {field.hint ? (
        <p className="px-1 pt-0.5 text-[11px] leading-snug text-ink-400">{field.hint}</p>
      ) : null}

      {notesOpen ? (
        <NoteThread
          recordId={record.id}
          scopeKind="field"
          scopeId={field.id}
          title={field.label}
          compact
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Repeatable groups                                                           */
/* -------------------------------------------------------------------------- */

/** `owner_1_first` → `owner_3_first`, and "Owner 1 title" → "Owner 3 title". */
function instanceOf(template: Field, n: number): Field {
  if (n === 1) return template;
  return {
    ...template,
    id: template.id.replace(/^([a-z]+)_1_/, `$1_${n}_`),
    label: template.label.replace(/\b1\b/, String(n)),
  };
}

function RepeatGroup({
  record,
  moduleSlug,
  template,
  groupKey,
  max,
}: {
  record: RecordRow;
  moduleSlug: string;
  template: Field[];
  groupKey: string;
  max: number;
}) {
  const { instanceCount, addInstance, removeInstance } = useStore();
  const count = instanceCount(record.id, groupKey);
  const atMax = count >= max;
  const singular = groupKey.charAt(0).toUpperCase() + groupKey.slice(1);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white">
      <header className="flex items-center gap-2 border-b border-line-soft px-3 py-2">
        <span className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-500">
          {singular}s
        </span>
        <CountPill n={count} />
        <span className="ml-auto">
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            disabled={atMax}
            title={atMax ? `Up to ${max} ${groupKey}s` : `Add another ${groupKey}`}
            onClick={() => addInstance(record.id, groupKey, max)}
          >
            Add {groupKey}
          </Button>
        </span>
      </header>

      {Array.from({ length: count }, (_, i) => i + 1).map((n) => (
        <div key={n} className="border-b border-line-soft last:border-0">
          <div className="flex items-center gap-2 bg-canvas/70 px-3 py-1">
            <span className="grid size-4 place-items-center rounded-full bg-brand-950 text-[10px] font-bold text-accent tabular">
              {n}
            </span>
            <span className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-500">
              {singular} {n}
            </span>
            <span className="ml-auto">
              {/* Instance 1 cannot be removed — a record always has one. */}
              {n > 1 ? (
                <IconButton
                  icon="trash"
                  tone="danger"
                  size={22}
                  title={`Remove ${groupKey} ${n}`}
                  onClick={() => removeInstance(record.id, groupKey, n)}
                />
              ) : (
                <span className="text-[10.5px] text-ink-400">Primary</span>
              )}
            </span>
          </div>
          <div className="flex flex-wrap items-stretch">
            {template.map((t) => {
              const f = instanceOf(t, n);
              return (
                <div
                  key={`${n}-${t.id}`}
                  style={{ flex: `1 1 ${basisFor(f)}`, minWidth: basisFor(f) }}
                  className="border-b border-r border-line-soft bg-white last:border-r-0"
                >
                  <FieldCell record={record} moduleSlug={moduleSlug} field={f} />
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {atMax ? (
        <p className="px-3 py-1.5 text-[11px] text-ink-400">
          The sheet caps this at {max} {groupKey}s.
        </p>
      ) : null}
    </section>
  );
}

/* ========================================================================== */
/* Notes — one component, two scopes                                           */
/* ========================================================================== */

/** "Each tab should have a notes field" — a collapsible thread per tab/subtab. */
function TabNotes({ record, scopeId }: { record: RecordRow; scopeId: string }) {
  const { notesFor } = useStore();
  const notes = notesFor(record.id, 'tab', scopeId);
  const [open, setOpen] = useState(false);

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-canvas"
      >
        <Icon name="sticky-note" size={13} className="text-ink-400" />
        <span className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-500">
          Tab notes
        </span>
        {notes.length ? <CountPill n={notes.length} /> : null}
        <Icon
          name="chevron-down"
          size={13}
          className={`ml-auto text-ink-400 transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
        />
      </button>
      {open ? (
        <div className="border-t border-line-soft px-3 pb-3">
          <NoteThread
            recordId={record.id}
            scopeKind="tab"
            scopeId={scopeId}
            title={describePlacement(scopeId)}
          />
        </div>
      ) : null}
    </section>
  );
}

function NoteThread({
  recordId,
  scopeKind,
  scopeId,
  title,
  compact,
}: {
  recordId: string;
  scopeKind: Note['scopeKind'];
  scopeId: string;
  title: string;
  compact?: boolean;
}) {
  const { notesFor, addNote, editNote, deleteNote, viewer, now } = useStore();
  const notes = notesFor(recordId, scopeKind, scopeId);
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const submit = () => {
    if (!draft.trim()) return;
    addNote(recordId, scopeKind, scopeId, draft.trim());
    setDraft('');
  };

  return (
    <div className={compact ? 'mt-1.5 rounded-lg border border-line bg-canvas p-2' : 'pt-2'}>
      <div className="space-y-1.5">
        {notes.length === 0 ? (
          <p className="text-[12px] text-ink-400">No notes on {title.toLowerCase()} yet.</p>
        ) : (
          notes.map((n) => {
            const author = USER_BY_ID.get(n.authorId);
            const mine = n.authorId === viewer.userId;
            return (
              <div key={n.id} className="rounded-md border border-line bg-white p-2">
                {editingId === n.id ? (
                  <>
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={2}
                      className="w-full resize-none rounded border border-line px-2 py-1.5 text-[13px] outline-none field-editing"
                    />
                    <div className="mt-1.5 flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        disabled={!editDraft.trim()}
                        onClick={() => {
                          editNote(n.id, editDraft.trim());
                          setEditingId(null);
                        }}
                      >
                        Save
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-[12.5px] leading-relaxed text-ink-700">{n.body}</p>
                    <div className="mt-1 flex items-center gap-1.5">
                      {author ? <Avatar user={author} size={15} /> : null}
                      <span className="text-[11px] text-ink-400">
                        {userName(n.authorId)} · {relative(n.at, now)}
                        {n.edited ? ' · edited' : ''}
                      </span>
                      {mine || viewer.isAdmin ? (
                        <span className="ml-auto flex gap-0.5">
                          {mine ? (
                            <IconButton
                              icon="pencil"
                              size={20}
                              title="Edit this note"
                              onClick={() => {
                                setEditingId(n.id);
                                setEditDraft(n.body);
                              }}
                            />
                          ) : null}
                          <IconButton
                            icon="trash"
                            size={20}
                            tone="danger"
                            title={mine ? 'Delete this note' : 'Delete as admin'}
                            onClick={() => deleteNote(n.id)}
                          />
                        </span>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            );
          })
        )}
      </div>

      <div className="mt-1.5 flex gap-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Add a note…"
          className="flex-1 rounded-md border border-line bg-white px-2 py-1.5 text-[12.5px] outline-none transition-colors focus-field"
        />
        <Button size="sm" icon="plus" disabled={!draft.trim()} onClick={submit}>
          Add
        </Button>
      </div>
    </div>
  );
}

/* ========================================================================== */
/* The "Other" tab — per-record entries, not schema fields                     */
/* ========================================================================== */

export function OtherTab({ record }: { record: RecordRow }) {
  const { entriesFor, addEntry, updateEntry, deleteEntry, now } = useStore();
  const entries = entriesFor(record.id);
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');

  const add = () => {
    if (!label.trim()) return;
    addEntry(record.id, label.trim(), value.trim());
    setLabel('');
    setValue('');
  };

  return (
    <div className="space-y-4">
      <SpecNote>
        Anything here belongs to <strong>this record only</strong>. It is not a field: adding one
        does not put it on every other merchant, and because there is no definition behind it, it
        cannot be filtered, sorted or used as a dashboard column. Access follows this tab’s own
        permission.
      </SpecNote>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-[minmax(140px,1fr)_2fr_auto] gap-3 border-b border-line-soft bg-canvas px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
          <span>Label</span>
          <span>Information</span>
          <span />
        </div>

        {entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-ink-400">
            Nothing added to this record yet.
          </p>
        ) : (
          <div className="divide-y divide-[#f0f4f8]">
            {entries.map((e) => (
              <EntryRow key={e.id} entry={e} onSave={updateEntry} onDelete={deleteEntry} now={now} />
            ))}
          </div>
        )}

        <div className="grid grid-cols-[minmax(140px,1fr)_2fr_auto] items-center gap-3 border-t border-line-soft bg-canvas/50 px-3 py-2">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. Gate code"
            className="rounded-md border border-line bg-white px-2 py-1.5 text-[13px] outline-none focus-field"
          />
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder="e.g. #4471 — rear loading bay"
            className="rounded-md border border-line bg-white px-2 py-1.5 text-[13px] outline-none focus-field"
          />
          <Button size="sm" icon="plus" disabled={!label.trim()} onClick={add}>
            Add
          </Button>
        </div>
      </section>

      <TabNotes record={record} scopeId="other" />
    </div>
  );
}

function EntryRow({
  entry,
  onSave,
  onDelete,
  now,
}: {
  entry: CustomEntry;
  onSave: (id: string, label: string, value: string) => void;
  onDelete: (id: string) => void;
  now: Date;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(entry.label);
  const [value, setValue] = useState(entry.value);

  if (editing) {
    return (
      <div className="grid grid-cols-[minmax(140px,1fr)_2fr_auto] items-center gap-3 px-3 py-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-[13px] outline-none field-editing"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="rounded-md border border-line px-2 py-1.5 text-[13px] outline-none field-editing"
        />
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            icon="check"
            onClick={() => {
              onSave(entry.id, label, value);
              setEditing(false);
            }}
          >
            Save
          </Button>
        </span>
      </div>
    );
  }

  return (
    <div className="group grid grid-cols-[minmax(140px,1fr)_2fr_auto] items-center gap-3 px-3 py-2 transition-colors hover:bg-brand-50/40">
      <span className="truncate text-[13px] font-medium text-ink-900">{entry.label}</span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] text-ink-700">{entry.value || '—'}</span>
        <span className="block text-[11px] text-ink-400">
          {userName(entry.createdBy)} · {relative(entry.at, now)}
        </span>
      </span>
      <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <IconButton icon="pencil" size={24} title="Edit" onClick={() => setEditing(true)} />
        <IconButton icon="trash" size={24} tone="danger" title="Remove" onClick={() => onDelete(entry.id)} />
      </span>
    </div>
  );
}

/* ========================================================================== */
/* Communication                                                               */
/* ========================================================================== */

export function CommunicationTab({ record, subtabId }: { record: RecordRow; subtabId: string }) {
  const { now } = useStore();

  if (subtabId === 'teams') return <ComingSoon what="Microsoft Teams meetings" icon="video" />;
  if (subtabId === 'phone') return <ComingSoon what="Twilio call log" icon="phone" />;
  if (subtabId === 'recordings') return <ComingSoon what="Twilio call recordings" icon="mic" />;

  const channel = subtabId === 'text' ? 'text' : subtabId === 'instantly' ? 'instantly' : 'email';
  const messages = MESSAGES.filter((m) => m.recordId === record.id && m.channel === channel).sort(
    (a, b) => (a.at < b.at ? 1 : -1),
  );

  return (
    <div className="space-y-3">
      <LastMessageReceived record={record} />

      <SpecNote>
        Inbound messages land on a record by matching the sender against{' '}
        <strong>sync-enabled</strong> Email and Phone fields. If an identity matches several records
        the message deposits into <strong>all</strong> of them; if the sender already exists, no new
        record is ever created. Sync is forward-only — no historical backfill.
      </SpecNote>

      {messages.length === 0 ? (
        <EmptyState
          icon={CHANNEL_ICON[channel]}
          title="No messages yet"
          body="Nothing has arrived on this channel."
        />
      ) : (
        <ul className="space-y-2">
          {messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-xl border p-3 transition-colors ${
                m.direction === 'in' ? 'border-line bg-white' : 'border-brand-100 bg-brand-50/60'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                {/* Origin is always labelled — Outlook and Instantly must never
                    be mistaken for each other. */}
                <StatusPill
                  label={m.channel === 'instantly' ? 'Instantly' : m.channel === 'text' ? 'SMS' : 'Outlook'}
                  swatch={m.channel === 'instantly' ? 'purple' : m.channel === 'text' ? 'teal' : 'blue'}
                  dot={false}
                />
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-700">
                  <Icon name={m.direction === 'in' ? 'reply' : 'send'} size={12} className="text-ink-400" />
                  {m.direction === 'in' ? m.from : `to ${m.to}`}
                </span>
                <span className="ml-auto text-[11.5px] text-ink-400 tabular">
                  {formatDateTime(m.at)}
                </span>
              </div>
              {m.subject ? (
                <p className="mt-2 text-[13.5px] font-semibold text-ink-900">{m.subject}</p>
              ) : null}
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-700">{m.body}</p>
              <p className="mt-1.5 text-[11.5px] text-ink-400">{relative(m.at, now)}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * "Last message received" — a display field at the top of Communication.
 *
 * Derived, not stored, so it renders as a panel rather than a field in the
 * engine. It looks across every channel, because "have they replied at all"
 * does not care whether the reply came by email or by text.
 */
function LastMessageReceived({ record }: { record: RecordRow }) {
  const { now } = useStore();
  const last = MESSAGES.filter((m) => m.recordId === record.id && m.direction === 'in').sort(
    (a, b) => (a.at < b.at ? 1 : -1),
  )[0];

  if (!last) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-dashed border-line bg-white/60 px-3.5 py-2.5">
        <Icon name="reply" size={15} className="text-ink-400" />
        <span className="text-[12.5px] font-semibold uppercase tracking-[.06em] text-ink-400">
          Last message received
        </span>
        <span className="text-[13px] text-ink-400">
          Nothing inbound yet — every message on this record was sent by us.
        </span>
      </div>
    );
  }

  const stale = now.getTime() - new Date(last.at).getTime() > 14 * 86_400_000;

  return (
    <div className="rounded-xl border border-line bg-white p-3.5 shadow-[0_1px_2px_rgba(8,32,47,.04)]">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="reply" size={15} className="text-brand-600" />
        <span className="text-[12.5px] font-semibold uppercase tracking-[.06em] text-ink-400">
          Last message received
        </span>
        <StatusPill
          label={last.channel === 'instantly' ? 'Instantly' : last.channel === 'text' ? 'SMS' : 'Outlook'}
          swatch={last.channel === 'instantly' ? 'purple' : last.channel === 'text' ? 'teal' : 'blue'}
          dot={false}
        />
        <span className="ml-auto flex items-center gap-2">
          {stale ? <OutlineChip tone="warn">No reply in 2 weeks</OutlineChip> : null}
          <span className="text-[11.5px] text-ink-400 tabular">{relative(last.at, now)}</span>
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-[13.5px] leading-relaxed text-ink-900">{last.body}</p>
      <p className="mt-1 text-[11.5px] text-ink-400">
        {last.from} · {formatDateTime(last.at)}
      </p>
    </div>
  );
}

/* ========================================================================== */
/* Updates                                                                     */
/* ========================================================================== */

export function UpdatesTab({ record }: { record: RecordRow }) {
  const { updates, addUpdate, now, viewer } = useStore();
  const [draft, setDraft] = useState('');

  const threads = useMemo(() => {
    const mine = updates.filter((u) => u.recordId === record.id);
    const roots = mine.filter((u) => !u.parentId).sort((a, b) => (a.at < b.at ? 1 : -1));
    return roots.map((root) => ({
      root,
      replies: mine.filter((u) => u.parentId === root.id).sort((a, b) => (a.at < b.at ? -1 : 1)),
    }));
  }, [updates, record.id]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-line bg-white p-3">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={2}
          placeholder="Write an update…  @mention a team member to notify them"
          className="w-full resize-none rounded-lg border border-line px-3 py-2 text-[13.5px] outline-none transition-colors focus-field"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <p className="text-[11.5px] text-ink-400">
            Rich text. Replies go exactly one level deep — no replies to replies.
          </p>
          <Button
            variant="primary"
            size="sm"
            icon="send"
            disabled={!draft.trim()}
            onClick={() => {
              addUpdate(record.id, draft.trim());
              setDraft('');
            }}
          >
            Post update
          </Button>
        </div>
      </div>

      {threads.length === 0 ? (
        <EmptyState icon="message-square" title="No updates yet" body="Team notes appear here." />
      ) : (
        <ul className="space-y-2">
          {threads.map(({ root, replies }) => (
            <Thread key={root.id} root={root} replies={replies} now={now} viewerId={viewer.userId} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Thread({
  root,
  replies,
  now,
  viewerId,
}: {
  root: Update;
  replies: Update[];
  now: Date;
  viewerId: string;
}) {
  // Collapsed by default: the pane shows each thread's first message only.
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const { addUpdate } = useStore();
  const author = USER_BY_ID.get(root.authorId);

  return (
    <li className="rounded-xl border border-line bg-white p-3">
      <div className="flex gap-3">
        {author ? <Avatar user={author} size={26} /> : null}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-semibold text-ink-900">{userName(root.authorId)}</span>
            <span className="text-[11.5px] text-ink-400">{relative(root.at, now)}</span>
            {root.edited ? <span className="text-[11.5px] text-ink-400">(edited)</span> : null}
            {root.authorId === viewerId ? (
              <span className="ml-auto flex gap-0.5">
                <IconButton icon="pencil" size={22} title="Edit your update" />
                <IconButton icon="trash" size={22} tone="danger" title="Delete your update" />
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-[13.5px] leading-relaxed text-ink-700">{root.body}</p>
          {root.mentions?.length ? (
            <p className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-brand-700">
              <Icon name="bell" size={11} />@{userName(root.mentions[0]!)} was notified
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline"
          >
            <Icon
              name="chevron-down"
              size={12}
              className={`transition-transform duration-200 ${open ? '' : '-rotate-90'}`}
            />
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </button>

          {open ? (
            <div className="mt-2 space-y-2 border-l-2 border-line pl-3">
              {replies.map((r) => (
                <div key={r.id}>
                  <div className="flex items-baseline gap-2">
                    <span className="text-[12.5px] font-semibold text-ink-900">
                      {userName(r.authorId)}
                    </span>
                    <span className="text-[11.5px] text-ink-400">{relative(r.at, now)}</span>
                  </div>
                  <p className="text-[13px] leading-relaxed text-ink-700">{r.body}</p>
                </div>
              ))}
              <div className="flex gap-2 pt-1">
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Reply…"
                  className="flex-1 rounded-md border border-line px-2 py-1.5 text-[13px] outline-none transition-colors focus-field"
                />
                <Button
                  size="sm"
                  icon="reply"
                  disabled={!draft.trim()}
                  onClick={() => {
                    addUpdate(root.recordId, draft.trim(), root.id);
                    setDraft('');
                  }}
                >
                  Reply
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </li>
  );
}

/* ========================================================================== */
/* Cases                                                                       */
/* ========================================================================== */

export function CasesTab({ record }: { record: RecordRow }) {
  const { cases, addCase, now } = useStore();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [issue, setIssue] = useState('');

  const mine = cases.filter((c) => c.recordId === record.id);
  const open = mine.filter((c) => c.state === 'open').length;

  return (
    <div className="space-y-4">
      <SpecNote>
        Case numbers come from a <strong>single global sequence starting at #10000</strong> spanning
        the whole CRM, so a number identifies exactly one case anywhere. Numbers are never reused,
        even after a purge. Case content is <strong>immutable to non-admins</strong> — including its
        own author — but anyone can reply.
      </SpecNote>

      {creating ? (
        <div className="rounded-xl border border-line bg-white p-3">
          <SectionLabel>New case</SectionLabel>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Short title"
            className="mt-2 w-full rounded-md border border-line px-3 py-2 text-[13.5px] outline-none transition-colors focus-field"
          />
          <label className="mt-3 flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-400">
            Issue
            <span className="inline-flex items-center gap-1 text-[#c07714]">
              <Icon name="alert-triangle" size={11} />
              required
            </span>
          </label>
          <textarea
            value={issue}
            onChange={(e) => setIssue(e.target.value)}
            rows={3}
            placeholder="Describe the problem. This cannot be edited once saved."
            className="mt-1 w-full resize-none rounded-md border border-line px-3 py-2 text-[13.5px] outline-none transition-colors focus-field"
          />
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              icon="flag"
              // A thread cannot be created without a filled Issue.
              disabled={!issue.trim() || !title.trim()}
              onClick={() => {
                addCase(record.id, title.trim(), issue.trim());
                setTitle('');
                setIssue('');
                setCreating(false);
              }}
            >
              Open case
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <Button variant="primary" size="sm" icon="plus" onClick={() => setCreating(true)}>
            Open a case
          </Button>
          {mine.length ? (
            <span className="text-[12.5px] text-ink-400 tabular">
              {mine.length} total · {open} open
            </span>
          ) : null}
        </div>
      )}

      {mine.length === 0 ? (
        <EmptyState icon="flag" title="No cases on this record" />
      ) : (
        <ul className="space-y-3">
          {mine.map((c) => (
            <CaseCard key={c.id} c={c} now={now} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CaseCard({ c, now }: { c: CaseThread; now: Date }) {
  const { toggleCaseState, setCaseSolution, addCaseReply, viewer } = useStore();
  const [solutionDraft, setSolutionDraft] = useState('');
  const [writing, setWriting] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  // Open cases start expanded — they are the ones being worked.
  const [expanded, setExpanded] = useState(c.state === 'open');

  const isManager = c.managerIds.includes(viewer.userId);
  const canClose = Boolean(c.solution);

  const sendReply = () => {
    if (!replyDraft.trim()) return;
    addCaseReply(c.id, replyDraft.trim());
    setReplyDraft('');
  };

  return (
    <li className="overflow-hidden rounded-xl border border-line bg-white">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full flex-wrap items-center gap-2 border-b border-line-soft bg-canvas px-4 py-2.5 text-left transition-colors hover:bg-[#eef3f7]"
      >
        <Icon
          name="chevron-down"
          size={13}
          className={`text-ink-400 transition-transform duration-200 ${expanded ? '' : '-rotate-90'}`}
        />
        <span className="font-mono text-[12.5px] font-semibold text-ink-500 tabular">#{c.number}</span>
        <span className="text-[13.5px] font-semibold text-ink-900">{c.title}</span>
        <span className="ml-auto flex items-center gap-2">
          {c.replies.length ? (
            <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-400">
              <Icon name="message-square" size={11} />
              {c.replies.length}
            </span>
          ) : null}
          <CaseStatePill state={c.state} />
        </span>
      </button>

      {expanded ? (
        <>
          <div className="space-y-3 px-4 py-3">
            <div>
              <SectionLabel>Issue</SectionLabel>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-700">{c.issue}</p>
              <p className="mt-1 text-[11.5px] text-ink-400">
                {userName(c.issueAuthorId)} · {relative(c.issueAt, now)}
                {c.editedBy ? ` · edited by ${userName(c.editedBy)}` : ''}
              </p>
            </div>

            <div>
              <SectionLabel>Solution</SectionLabel>
              {c.solution ? (
                <>
                  <p className="mt-1 text-[13.5px] leading-relaxed text-ink-700">{c.solution}</p>
                  <p className="mt-1 text-[11.5px] text-ink-400">
                    {c.solutionAuthorId ? userName(c.solutionAuthorId) : ''} ·{' '}
                    {c.solutionAt ? relative(c.solutionAt, now) : ''}
                  </p>
                </>
              ) : writing ? (
                <div className="mt-1">
                  <textarea
                    value={solutionDraft}
                    onChange={(e) => setSolutionDraft(e.target.value)}
                    rows={3}
                    className="w-full resize-none rounded-md border border-line px-3 py-2 text-[13.5px] outline-none transition-colors focus-field"
                  />
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={() => setWriting(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      icon="check"
                      disabled={!solutionDraft.trim()}
                      onClick={() => {
                        setCaseSolution(c.id, solutionDraft.trim());
                        setWriting(false);
                      }}
                    >
                      Save solution
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-3">
                  <span className="text-[13px] text-ink-400">Not written yet.</span>
                  {isManager ? (
                    <button
                      type="button"
                      onClick={() => setWriting(true)}
                      className="text-[12.5px] font-semibold text-brand-700 hover:underline"
                    >
                      Write the solution
                    </button>
                  ) : null}
                </div>
              )}
            </div>

            {/* Replies — one level deep, not editable once posted. */}
            <div>
              <SectionLabel>Replies</SectionLabel>
              {c.replies.length ? (
                <div className="mt-1 space-y-2 border-l-2 border-line pl-3">
                  {c.replies.map((r) => {
                    const author = USER_BY_ID.get(r.authorId);
                    return (
                      <div key={r.id} className="flex gap-2">
                        {author ? <Avatar user={author} size={20} /> : null}
                        <div className="min-w-0 flex-1">
                          <p className="text-[13px] leading-relaxed text-ink-700">{r.body}</p>
                          <p className="text-[11px] text-ink-400">
                            {userName(r.authorId)} · {relative(r.at, now)} · not editable
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-1 text-[12.5px] text-ink-400">No replies yet.</p>
              )}

              <div className="mt-2 flex gap-2">
                <input
                  value={replyDraft}
                  onChange={(e) => setReplyDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendReply()}
                  placeholder={
                    c.state === 'open' ? 'Reply to this case…' : 'Reply — the case is closed'
                  }
                  className="flex-1 rounded-md border border-line px-2.5 py-1.5 text-[13px] outline-none transition-colors focus-field"
                />
                <Button size="sm" icon="reply" disabled={!replyDraft.trim()} onClick={sendReply}>
                  Reply
                </Button>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-line-soft px-4 py-2.5">
            <span className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
              Ticket managers
            </span>
            <span className="flex -space-x-1.5">
              {c.managerIds.map((id) => {
                const u = USER_BY_ID.get(id);
                return u ? <Avatar key={id} user={u} /> : null;
              })}
            </span>
            {c.files ? <OutlineChip icon="paperclip">{c.files} files</OutlineChip> : null}
            <div className="ml-auto">
              <Button
                size="sm"
                icon={c.state === 'open' ? 'check' : 'rotate-ccw'}
                variant={c.state === 'open' ? 'secondary' : 'ghost'}
                // Only an assigned ticket manager can toggle, and a case cannot
                // be closed until its Solution has been written.
                disabled={!isManager || (c.state === 'open' && !canClose)}
                title={
                  !isManager
                    ? 'Only an assigned ticket manager can change the state'
                    : c.state === 'open' && !canClose
                      ? 'Write the Solution before closing'
                      : undefined
                }
                onClick={() => toggleCaseState(c.id)}
              >
                {c.state === 'open' ? 'Close case' : 'Reopen case'}
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </li>
  );
}

/* ========================================================================== */
/* Files                                                                       */
/* ========================================================================== */

export function FilesTab({ record, subtabId }: { record: RecordRow; subtabId: string }) {
  const kind = subtabId === 'other' ? 'other' : 'application';
  const rows = FILES.filter((f) => f.recordId === record.id && f.kind === kind);
  const complete = FILES.filter(
    (f) => f.recordId === record.id && f.kind === 'application' && f.files.length > 0,
  ).length;

  return (
    <div className="space-y-3">
      {kind === 'application' ? (
        <div className="flex flex-wrap items-center gap-3">
          <SectionLabel>Application documents</SectionLabel>
          <CompletenessBadge have={complete} need={APPLICATION_ROWS.length} />
          <span className="text-[12px] text-ink-400">
            Locked rows — defined as a system structure in the Presets screen
          </span>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-[minmax(130px,.8fr)_2.4fr_minmax(130px,.9fr)] gap-3 border-b border-line-soft bg-canvas px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
          <span>File name</span>
          <span>File upload</span>
          <span>File notes</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-ink-400">
            No files in this section.
          </p>
        ) : (
          <div className="divide-y divide-[#f0f4f8]">
            {rows.map((r) => (
              <FileRowView key={r.id} row={r} />
            ))}
          </div>
        )}
      </div>

      <Button size="sm" variant="ghost" icon="plus">
        Add another file row
      </Button>
      <p className="text-[11.5px] text-ink-400">
        Up to 5 files per row, 25MB each. Replacing a file keeps the previous version. Deleting a
        file is a soft delete to the Recycle Bin.
      </p>

      <TabNotes record={record} scopeId="files" />
    </div>
  );
}

/**
 * One file row.
 *
 * The client: "When there are multiple files for one field the width should be
 * condensed and it should be on one row as opposed to a new row." So the files
 * flow horizontally and wrap, each shrunk to its name — five files now occupy
 * one line instead of five.
 */
function FileRowView({ row }: { row: FileRow }) {
  return (
    <div className="grid grid-cols-[minmax(130px,.8fr)_2.4fr_minmax(130px,.9fr)] items-start gap-3 px-3 py-2">
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <span className="text-[13px] font-medium text-ink-900">{row.name}</span>
        {row.locked ? <Icon name="lock" size={10} className="text-ink-400" /> : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {row.files.length === 0 ? (
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-line px-2.5 py-1 text-[12px] text-ink-400 transition-colors hover:border-brand-600 hover:text-brand-700"
          >
            <Icon name="upload" size={12} />
            Drop a file, or click to upload
          </button>
        ) : (
          <>
            {row.files.map((file) => (
              <span
                key={file.name}
                title={`${file.name} · ${file.size}`}
                className="inline-flex max-w-[190px] items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-[3px] text-[11.5px] transition-colors hover:border-ink-400 hover:bg-white"
              >
                <Icon name="file-text" size={11} className="text-ink-400" />
                <span className="truncate text-ink-700">{file.name}</span>
                {file.version && file.version > 1 ? (
                  <span className="shrink-0 rounded bg-white px-1 text-[10px] font-semibold text-ink-500">
                    v{file.version}
                  </span>
                ) : null}
              </span>
            ))}
            {row.files.length < 5 ? (
              <button
                type="button"
                title={`${row.files.length} of 5 files`}
                className="inline-flex items-center gap-1 rounded-md border border-dashed border-line px-1.5 py-[3px] text-[11.5px] font-semibold text-brand-700 transition-colors hover:border-brand-600 hover:bg-brand-50"
              >
                <Icon name="plus" size={10} />
                {row.files.length}/5
              </button>
            ) : null}
          </>
        )}
      </div>

      <p className="pt-1 text-[12px] leading-snug text-ink-500">
        {row.note ?? <span className="text-ink-400/70">—</span>}
      </p>
    </div>
  );
}

/* ========================================================================== */
/* Logins                                                                      */
/* ========================================================================== */

export function LoginsTab({ record }: { record: RecordRow }) {
  const rows = LOGINS.filter((l) => l.recordId === record.id);
  return (
    <div className="space-y-3">
      <SpecNote>
        Passwords are stored with <strong>envelope encryption</strong> and are never recoverable by
        reading the database. Every reveal is written to the audit log with user, credential and
        timestamp. Credentials are excluded from every export and reporting surface.
      </SpecNote>

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-[1fr_1.4fr_1.4fr_1.1fr_1fr] gap-3 border-b border-line-soft bg-canvas px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
          <span>Login type</span>
          <span>Login link</span>
          <span>Login user</span>
          <span>Login pass</span>
          <span>Login notes</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-ink-400">
            No credentials stored on this record.
          </p>
        ) : (
          <div className="divide-y divide-[#f0f4f8]">
            {rows.map((row) => (
              <CredentialRow key={row.id} recordId={record.id} row={row} />
            ))}
          </div>
        )}
      </div>
      <Button size="sm" variant="ghost" icon="plus">
        Add a login
      </Button>

      <TabNotes record={record} scopeId="logins" />
    </div>
  );
}

function CredentialRow({ recordId, row }: { recordId: string; row: import('../schema').LoginRow }) {
  const { logCredentialReveal } = useStore();
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <div className="grid grid-cols-[1fr_1.4fr_1.4fr_1.1fr_1fr] items-center gap-3 px-3 py-2 text-[13px]">
      <span className="flex items-center gap-1.5 font-medium text-ink-900">
        <Icon name="key" size={12} className="text-ink-400" />
        {row.type}
      </span>
      <a
        href={row.link}
        target="_blank"
        rel="noreferrer"
        className="inline-flex min-w-0 items-center gap-1 text-brand-700 hover:underline"
      >
        <span className="truncate">{row.link.replace(/^https:\/\//, '')}</span>
        <Icon name="external-link" size={10} className="shrink-0 opacity-60" />
      </a>
      <span className="truncate text-ink-700">{row.user}</span>
      <span className="flex items-center gap-1">
        <span className="font-mono text-[12px] tabular">{revealed ? row.pass : '••••••••'}</span>
        <IconButton
          icon={revealed ? 'eye-off' : 'eye'}
          size={22}
          title={revealed ? 'Hide password' : 'Reveal password — this is audit-logged'}
          onClick={() => {
            if (!revealed) logCredentialReveal(recordId, row.type);
            setRevealed((r) => !r);
          }}
        />
        <IconButton
          icon={copied ? 'check' : 'copy'}
          size={22}
          title="Copy without revealing"
          /* Awaited, then reported — never the other way round. `void
             writeText(...)` swallows the rejection, so the tick appeared
             whether or not anything reached the clipboard. The real Logins
             panel had the same bug; this is the prototype the client is
             shown, so it has to tell the truth too. */
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(row.pass);
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            } catch {
              setCopied(false);
            }
          }}
        />
      </span>
      <span className="truncate text-[12px] text-ink-500">
        {row.note ?? <span className="text-ink-400/70">—</span>}
      </span>
    </div>
  );
}

/* ========================================================================== */
/* Statements                                                                  */
/* ========================================================================== */

export function StatementsTab({ record }: { record: RecordRow }) {
  const [year, setYear] = useState(2026);
  const rows = STATEMENTS.filter((s) => s.recordId === record.id);

  // 2024 shows July–December only. The start point is fixed and never moves.
  const months = year === 2024 ? MONTH_NAMES.slice(6) : MONTH_NAMES;
  const offset = year === 2024 ? 7 : 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>Statements</SectionLabel>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded-md border border-line bg-white px-2 py-1 text-[13px] tabular outline-none transition-colors focus-field"
        >
          {STATEMENT_YEARS.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-ink-400">
          Month rows are prebuilt July 2024 – December 2032 and cannot be created or deleted here.
        </span>
      </div>

      {/* Two columns of months — twelve stacked rows wasted most of the width. */}
      <div className="grid gap-2 md:grid-cols-2">
        {months.map((m, i) => {
          const period = `${year}-${String(i + offset).padStart(2, '0')}`;
          const entry = rows.find((r) => r.period === period);
          return (
            <div
              key={period}
              className="flex items-center gap-2 rounded-lg border border-line bg-white px-3 py-2"
            >
              <span className="w-[74px] shrink-0 text-[12.5px] font-medium text-ink-700 tabular">
                {monthLabel(period)}
              </span>
              {entry ? (
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  {entry.files.map((file) => (
                    <span
                      key={file.name}
                      title={`${file.name} · ${file.size}`}
                      className="inline-flex max-w-[180px] items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-[3px] text-[11.5px]"
                    >
                      <Icon name="file-text" size={11} className="text-ink-400" />
                      <span className="truncate">{file.name}</span>
                    </span>
                  ))}
                  <IconButton icon="plus" size={22} title="Add another file" />
                </span>
              ) : (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-line px-2 py-1 text-[11.5px] text-ink-400 transition-colors hover:border-brand-600 hover:text-brand-700"
                >
                  <Icon name="upload" size={11} />
                  Upload
                </button>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11.5px] text-ink-400">
        One dataset shown in every module — a file uploaded here is instantly present everywhere
        else this record appears.
      </p>

      <TabNotes record={record} scopeId="statements" />
    </div>
  );
}

/* ========================================================================== */
/* Activity                                                                    */
/* ========================================================================== */

export function ActivityTab({ record }: { record: RecordRow }) {
  const { activity, now, grantFor } = useStore();

  /** A Hidden field is hidden everywhere — including in the log. */
  const hiddenLabels = useMemo(
    () => new Set(FIELDS.filter((f) => grantFor(f) === 'hidden').map((f) => f.label)),
    [grantFor],
  );

  const entries = activity
    .filter((a) => a.recordId === record.id)
    .filter((a) => a.kind !== 'field' || !hiddenLabels.has(a.summary.replace(/ changed$/, '')))
    .sort((a, b) => (a.at < b.at ? 1 : -1));

  return (
    <div className="space-y-3">
      <SpecNote>
        The log belongs to the record and runs unbroken across its whole life. Adding or removing a
        module is an <strong>entry in</strong> this timeline, never a reset of it. Entries about
        fields you cannot see are suppressed for you.
      </SpecNote>
      <ul className="space-y-1">
        {entries.map((a) => (
          <li
            key={a.id}
            className="flex items-start gap-3 rounded-lg border border-line bg-white px-3 py-2 transition-colors hover:border-ink-400/40"
          >
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-canvas text-ink-400">
              <Icon name={(ACTIVITY_ICON[a.kind] ?? 'circle-dot') as IconName} size={11} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13.5px] text-ink-900">{a.summary}</p>
              {a.from || a.to ? (
                <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-500">
                  <span className="text-ink-400 line-through">{a.from}</span>
                  <Icon name="arrow-right" size={11} className="text-ink-400" />
                  <span className="font-medium">{a.to}</span>
                </p>
              ) : null}
              <p className="mt-0.5 text-[11.5px] text-ink-400">
                {userName(a.actorId)} · {relative(a.at, now)}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export { choicesFor, CAMPAIGN_BY_ID };
