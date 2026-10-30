'use client';

/**
 * A field's own address — the pin beside the notes icon on a field that has
 * `address_enabled` (Inventory: "Off-site (warehouse) — provide address").
 * Opens a panel under the value with the same address control every address
 * field uses; saving goes through `set_field_address`, which writes the
 * history row with the value.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { FieldRenderer, asAddress, formatAddress } from '@/proto/ui/value';
import type { Field as ProtoField, FieldValue } from '@/proto/schema';
import type { FieldAddress as Address } from '@/lib/records/fieldAddresses';
import { setFieldAddressAction } from './actions';

const EMPTY: Address = { street: '', street2: '', city: '', state: '', zip: '', country: '' };
const isEmpty = (a: Address) => !a.street && !a.street2 && !a.city && !a.state && !a.zip;

export function FieldAddressButton({ has, open, onToggle, label }: { has: boolean; open: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      title={has ? `Address on ${label}` : `Add an address to ${label}`}
      className={`inline-flex items-center gap-0.5 rounded px-1 py-px text-[10.5px] font-semibold transition-colors ${
        has || open ? 'bg-brand-50 text-brand-700 hover:bg-brand-100' : 'text-ink-400 hover:bg-canvas hover:text-ink-700'
      }`}
    >
      <Icon name="pin" size={10} />
    </button>
  );
}

export function FieldAddressPanel({
  moduleSlug,
  recordId,
  field,
  address,
  editable,
  onSaved,
}: {
  moduleSlug: string;
  recordId: string;
  field: ProtoField;
  address: Address | undefined;
  editable: boolean;
  onSaved: (next: Address | undefined) => void;
}) {
  const [local, setLocal] = useState<Address>(address ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  // The control is the plain address editor, dressed as this field's address.
  const asField: ProtoField = { ...field, id: `${field.id}__address`, label: 'Address', type: 'address', notes: false, address: false, required: false };

  const save = (v: FieldValue) => {
    const next = { ...EMPTY, ...asAddress(v) };
    setLocal(next);
    setError(null);
    start(async () => {
      const r = await setFieldAddressAction(moduleSlug, recordId, field.id, next);
      if (!r.ok) return setError(r.message ?? 'The address could not be saved.');
      onSaved(isEmpty(next) ? undefined : next);
    });
  };

  return (
    <div className="mt-2 rounded-lg border border-line-soft bg-canvas/50 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-500">
          <Icon name="pin" size={10} /> Address · {field.label.toLowerCase()}
        </p>
        <span className="flex items-center gap-2 text-[11px] text-ink-400">
          {pending ? <Spinner /> : null}
          {editable && !isEmpty(local) && !pending ? (
            <button type="button" onClick={() => save(EMPTY)} className="font-medium hover:text-bad">
              Remove
            </button>
          ) : null}
        </span>
      </div>
      {editable ? (
        <FieldRenderer field={asField} value={local} grant="edit" moduleSlug={moduleSlug} card={false} onChange={save} />
      ) : (
        <p className="text-[13px] text-ink-800">{isEmpty(local) ? <span className="italic text-ink-300">No address</span> : formatAddress(local)}</p>
      )}
      {error ? <p className="mt-1 text-[11.5px] font-medium text-bad">{error}</p> : null}
    </div>
  );
}
