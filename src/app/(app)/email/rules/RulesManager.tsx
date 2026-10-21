'use client';

/**
 * Outlook rules for one mailbox: the same list Outlook shows, in the order
 * Outlook runs it. On/off, move up/down, edit, delete, and a new-rule editor
 * covering every condition and action Microsoft exposes. Changes are written
 * to Outlook at once; the list is then re-read from Outlook.
 */
import Link from 'next/link';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { Button, Dialog, NumberInput, Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { parseRecipients } from '@/lib/mail/compose/recipients';
import {
  ACTIONS,
  ACTION_FLAGS,
  ACTION_FLAG_LABEL,
  IMPORTANCE,
  PREDICATES,
  SENSITIVITY,
  blankValue,
  entryFor,
  summary,
  validate,
  type Row,
  type RowValue,
  type RuleForm,
} from '@/lib/mail/rules/model';
import type { RuleView } from '@/lib/mail/rules/server';
import { deleteRuleAction, reorderRulesAction, rulesAction, saveRuleAction, toggleRuleAction, type RuleFolder, type RulesSnapshot } from './ruleActions';

type Section = 'conditions' | 'exceptions' | 'actions';
type Note = { tone: 'ok' | 'error' | 'warn'; text: string } | null;

const EMPTY: RuleForm = { name: '', enabled: true, conditions: [], exceptions: [], actions: [], extra: { conditions: {}, exceptions: {}, actions: {} } };

export function RulesManager({ mailboxId, address, initial, canEdit }: { mailboxId: string; address: string; initial: RulesSnapshot; canEdit: boolean }) {
  const [snap, setSnap] = useState(initial);
  const [note, setNote] = useState<Note>(initial.stale ? { tone: 'warn', text: `Showing the last copy from Outlook. ${initial.stale}` } : null);
  const [editing, setEditing] = useState<{ graphId: string | null; form: RuleForm } | null>(null);
  const [deleting, setDeleting] = useState<RuleView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, startRefresh] = useTransition();

  const folderName = useMemo(() => {
    const m = new Map(snap.folders.map((f) => [f.graphId, f.name]));
    return (id: string) => m.get(id) ?? 'a folder no longer here';
  }, [snap.folders]);

  const apply = (r: Awaited<ReturnType<typeof rulesAction>>, ok?: string) => {
    if (r.ok) {
      setSnap(r.data);
      setNote(ok ? { tone: 'ok', text: ok } : r.data.stale ? { tone: 'warn', text: `Showing the last copy from Outlook. ${r.data.stale}` } : null);
      return true;
    }
    setNote({ tone: 'error', text: r.message });
    return false;
  };

  // Outlook stays the source: re-read every minute while the screen is open and visible.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void rulesAction({ mailboxId }).then((r) => r.ok && setSnap(r.data));
    }, 60_000);
    return () => clearInterval(t);
  }, [mailboxId]);

  const move = async (index: number, by: -1 | 1) => {
    const order = snap.rules.map((r) => r.graphId);
    const [it] = order.splice(index, 1);
    order.splice(index + by, 0, it);
    setBusy(it);
    const r = await reorderRulesAction({ mailboxId, order });
    setBusy(null);
    if (!apply(r)) void rulesAction({ mailboxId, refresh: true }).then((x) => x.ok && setSnap(x.data));
  };

  if (editing) {
    return (
      <RuleEditor
        initial={editing.form}
        isNew={!editing.graphId}
        folders={snap.folders}
        onCancel={() => setEditing(null)}
        onSave={async (form) => {
          const r = await saveRuleAction({ mailboxId, graphId: editing.graphId, form });
          if (!r.ok) return r.message;
          setEditing(null);
          apply(r, editing.graphId ? `Saved “${form.name.trim()}” in Outlook.` : `Created “${form.name.trim()}” in Outlook.`);
          return null;
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex items-center gap-1.5 text-[12.5px] text-ink-400">
          {refreshing ? <Spinner /> : <Icon name="refresh-cw" size={12} />}
          {snap.syncedAt ? `Read from Outlook at ${new Date(snap.syncedAt).toTimeString().slice(0, 5)}` : 'Not read from Outlook yet'}
          <button
            type="button"
            onClick={() => startRefresh(async () => void apply(await rulesAction({ mailboxId, refresh: true })))}
            className="font-semibold text-ink-500 hover:text-ink-900"
          >
            Refresh
          </button>
        </p>
        {canEdit ? (
          <span className="ml-auto">
            <Button variant="primary" icon="plus" onClick={() => setEditing({ graphId: null, form: EMPTY })}>
              New rule
            </Button>
          </span>
        ) : null}
      </div>

      {note ? (
        <p
          role={note.tone === 'error' ? 'alert' : 'status'}
          className={`flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-[13px] font-medium ${
            note.tone === 'error'
              ? 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]'
              : note.tone === 'warn'
                ? 'border-[#f5e2b8] bg-[#fdf6e7] text-[#8a5a00]'
                : 'border-[#c5ecd0] bg-[#e3f6e8] text-[#1a7a3c]'
          }`}
        >
          <span className="flex-1">{note.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNote(null)} className="opacity-60 hover:opacity-100">
            <Icon name="x" size={13} />
          </button>
        </p>
      ) : null}

      {snap.rules.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center">
          <span className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-canvas text-ink-300">
            <Icon name="sliders" size={18} />
          </span>
          <p className="text-[14px] font-semibold text-ink-700">No rules in {address}</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[12.5px] leading-relaxed text-ink-400">
            Rules sort mail as it arrives — move it, flag it, forward it. Ones you make here appear in Outlook, and the other way round.
          </p>
        </div>
      ) : (
        <ol aria-label="Rules, in the order Outlook runs them" className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-white">
          {snap.rules.map((r, i) => (
            <li key={r.graphId} className={`flex items-start gap-3 px-4 py-3 ${busy === r.graphId ? 'opacity-60' : ''}`}>
              <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-md bg-canvas text-[11.5px] font-semibold tabular text-ink-500">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-900">
                  <span className={`truncate ${r.enabled ? '' : 'text-ink-400'}`}>{r.name}</span>
                  {r.readOnly ? (
                    <span title="Made in Outlook for Windows/Mac with options only Outlook can change." className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-px text-[10.5px] font-semibold text-ink-500">
                      <Icon name="lock" size={10} /> Outlook only
                    </span>
                  ) : null}
                  {r.hasError ? (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[#fdf6e7] px-1.5 py-px text-[10.5px] font-semibold text-[#8a5a00]">
                      <Icon name="alert-triangle" size={10} /> Outlook reports a problem
                    </span>
                  ) : null}
                </p>
                <p className={`mt-0.5 text-[12.5px] leading-relaxed ${r.enabled ? 'text-ink-500' : 'text-ink-300'}`}>{summary(r.form, folderName)}</p>
              </div>
              {canEdit ? (
                <div className="flex shrink-0 items-center gap-1">
                  <Switch
                    on={r.enabled}
                    label={`${r.enabled ? 'Turn off' : 'Turn on'} “${r.name}”`}
                    disabled={busy !== null}
                    onChange={async (on) => {
                      setBusy(r.graphId);
                      setSnap((s) => ({ ...s, rules: s.rules.map((x) => (x.graphId === r.graphId ? { ...x, enabled: on } : x)) }));
                      const res = await toggleRuleAction({ mailboxId, graphId: r.graphId, enabled: on });
                      setBusy(null);
                      if (!apply(res)) setSnap((s) => ({ ...s, rules: s.rules.map((x) => (x.graphId === r.graphId ? { ...x, enabled: !on } : x)) }));
                    }}
                  />
                  <span className="mx-1 h-4 w-px bg-line" aria-hidden />
                  <OrderButton icon="chevron-up" label={`Move “${r.name}” up`} disabled={r.readOnly || i === 0 || busy !== null} onClick={() => void move(i, -1)} />
                  <OrderButton icon="chevron-down" label={`Move “${r.name}” down`} disabled={r.readOnly || i === snap.rules.length - 1 || busy !== null} onClick={() => void move(i, 1)} />
                  {!r.readOnly ? (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ graphId: r.graphId, form: r.form })}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(r)}>
                        Delete
                      </Button>
                    </>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      {deleting ? (
        <Dialog
          title={`Delete “${deleting.name}”?`}
          tone="danger"
          confirmLabel="Delete rule"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            const r = await deleteRuleAction({ mailboxId, graphId: deleting.graphId });
            apply(r, `Deleted “${deleting.name}” from Outlook.`);
          }}
        >
          <p>It is removed from Outlook too. Mail it already sorted stays where it is.</p>
        </Dialog>
      ) : null}
    </div>
  );
}

function OrderButton({ icon, label, disabled, onClick }: { icon: 'chevron-up' | 'chevron-down'; label: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-7 place-items-center rounded-md text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900 disabled:pointer-events-none disabled:opacity-30"
    >
      <Icon name={icon} size={14} />
    </button>
  );
}

function Switch({ on, label, disabled, onChange }: { on: boolean; label: string; disabled?: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors disabled:opacity-60 ${on ? 'bg-brand-600' : 'bg-line'}`}
    >
      <span className={`absolute top-[2px] size-[14px] rounded-full bg-white shadow-[0_1px_2px_rgba(8,32,47,.25)] transition-[left] ${on ? 'left-[16px]' : 'left-[2px]'}`} />
    </button>
  );
}

// ── editor ──────────────────────────────────────────────────────────────────

const SECTION_COPY: Record<Section, { title: string; add: string; none: string }> = {
  conditions: { title: 'When a message arrives and all of these are true', add: 'Add a condition', none: 'No conditions: the rule applies to every message that arrives.' },
  actions: { title: 'Do all of the following', add: 'Add an action', none: 'Nothing happens yet — choose what Outlook should do.' },
  exceptions: { title: 'Except if any of these are true', add: 'Add an exception', none: '' },
};

function RuleEditor({
  initial,
  isNew,
  folders,
  onCancel,
  onSave,
}: {
  initial: RuleForm;
  isNew: boolean;
  folders: RuleFolder[];
  onCancel: () => void;
  onSave: (form: RuleForm) => Promise<string | null>;
}) {
  const [form, setForm] = useState<RuleForm>(initial);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [showExceptions, setShowExceptions] = useState(initial.exceptions.length > 0);
  const extras = Object.keys(form.extra.conditions).length + Object.keys(form.extra.exceptions).length + Object.keys(form.extra.actions).length;

  const setRows = (section: Section, rows: Row[]) => {
    setForm((f) => ({ ...f, [section]: rows }));
    setProblems([]);
  };

  const save = async () => {
    const p = validate(form);
    if (p.length) return setProblems(p);
    setSaving(true);
    const err = await onSave(form);
    setSaving(false);
    if (err) setProblems([err]);
  };

  return (
    <section aria-label={isNew ? 'New rule' : 'Edit rule'} className="rounded-xl border border-line bg-white shadow-[0_1px_3px_rgba(8,32,47,.05)]">
      <header className="flex items-center gap-3 border-b border-line-faint px-5 py-3">
        <h2 className="text-[15px] font-semibold text-ink-900">{isNew ? 'New rule' : 'Edit rule'}</h2>
        <label className="ml-auto flex items-center gap-2 text-[12.5px] font-medium text-ink-600">
          <Switch on={form.enabled} label="Run this rule" onChange={(on) => setForm((f) => ({ ...f, enabled: on }))} />
          {form.enabled ? 'On' : 'Off'}
        </label>
      </header>

      <div className="space-y-5 px-5 py-4">
        <div>
          <label htmlFor="rule-name" className="mb-1 block text-[12px] font-semibold text-ink-500">
            Name
          </label>
          <input
            id="rule-name"
            autoFocus
            value={form.name}
            maxLength={256}
            onChange={(e) => {
              setForm((f) => ({ ...f, name: e.target.value }));
              setProblems([]);
            }}
            placeholder="e.g. Invoices to Accounts"
            className="w-full rounded-lg border border-line px-3 py-2 text-[13.5px] text-ink-900 outline-none focus:border-brand-600"
          />
        </div>

        <RowsEditor section="conditions" rows={form.conditions} folders={folders} onChange={(r) => setRows('conditions', r)} />
        <RowsEditor section="actions" rows={form.actions} folders={folders} onChange={(r) => setRows('actions', r)} />
        {showExceptions ? (
          <RowsEditor section="exceptions" rows={form.exceptions} folders={folders} onChange={(r) => setRows('exceptions', r)} />
        ) : (
          <button type="button" onClick={() => setShowExceptions(true)} className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-500 hover:text-ink-900">
            <Icon name="plus" size={12} /> Add an exception
          </button>
        )}

        {extras ? (
          <p className="flex items-start gap-2 rounded-lg bg-canvas px-3 py-2 text-[12px] leading-relaxed text-ink-500">
            <Icon name="info" size={13} className="mt-px shrink-0" />
            This rule also has {extras} setting{extras === 1 ? '' : 's'} from Outlook that TapDash can’t show. They are kept exactly as they are.
          </p>
        ) : null}

        {problems.length ? (
          <ul role="alert" className="space-y-1 rounded-lg border border-[#f7cfd1] bg-[#fce9ea] px-3.5 py-2.5 text-[12.5px] text-[#b02a30]">
            {problems.map((p) => (
              <li key={p} className="flex items-start gap-2">
                <Icon name="alert-triangle" size={12} className="mt-0.5 shrink-0" />
                {p}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <footer className="flex items-center gap-2 border-t border-line-faint px-5 py-3">
        <Button variant="primary" icon="check" loading={saving} loadingLabel="Saving to Outlook…" onClick={() => void save()}>
          {isNew ? 'Create rule' : 'Save rule'}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </footer>
    </section>
  );
}

function RowsEditor({ section, rows, folders, onChange }: { section: Section; rows: Row[]; folders: RuleFolder[]; onChange: (rows: Row[]) => void }) {
  const catalogue = section === 'actions' ? ACTIONS : PREDICATES;
  const used = new Set(rows.map((r) => r.key));
  const copy = SECTION_COPY[section];
  return (
    <fieldset>
      <legend className="mb-1.5 text-[12px] font-semibold text-ink-500">{copy.title}</legend>
      <div className="space-y-1.5">
        {rows.length === 0 && copy.none ? <p className="text-[12.5px] text-ink-400">{copy.none}</p> : null}
        {rows.map((r, i) => {
          const entry = entryFor(section, r.key)!;
          return (
            <div key={r.key} className="flex items-start gap-2 rounded-lg border border-line-faint bg-canvas/60 px-3 py-2">
              <span className="w-[200px] shrink-0 pt-[7px] text-[12.5px] font-medium text-ink-700">{entry.label}</span>
              <div className="min-w-0 flex-1">
                <ValueField
                  label={entry.label}
                  value={r.value}
                  folders={folders}
                  onChange={(value) => onChange(rows.map((x, j) => (j === i ? { ...x, value } : x)))}
                />
              </div>
              <button
                type="button"
                aria-label={`Remove “${entry.label}”`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}
                className="mt-1 grid size-6 shrink-0 place-items-center rounded-md text-ink-400 hover:bg-white hover:text-ink-900"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          );
        })}
        <select
          aria-label={copy.add}
          value=""
          onChange={(e) => {
            const entry = entryFor(section, e.target.value);
            if (entry) onChange([...rows, { key: entry.key, value: blankValue(entry.kind) }]);
          }}
          className="rounded-lg border border-dashed border-line bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-500 outline-none hover:border-ink-400 focus:border-brand-600"
        >
          <option value="">+ {copy.add}…</option>
          {catalogue
            .filter((e) => !used.has(e.key))
            .map((e) => (
              <option key={e.key} value={e.key}>
                {e.label}
              </option>
            ))}
        </select>
      </div>
    </fieldset>
  );
}

const selectCls = 'rounded-md border border-line bg-white px-2 py-1.5 text-[12.5px] text-ink-900 outline-none focus:border-brand-600';

function ValueField({ label, value, folders, onChange }: { label: string; value: RowValue; folders: RuleFolder[]; onChange: (v: RowValue) => void }) {
  switch (value.kind) {
    case 'flag':
      return <span className="inline-block pt-[7px] text-[12.5px] text-ink-400">Yes</span>;
    case 'words':
      return (
        <ChipInput
          label={label}
          chips={value.words.map((w) => ({ text: w }))}
          placeholder="Type a word or phrase, then Enter"
          onAdd={(raw) => {
            const words = raw.split(/[;\n]/).map((w) => w.trim()).filter(Boolean);
            const next = [...value.words, ...words.filter((w) => !value.words.includes(w))];
            onChange({ kind: 'words', words: next });
          }}
          onRemove={(i) => onChange({ kind: 'words', words: value.words.filter((_, j) => j !== i) })}
        />
      );
    case 'people':
      return (
        <ChipInput
          label={label}
          chips={value.people.map((p) => ({ text: p.name || p.address, title: p.address }))}
          placeholder="name@company.com, then Enter"
          onAdd={(raw) => {
            const { valid, invalid } = parseRecipients(raw);
            const have = new Set(value.people.map((p) => p.address));
            onChange({ kind: 'people', people: [...value.people, ...valid.filter((v) => !have.has(v.address))] });
            return invalid.length ? `Not an email address: ${invalid.join(', ')}` : null;
          }}
          onRemove={(i) => onChange({ kind: 'people', people: value.people.filter((_, j) => j !== i) })}
        />
      );
    case 'folder':
      return (
        <select aria-label={label} value={value.folderId} onChange={(e) => onChange({ kind: 'folder', folderId: e.target.value })} className={`${selectCls} min-w-[220px]`}>
          <option value="">Choose a folder…</option>
          {folders.map((f) => (
            <option key={f.graphId} value={f.graphId}>
              {'  '.repeat(f.depth)}
              {f.name}
            </option>
          ))}
        </select>
      );
    case 'importance':
      return (
        <select aria-label={label} value={value.value} onChange={(e) => onChange({ kind: 'importance', value: e.target.value as (typeof IMPORTANCE)[number] })} className={selectCls}>
          {IMPORTANCE.map((v) => (
            <option key={v} value={v}>
              {v[0].toUpperCase() + v.slice(1)}
            </option>
          ))}
        </select>
      );
    case 'sensitivity':
      return (
        <select aria-label={label} value={value.value} onChange={(e) => onChange({ kind: 'sensitivity', value: e.target.value as (typeof SENSITIVITY)[number] })} className={selectCls}>
          {SENSITIVITY.map((v) => (
            <option key={v} value={v}>
              {v[0].toUpperCase() + v.slice(1)}
            </option>
          ))}
        </select>
      );
    case 'actionFlag':
      return (
        <select aria-label={label} value={value.value} onChange={(e) => onChange({ kind: 'actionFlag', value: e.target.value as (typeof ACTION_FLAGS)[number] })} className={selectCls}>
          {ACTION_FLAGS.map((v) => (
            <option key={v} value={v}>
              {ACTION_FLAG_LABEL[v]}
            </option>
          ))}
        </select>
      );
    case 'size':
      return (
        <span className="flex items-center gap-2 text-[12.5px] text-ink-500">
          <NumberInput value={value.min ?? ''} step={1} placeholder="0" className="w-24" onLiveChange={(n) => onChange({ ...value, min: n === null ? null : Math.round(n) })} />
          and
          <NumberInput value={value.max ?? ''} step={1} placeholder="no limit" className="w-24" onLiveChange={(n) => onChange({ ...value, max: n === null ? null : Math.round(n) })} />
          KB
        </span>
      );
  }
}

function ChipInput({
  label,
  chips,
  placeholder,
  onAdd,
  onRemove,
}: {
  label: string;
  chips: Array<{ text: string; title?: string }>;
  placeholder: string;
  onAdd: (raw: string) => string | null | void;
  onRemove: (i: number) => void;
}) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const commit = () => {
    if (!text.trim()) return;
    setError(onAdd(text) || null);
    setText('');
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-line bg-white px-1.5 py-1 focus-within:border-brand-600">
        {chips.map((c, i) => (
          <span key={`${c.text}-${i}`} title={c.title} className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-[1px] pl-2 pr-1 text-[12px] text-ink-800">
            {c.text}
            <button type="button" aria-label={`Remove ${c.text}`} onClick={() => onRemove(i)} className="grid size-4 place-items-center rounded-full opacity-60 hover:bg-white hover:opacity-100">
              <Icon name="x" size={9} />
            </button>
          </span>
        ))}
        <input
          aria-label={label}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',' || e.key === ';') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && !text && chips.length) onRemove(chips.length - 1);
          }}
          onBlur={commit}
          placeholder={chips.length ? '' : placeholder}
          className="min-w-[160px] flex-1 bg-transparent px-1 py-0.5 text-[12.5px] text-ink-900 outline-none placeholder:text-ink-300"
        />
      </div>
      {error ? <p className="mt-1 text-[11.5px] text-[#b02a30]">{error}</p> : null}
    </div>
  );
}

export function RulesHeader({ address, kind }: { address: string; kind: 'personal' | 'shared' }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Rules</h1>
        <p className="text-[13px] text-ink-500">
          {address}
          {kind === 'shared' ? ' (shared)' : ''} · Outlook runs these on mail arriving in the Inbox, top to bottom.
        </p>
      </div>
      <Link href="/email" className="text-[13px] font-semibold text-ink-500 hover:text-ink-900">
        Back to Email
      </Link>
    </div>
  );
}
