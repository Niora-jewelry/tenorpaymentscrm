'use client';

/**
 * The four volume buckets for one merchant, for one month.
 *
 * ── A BUCKET IS NOT A TOTAL ──────────────────────────────────────────────
 * Each rule names which buckets its volume comes from. BIN sponsorship is
 * assessed on VMD + debit and Amex is deliberately not in it; OptBlue is Amex
 * alone; Cash Discount spans all three card buckets and excludes EBT. So a
 * total typed into the wrong bucket does not make a number slightly wrong — it
 * feeds money to a rule that should never have seen it. The hints say which
 * rule reads which bucket, on the form, while the operator is typing.
 *
 * ── VOLUME AND COUNT, SIDE BY SIDE ───────────────────────────────────────
 * Paired per row rather than listed as two blocks of four, because a volume
 * with no count — or the reverse — is the signature of a half-copied
 * statement, and seeing them adjacent is what makes that obvious.
 *
 * ── A BLANK IS NOT A ZERO, AND HERE IT IS THE WHOLE THING ────────────────
 * A NULL bucket is precisely what puts the merchant on the `awaiting_volumes`
 * rung; a zero takes it off. If the statement genuinely shows no Amex volume
 * then 0 is the right entry — but that is a person deciding, not a form
 * defaulting, and the engine withholding the comparison is the safer of the
 * two wrong answers.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, OutlineChip } from '@/proto/ui/kit';
import { VOLUME_FIELDS, type VolumeRow } from '@/lib/residuals/volumes';
import { updateVolumesAction } from './volumeActions';

/** A figure as the string to put in the input. Never parsed. */
function asText(v: string | number | null): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function VolumeEditor({
  periodId,
  row,
  onDone,
  onCancel,
}: {
  periodId: string;
  row: VolumeRow;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const f of VOLUME_FIELDS) {
      out[f.key] = asText(
        f.key === 'vmd_volume'
          ? row.vmdVolume
          : f.key === 'amex_volume'
            ? row.amexVolume
            : f.key === 'debit_volume'
              ? row.debitVolume
              : row.ebtVolume,
      );
      out[f.countKey] = asText(
        f.countKey === 'vmd_item_count'
          ? row.vmdItemCount
          : f.countKey === 'amex_item_count'
            ? row.amexItemCount
            : f.countKey === 'debit_item_count'
              ? row.debitItemCount
              : row.ebtItemCount,
      );
    }
    return out;
  });
  const [name, setName] = useState(row.merchantName ?? '');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    const fd = new FormData();
    for (const [k, v] of Object.entries(values)) fd.set(k, v);
    fd.set('merchant_name', name);

    startTransition(async () => {
      const r = await updateVolumesAction(periodId, row.mid, fd);
      if (r.ok) onDone(r.message);
      else setError(r.message);
    });
  };

  return (
    <div className="border-t border-line-soft bg-canvas px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink-900">Volume figures for {row.mid}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {row.hasRow ? (
            <OutlineChip tone={row.source === 'pdf' ? 'brand' : undefined}>
              {row.source === 'pdf' ? 'from the PDF statement' : 'entered by hand'}
            </OutlineChip>
          ) : (
            <OutlineChip>nothing on file</OutlineChip>
          )}
        </div>
      </div>

      <p className="mt-1 max-w-[86ch] text-[12px] leading-relaxed text-ink-500">
        These come off the processor&rsquo;s PDF statement. The count-based fees already computed
        from the fee report; the ones assessed on volume are waiting on these, and no rate fixes
        that.
      </p>

      {row.source === 'pdf' ? (
        /*
          Worth a warning rather than a silent allow. Overwriting an imported
          figure by hand is sometimes right — a statement gets reissued — but it
          replaces something with provenance with something without, and the
          row's `source` flips to 'manual' to say so.
        */
        <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[12px] leading-relaxed text-[#8a5a09]">
          <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
          These figures came from an imported statement. Editing them by hand replaces a figure
          that has provenance with one that does not, and the row will be marked as hand-entered
          from then on.
        </p>
      ) : null}

      <div className="mt-3 space-y-2">
        {VOLUME_FIELDS.map((f) => (
          <div key={f.key} className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-start">
            <div className="min-w-0">
              <p className="text-[12.5px] font-medium text-ink-800">{f.label}</p>
              <p className="max-w-[60ch] text-[10.5px] leading-snug text-ink-400">{f.hint}</p>
            </div>

            <div>
              <label
                htmlFor={`vol-${f.key}`}
                className="block text-[11px] font-medium text-ink-500"
              >
                Volume
              </label>
              <input
                id={`vol-${f.key}`}
                type="text"
                inputMode="decimal"
                value={values[f.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                disabled={pending}
                placeholder="blank = unknown"
                className="mt-0.5 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-right text-[13px] tabular text-ink-900 outline-none focus-field sm:w-[150px]"
              />
            </div>

            <div>
              <label
                htmlFor={`vol-${f.countKey}`}
                className="block text-[11px] font-medium text-ink-500"
              >
                Items
              </label>
              <input
                id={`vol-${f.countKey}`}
                type="text"
                inputMode="numeric"
                value={values[f.countKey] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [f.countKey]: e.target.value }))}
                disabled={pending}
                className="mt-0.5 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-right text-[13px] tabular text-ink-900 outline-none focus-field sm:w-[110px]"
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3">
        <label htmlFor="vol-name" className="block text-[12.5px] font-medium text-ink-700">
          Merchant name on the statement (optional)
        </label>
        <input
          id="vol-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
          className="mt-1 w-full max-w-[420px] rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] text-ink-900 outline-none focus-field"
        />
      </div>

      {/*
        Stated because of what a blank does here, which is not nothing: the
        save sends every field, so a cleared box clears the column — and a
        cleared bucket is what puts the merchant back on the awaiting rung.
      */}
      <p className="mt-3 max-w-[90ch] rounded-lg border border-line-soft bg-white px-3 py-2 text-[11.5px] leading-relaxed text-ink-500">
        A blank bucket means <strong>unknown</strong>, not zero, and an unknown bucket is what
        holds the merchant on &ldquo;awaiting volumes&rdquo;. If the statement really shows nothing
        for a bucket, enter <span className="tabular">0</span> &mdash; that is a figure somebody
        decided, and the engine will use it. Saving writes every box, so anything cleared here is
        cleared.
      </p>

      {error ? (
        <p role="alert" className="mt-2.5 flex items-start gap-1.5 text-[12.5px] leading-relaxed text-danger">
          <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
          {error}
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="primary"
          icon="check"
          disabled={pending}
          loading={pending}
          loadingLabel="Saving…"
          onClick={submit}
        >
          {row.hasRow ? 'Save these figures' : 'Record these figures'}
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
