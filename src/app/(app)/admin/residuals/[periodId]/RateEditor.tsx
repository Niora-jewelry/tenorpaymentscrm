'use client';

/**
 * Entering one merchant's rates for one statement month.
 *
 * ── WHY IT IS HERE AND NOT ON THE MERCHANT'S RECORD ──────────────────────
 * The record's Pricing tab is the right place for the rates in force NOW, and
 * it syncs them automatically. It cannot help a past month: the sync writes
 * `effective_from = date_trunc('month', now())`, so a statement for May is
 * priced by a lookup that finds nothing. This form names the effective date,
 * which is the only way to reach a month that has already closed — and it
 * lives beside the blocked merchant it unblocks, where the operator already
 * is.
 *
 * ── THE FIELDS ARE PRE-FILLED FROM THE STANDING ROW, NOT BLANK ───────────
 * A supersede replaces the whole row, so a field left blank becomes NULL even
 * if the previous row had a value. Starting from the current values makes the
 * form say what it will do; starting blank would quietly clear every rate the
 * operator did not retype.
 *
 * ── NOTHING HERE PARSES A RATE ───────────────────────────────────────────
 * The inputs are text, the values submit as text, and PostgreSQL casts to
 * `numeric(14,6)`. A rate is multiplied by an item count, so a sixth-decimal
 * error from a float round trip is real money on a busy merchant.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, OutlineChip } from '@/proto/ui/kit';
import {
  FAILURE_REASON,
  RATE_FIELD,
  RATE_GROUPS,
  RISK_TIERS,
  type RateEditorData,
} from '@/lib/residuals/rates';
import { supersedeRatesAction, updateRatesAction } from './rateActions';

/** `2026-05-01` <-> the `YYYY-MM` an `<input type="month">` carries. */
const toInputMonth = (iso: string) => iso.slice(0, 7);
const fromInputMonth = (v: string) => (v === '' ? '' : `${v}-01`);

function monthLabel(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * A standing value, as the string to put in the input.
 *
 * `residual_merchant_rate_editor` returns the row as jsonb, so a numeric
 * arrives as a JSON number. `String()` on it gives the shortest decimal that
 * round-trips — which is what the input shows and what gets submitted back as
 * text. The float exists for exactly the width of this function and never
 * reaches the database.
 */
function asText(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

export function RateEditor({
  periodId,
  statementMonth,
  data,
  onDone,
  onCancel,
}: {
  periodId: string;
  /** The month being reconciled. The default effective date, because it is
   *  the month whose figures are blocked. */
  statementMonth: string;
  data: RateEditorData;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const standing = data.standing;

  /*
   * Editing in place is only offered where the row ALREADY starts in the month
   * being reconciled and nothing calculated depends on it. Any other case is a
   * supersede, because editing a row an earlier month read would restate that
   * month's figures with nothing in the history to say so.
   */
  const startsThisMonth =
    standing !== null && standing.effective_from.slice(0, 7) === statementMonth.slice(0, 7);
  const canEditInPlace = startsThisMonth && !data.isLocked;

  const [month, setMonth] = useState(statementMonth.slice(0, 10));
  const [tier, setTier] = useState(standing?.risk_tier ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    for (const g of RATE_GROUPS) {
      for (const f of g.fields) out[f.key] = asText(standing?.[f.key]);
    }
    return out;
  });
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (inPlace: boolean) => {
    setError(null);
    const fd = new FormData();
    fd.set('effective_from', month);
    fd.set('risk_tier', tier);
    for (const [k, v] of Object.entries(values)) fd.set(k, v);
    fd.set('notes', notes);

    startTransition(async () => {
      const r =
        inPlace && standing
          ? await updateRatesAction(periodId, standing.id, fd)
          : await supersedeRatesAction(periodId, data.mid, fd);
      if (r.ok) onDone(r.message);
      else setError(r.message);
    });
  };

  const failures = Object.entries(data.fieldFailures);

  return (
    <div className="border-t border-line-soft bg-canvas px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink-900">
          Rates for {data.mid}
          <span className="ml-2 font-normal text-ink-500">
            {standing
              ? `currently from ${monthLabel(standing.effective_from)}`
              : 'none on file'}
          </span>
        </p>
        {data.versionCount > 1 ? (
          <OutlineChip>{data.versionCount} dated versions</OutlineChip>
        ) : null}
      </div>

      {/* ── why this merchant is blocked, at field grain ─────────────── */}
      {data.merchantFailure || failures.length > 0 ? (
        <div className="mt-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[#8a5a09]">
          <p className="text-[12.5px] font-semibold">What the engine could not find</p>
          <ul className="mt-1 space-y-0.5 text-[12px] leading-relaxed">
            {data.merchantFailure ? (
              <li>{FAILURE_REASON[data.merchantFailure] ?? data.merchantFailure}</li>
            ) : null}
            {failures.map(([key, reason]) => (
              <li key={key}>
                <span className="font-medium">{RATE_FIELD[key]?.label ?? key}</span>
                {' — '}
                {FAILURE_REASON[reason] ?? reason}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* ── the effective date, which is the whole point ─────────────── */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="rate-month" className="block text-[12.5px] font-medium text-ink-700">
            In effect from
          </label>
          <input
            id="rate-month"
            type="month"
            value={toInputMonth(month)}
            onChange={(e) => setMonth(fromInputMonth(e.target.value))}
            disabled={pending}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
          />
          <p className="mt-1 max-w-[46ch] text-[11px] leading-snug text-ink-400">
            Defaults to the month being reconciled, which is the month whose figures are waiting on
            these. Earlier months keep the rates they already had.
          </p>
        </div>

        <div>
          <label htmlFor="rate-tier" className="block text-[12.5px] font-medium text-ink-700">
            Risk level
          </label>
          <select
            id="rate-tier"
            value={tier}
            onChange={(e) => setTier(e.target.value)}
            disabled={pending}
            className="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] text-ink-900 outline-none focus-field"
          >
            <option value="">— pick one —</option>
            {RISK_TIERS.map((t) => (
              <option key={t.key} value={t.key}>
                {t.label}
              </option>
            ))}
          </select>
          {/*
            The most expensive field on the form. It selects the split
            percentage, which multiplies every line on the merchant.
          */}
          <p className="mt-1 max-w-[46ch] text-[11px] leading-snug text-ink-400">
            Sets TapDash&rsquo;s share of the net on every line for this merchant. The wrong level
            is not a small error.
          </p>
        </div>
      </div>

      {/* ── the rates ───────────────────────────────────────────────── */}
      {RATE_GROUPS.map((group) => (
        <fieldset key={group.title} className="mt-3.5">
          <legend className="text-[12.5px] font-semibold text-ink-800">{group.title}</legend>
          {group.note ? (
            <p className="mb-1.5 max-w-[80ch] text-[11px] leading-snug text-ink-400">
              {group.note}
            </p>
          ) : null}
          <div className="grid gap-x-3 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.fields.map((f) => {
              const flagged = f.key in data.fieldFailures;
              return (
                <div key={f.key}>
                  <label
                    htmlFor={`rate-${f.key}`}
                    className="block text-[12px] font-medium text-ink-700"
                  >
                    {f.label}
                    {flagged ? (
                      <span className="ml-1 text-[11px] font-normal text-[#8a5a09]">needed</span>
                    ) : null}
                  </label>
                  <input
                    id={`rate-${f.key}`}
                    /*
                      `type="text"`, not `number`. A number input's value is a
                      string anyway, but it also silently accepts exponent
                      notation and localises the decimal separator — both of
                      which change what reaches a numeric cast.
                    */
                    type="text"
                    inputMode={f.kind === 'text' ? 'text' : 'decimal'}
                    value={values[f.key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                    disabled={pending}
                    placeholder={f.kind === 'text' ? '' : 'blank = no such rate'}
                    list={f.kind === 'text' ? 'rate-providers' : undefined}
                    className={`mt-0.5 w-full rounded-lg border bg-white px-2 py-1.5 text-[13px] tabular text-ink-900 outline-none focus-field ${
                      flagged ? 'border-[#e8c78a]' : 'border-line'
                    }`}
                  />
                  {f.hint ? (
                    <p className="mt-0.5 max-w-[44ch] text-[10.5px] leading-snug text-ink-400">
                      {f.hint}
                    </p>
                  ) : null}
                </div>
              );
            })}
          </div>
        </fieldset>
      ))}

      <datalist id="rate-providers">
        {data.vendorProviders.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      {/*
        Said plainly, because it is the one thing a form gets wrong by default
        and the consequence is silent. A blank field is not zero.
      */}
      <p className="mt-3 max-w-[90ch] rounded-lg border border-line-soft bg-white px-3 py-2 text-[11.5px] leading-relaxed text-ink-500">
        A blank field means there is <strong>no such rate</strong>, which is not a rate of zero. The
        engine skips a line whose rate is blank and records that it did; a zero would be multiplied
        by the item count and booked as real. Saving replaces the whole row, so anything cleared
        here is cleared.
      </p>

      <div className="mt-2.5">
        <label htmlFor="rate-notes" className="block text-[12.5px] font-medium text-ink-700">
          Note (optional)
        </label>
        <input
          id="rate-notes"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          disabled={pending}
          placeholder="Where these came from, if it is worth recording."
          className="mt-1 w-full max-w-[640px] rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] text-ink-900 outline-none focus-field"
        />
      </div>

      {data.isLocked ? (
        <p className="mt-2.5 flex items-start gap-1.5 text-[12px] leading-relaxed text-ink-500">
          <Icon name="lock" size={12} className="mt-[2px] shrink-0" />
          A calculated month already reads this row, so it cannot be changed in place — saving opens
          a dated successor instead. That is what keeps a past month&rsquo;s report reading the
          rates that were in force then.
        </p>
      ) : null}

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
          disabled={pending || tier === '' || month === ''}
          loading={pending}
          loadingLabel="Saving…"
          onClick={() => submit(false)}
        >
          {standing ? 'Save as the rates from this month' : 'Save these rates'}
        </Button>

        {canEditInPlace ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={pending || tier === ''}
            onClick={() => submit(true)}
            title="Corrects the existing row rather than opening a successor. Only possible because no calculated month reads it."
          >
            Correct the existing row
          </Button>
        ) : null}

        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
      </div>

      {canEditInPlace ? (
        <p className="mt-1.5 max-w-[90ch] text-[11px] leading-relaxed text-ink-400">
          Two buttons because they are different acts. &ldquo;Save as the rates from this
          month&rdquo; records a change that happened. &ldquo;Correct the existing row&rdquo; says
          the row was wrong and leaves no successor &mdash; available only while nothing calculated
          depends on it.
        </p>
      ) : null}
    </div>
  );
}
