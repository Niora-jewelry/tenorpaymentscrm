'use client';

/**
 * Merchant Equipment Setup: the rows of a record, laid out like Files rather than the
 * field grid. Starts empty, rows are added one at a time, every box saves on leaving it.
 *
 * The columns come from the server, and a column this viewer may not see is simply not
 * in them. Billed by's second choice is the row's current provider, and changing the
 * provider clears Billed by: the server does that, and this draws what the server
 * sends back, so the two cannot disagree.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
import { BILLED_TO_CHOICES, billedByChoices, displayValue, type ColumnValue } from '@/lib/equipment/columns';
import type { EquipmentColumnView, EquipmentPanelData, EquipmentRowView } from '@/lib/equipment/service';
import { addEquipmentProviderAction, addEquipmentRowAction, deleteEquipmentRowAction, updateEquipmentRowAction } from './equipmentActions';

const BOX = 'w-full rounded-md border border-line bg-white px-1.5 py-1 text-[13px] text-ink-900 outline-none focus:border-brand-400 disabled:bg-canvas disabled:text-ink-500';
const ADD_PROVIDER = '__add_provider';

/** Wide enough for what goes in each, so the table scrolls rather than squeezes. */
const WIDTH: Record<EquipmentColumnView['kind'], string> = {
  provider: 'min-w-[150px]',
  billed_by: 'min-w-[130px]',
  billed_to: 'min-w-[110px]',
  text: 'min-w-[150px]',
  whole: 'min-w-[80px]',
  money: 'min-w-[90px]',
  percent: 'min-w-[80px]',
  long_text: 'min-w-[180px]',
  checkbox: 'min-w-[64px]',
};

export function EquipmentPanel({ moduleSlug, recordId, data }: { moduleSlug: string; recordId: string; data: EquipmentPanelData }) {
  // The page's own redraw and an action's answer both land here; the newest wins.
  const [seen, setSeen] = useState(data);
  const [panel, setPanel] = useState(data);
  if (data !== seen) {
    setSeen(data);
    setPanel(data);
  }
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const take = (r: { ok: true; data: EquipmentPanelData } | { ok: false; message: string }) => {
    if (r.ok) {
      setPanel(r.data);
      setSaved(true);
      setError(null);
    } else {
      setError(r.message);
    }
    return r.ok;
  };
  const failed = () => setError('That could not be saved. Try again.');

  const save = (rowId: string, column: string, value: ColumnValue) => {
    startTransition(async () => {
      try {
        take(await updateEquipmentRowAction({ moduleSlug, rowId, column, value }));
      } catch {
        failed();
      }
    });
  };

  const addRow = () => {
    startTransition(async () => {
      try {
        take(await addEquipmentRowAction({ moduleSlug, recordId }));
      } catch {
        failed();
      }
    });
  };

  const removeRow = (rowId: string, done: () => void) => {
    startTransition(async () => {
      try {
        if (take(await deleteEquipmentRowAction({ moduleSlug, rowId }))) done();
      } catch {
        failed();
      }
    });
  };

  /** Adds the name to the shared list, then picks it on this row. */
  const addProvider = (rowId: string, name: string, done: () => void) => {
    startTransition(async () => {
      try {
        const added = await addEquipmentProviderAction({ moduleSlug, recordId, name });
        if (!added.ok) {
          setError(added.message);
          return;
        }
        setPanel(added.data.panel);
        take(await updateEquipmentRowAction({ moduleSlug, rowId, column: 'provider_id', value: added.data.providerId }));
        done();
      } catch {
        failed();
      }
    });
  };

  const empty = panel.rows.length === 0;

  return (
    <div className="space-y-2" data-equipment-panel>
      <div className="overflow-hidden rounded-xl border border-line bg-white">
        {empty ? (
          <p className="px-3 py-6 text-center text-[13px] text-ink-400">No equipment rows yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-line-soft bg-canvas text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
                  {panel.columns.map((c) => (
                    <th key={c.column} scope="col" className={`px-2 py-2 font-semibold ${WIDTH[c.kind]}`}>
                      {c.label}
                    </th>
                  ))}
                  {panel.canManageRows ? <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">Row actions</span></th> : null}
                </tr>
              </thead>
              <tbody>
                {panel.rows.map((row) => (
                  <Row key={row.id} panel={panel} row={row} pending={pending} onSave={save} onRemove={removeRow} onAddProvider={addProvider} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="flex min-h-7 flex-wrap items-center gap-2">
        {panel.canManageRows ? (
          <Button size="sm" variant="ghost" icon="plus" disabled={pending} onClick={addRow}>
            Add row
          </Button>
        ) : null}
        <span className="flex-1" />
        {error ? (
          <span role="alert" className="inline-flex items-center gap-1.5 text-[11.5px] text-danger">
            <Icon name="alert-triangle" size={11} />
            {error}
          </span>
        ) : saved ? (
          <span role="status" className="inline-flex items-center gap-1.5 rounded-full border border-line bg-white/95 px-2.5 py-1 text-[11.5px] text-ink-500 shadow-[0_1px_3px_rgba(14,28,52,.10)]">
            <Icon name="check" size={11} className="text-ok" />
            All changes saved
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Row({
  panel,
  row,
  pending,
  onSave,
  onRemove,
  onAddProvider,
}: {
  panel: EquipmentPanelData;
  row: EquipmentRowView;
  pending: boolean;
  onSave: (rowId: string, column: string, value: ColumnValue) => void;
  onRemove: (rowId: string, done: () => void) => void;
  onAddProvider: (rowId: string, name: string, done: () => void) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const colSpan = panel.columns.length + (panel.canManageRows ? 1 : 0);
  return (
    <>
      <tr className="border-b border-line-soft align-top last:border-b-0" data-equipment-row={row.rowNo}>
        {panel.columns.map((c) => (
          <td key={c.column} className="px-2 py-1.5">
            <Cell panel={panel} row={row} column={c} onSave={onSave} onAddProvider={onAddProvider} pending={pending} />
          </td>
        ))}
        {panel.canManageRows ? (
          <td className="px-2 py-1.5 text-right">
            <button
              type="button"
              title={`Delete row ${row.rowNo}`}
              aria-label={`Delete row ${row.rowNo}`}
              onClick={() => setConfirming(true)}
              className="mt-1 rounded text-ink-400 hover:text-danger"
            >
              <Icon name="trash" size={12} />
            </button>
          </td>
        ) : null}
      </tr>
      {confirming ? (
        <tr className="border-b border-line-soft bg-canvas last:border-b-0">
          <td colSpan={colSpan} className="px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[12px] text-ink-700">Delete this row? It goes to the Recycle Bin.</span>
              <Button size="sm" variant="danger" disabled={pending} onClick={() => onRemove(row.id, () => setConfirming(false))}>
                Delete
              </Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

function Cell({
  panel,
  row,
  column,
  pending,
  onSave,
  onAddProvider,
}: {
  panel: EquipmentPanelData;
  row: EquipmentRowView;
  column: EquipmentColumnView;
  pending: boolean;
  onSave: (rowId: string, column: string, value: ColumnValue) => void;
  onAddProvider: (rowId: string, name: string, done: () => void) => void;
}) {
  const value = row.values[column.column] ?? null;
  const label = `${column.label}, row ${row.rowNo}`;
  const disabled = !column.canEdit;

  switch (column.kind) {
    case 'checkbox':
      return (
        <input
          type="checkbox"
          aria-label={label}
          checked={value === true}
          disabled={disabled || pending}
          onChange={(e) => onSave(row.id, column.column, e.target.checked)}
          className="mt-1.5 size-4 accent-brand-600 disabled:opacity-60"
        />
      );
    case 'provider':
      return <ProviderCell panel={panel} row={row} column={column} label={label} pending={pending} onSave={onSave} onAddProvider={onAddProvider} />;
    case 'billed_by': {
      const providerShown = panel.columns.some((c) => c.kind === 'provider');
      const providerName = panel.providers.find((p) => p.id === row.values.provider_id)?.name ?? null;
      return (
        <Select
          label={label}
          value={value}
          disabled={disabled || pending}
          choices={billedByChoices(providerName, providerShown, value)}
          onChange={(v) => onSave(row.id, column.column, v)}
        />
      );
    }
    case 'billed_to':
      return <Select label={label} value={value} disabled={disabled || pending} choices={[...BILLED_TO_CHOICES]} onChange={(v) => onSave(row.id, column.column, v)} />;
    default:
      return <TextCell column={column} label={label} value={value} disabled={disabled} onCommit={(v) => onSave(row.id, column.column, v)} />;
  }
}

function Select({
  label,
  value,
  disabled,
  choices,
  onChange,
}: {
  label: string;
  value: ColumnValue;
  disabled: boolean;
  choices: { value: string; label: string }[];
  onChange: (value: string | null) => void;
}) {
  return (
    <select aria-label={label} value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} className={BOX}>
      <option value="" />
      {choices.map((c) => (
        <option key={c.value} value={c.value}>
          {c.label}
        </option>
      ))}
    </select>
  );
}

function ProviderCell({
  panel,
  row,
  column,
  label,
  pending,
  onSave,
  onAddProvider,
}: {
  panel: EquipmentPanelData;
  row: EquipmentRowView;
  column: EquipmentColumnView;
  label: string;
  pending: boolean;
  onSave: (rowId: string, column: string, value: ColumnValue) => void;
  onAddProvider: (rowId: string, name: string, done: () => void) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');

  if (adding) {
    const finish = () => {
      setAdding(false);
      setName('');
    };
    return (
      <div className="flex items-center gap-1">
        <input
          autoFocus
          aria-label="New provider name"
          placeholder="Provider name"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) onAddProvider(row.id, name, finish);
            if (e.key === 'Escape') finish();
          }}
          className={BOX}
        />
        <button type="button" title="Add this provider" aria-label="Add this provider" disabled={pending || !name.trim()} onClick={() => onAddProvider(row.id, name, finish)} className="rounded text-brand-700 disabled:opacity-50">
          <Icon name="check" size={13} />
        </button>
        <button type="button" title="Cancel" aria-label="Cancel" onClick={finish} className="rounded text-ink-400">
          <Icon name="x" size={13} />
        </button>
      </div>
    );
  }

  const value = row.values.provider_id;
  return (
    <select
      aria-label={label}
      value={typeof value === 'string' ? value : ''}
      disabled={!column.canEdit || pending}
      onChange={(e) => {
        if (e.target.value === ADD_PROVIDER) setAdding(true);
        else onSave(row.id, column.column, e.target.value || null);
      }}
      className={BOX}
    >
      <option value="" />
      {panel.providers.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
      {panel.canAddProviders ? <option value={ADD_PROVIDER}>Add new provider</option> : null}
    </select>
  );
}

/**
 * A box that holds what is being typed and saves on leaving it. Only while focused does
 * it keep its own text: otherwise it shows what the server last said, which also puts
 * a refused value back.
 */
function TextCell({
  column,
  label,
  value,
  disabled,
  onCommit,
}: {
  column: EquipmentColumnView;
  label: string;
  value: ColumnValue;
  disabled: boolean;
  onCommit: (value: string | null) => void;
}) {
  const shown = displayValue(column.kind, value);
  const [draft, setDraft] = useState<string | null>(null);

  const commit = () => {
    if (draft !== null && draft.trim() !== shown) onCommit(draft.trim() || null);
    setDraft(null);
  };
  const common = {
    'aria-label': label,
    value: draft ?? shown,
    disabled,
    onFocus: () => setDraft(shown),
    onBlur: commit,
  };

  if (column.kind === 'long_text') {
    // One line until hovered or clicked, then a bigger box to read and write in.
    return (
      <textarea
        {...common}
        rows={1}
        maxLength={2000}
        onChange={(e) => setDraft(e.target.value)}
        className={`${BOX} h-[30px] resize-none transition-[height] duration-150 hover:h-24 focus:h-24`}
      />
    );
  }

  const numeric = column.kind === 'money' || column.kind === 'percent' || column.kind === 'whole';
  return (
    <div className="relative">
      {column.kind === 'money' ? <span aria-hidden className="pointer-events-none absolute left-1.5 top-[5px] text-[13px] text-ink-400">$</span> : null}
      <input
        {...common}
        type="text"
        inputMode={column.kind === 'whole' ? 'numeric' : numeric ? 'decimal' : undefined}
        maxLength={column.kind === 'text' ? 200 : 40}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        className={`${BOX} ${column.kind === 'money' ? 'pl-4' : ''} ${column.kind === 'percent' ? 'pr-5' : ''} ${numeric ? 'text-right' : ''}`}
      />
      {column.kind === 'percent' ? <span aria-hidden className="pointer-events-none absolute right-1.5 top-[5px] text-[13px] text-ink-400">%</span> : null}
    </div>
  );
}
