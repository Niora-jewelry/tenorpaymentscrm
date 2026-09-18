'use client';

/**
 * The "Other" tab — per-record entries, ported from `src/proto/ui/tabs.tsx`'s
 * `OtherTab`/`EntryRow`. No author-only gate on edit/delete here — the
 * prototype's own `EntryRow` shows those controls to anyone regardless of
 * who created the entry, and the real `record_custom_entries_all` RLS policy
 * already matches that (visibility-gated, not author-gated).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, IconButton, SpecNote } from '@/proto/ui/kit';
import { relative } from '@/proto/ui/tokens';
import { addCustomEntryAction, updateCustomEntryAction, deleteCustomEntryAction } from './actions';
import type { CustomEntry } from '@/lib/records/customEntries';

export function CustomEntries({
  moduleSlug,
  recordId,
  entries,
  authorNames,
  editable,
}: {
  moduleSlug: string;
  recordId: string;
  entries: CustomEntry[];
  authorNames: Record<string, string>;
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState('');
  const [value, setValue] = useState('');
  /*
   * These actions return void and throw on refusal. Unguarded, a denied add
   * left the typed label and value sitting in the inputs with no message — and
   * a denied delete left the entry on screen, which reads as the button not
   * working rather than as permission being refused.
   */
  const [error, setError] = useState<string | null>(null);

  const add = () => {
    if (!label.trim()) return;
    const formData = new FormData();
    formData.set('label', label.trim());
    formData.set('value', value.trim());
    startTransition(async () => {
      try {
        setError(null);
        await addCustomEntryAction(moduleSlug, recordId, formData);
      } catch {
        // Inputs kept — nobody should retype what they just entered.
        setError('Could not add that entry.');
        return;
      }
      setLabel('');
      setValue('');
      router.refresh();
    });
  };

  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
      <SpecNote>
        Anything here belongs to <strong>this record only</strong>. It is not a field: adding one
        does not put it on every other merchant, and because there is no definition behind it, it
        cannot be filtered, sorted or used as a dashboard column. Access follows this tab&rsquo;s own
        permission.
      </SpecNote>

      <section className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-[minmax(140px,1fr)_2fr_auto] gap-3 border-b border-line-soft bg-canvas px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
          <span>Label</span>
          <span>Information</span>
          <span />
        </div>

        {entries.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-ink-400">Nothing added to this record yet.</p>
        ) : (
          <div className="divide-y divide-[#f0f4f8]">
            {entries.map((e) => (
              <EntryRow key={e.id} moduleSlug={moduleSlug} entry={e} authorName={authorNames[e.createdBy] ?? 'Unknown user'} editable={editable} />
            ))}
          </div>
        )}

        {editable ? (
          <div className="grid grid-cols-[minmax(140px,1fr)_2fr_auto] items-center gap-3 border-t border-line-soft bg-canvas/50 px-3 py-2">
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Gate code"
              disabled={pending}
              className="rounded-md border border-line bg-white px-2 py-1.5 text-[13px] outline-none focus-field"
            />
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
              placeholder="e.g. #4471 — rear loading bay"
              disabled={pending}
              className="rounded-md border border-line bg-white px-2 py-1.5 text-[13px] outline-none focus-field"
            />
            <Button size="sm" icon="plus" loading={pending} loadingLabel="Adding…" disabled={!label.trim()} onClick={add}>
              Add
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function EntryRow({
  moduleSlug,
  entry,
  authorName,
  editable,
}: {
  moduleSlug: string;
  entry: CustomEntry;
  authorName: string;
  editable: boolean;
}) {
  const router = useRouter();
  const [now] = useState(() => new Date());
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  const [label, setLabel] = useState(entry.label);
  const [value, setValue] = useState(entry.value ?? '');

  const save = () => {
    startTransition(async () => {
      const formData = new FormData();
      formData.set('label', label);
      formData.set('value', value);
      try {
        setRowError(null);
        await updateCustomEntryAction(moduleSlug, entry.id, formData);
      } catch {
        setRowError('Could not save that entry.');
        return;
      }
      setEditing(false);
      router.refresh();
    });
  };

  const remove = () => {
    startTransition(async () => {
      try {
        setRowError(null);
        await deleteCustomEntryAction(moduleSlug, entry.id);
        router.refresh();
      } catch {
        setRowError('Could not delete that entry.');
      }
    });
  };

  if (editing) {
    return (
      <div className="grid grid-cols-[minmax(140px,1fr)_2fr_auto] items-center gap-3 px-3 py-2">
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          disabled={pending}
          className="rounded-md border border-line px-2 py-1.5 text-[13px] outline-none field-editing"
        />
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={pending}
          className="rounded-md border border-line px-2 py-1.5 text-[13px] outline-none field-editing"
        />
        <span className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
            Cancel
          </Button>
          <Button size="sm" icon="check" loading={pending} loadingLabel="Saving…" onClick={save}>
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
        {rowError ? (
          <span role="alert" className="block text-[11px] text-danger">
            {rowError}
          </span>
        ) : null}
        <span className="block text-[11px] text-ink-400">
          {authorName} · {relative(entry.createdAt, now)}
        </span>
      </span>
      {editable ? (
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton icon="pencil" size={24} title="Edit" onClick={() => setEditing(true)} />
          <IconButton icon="trash" size={24} tone="danger" title="Remove" onClick={remove} />
        </span>
      ) : null}
    </div>
  );
}
