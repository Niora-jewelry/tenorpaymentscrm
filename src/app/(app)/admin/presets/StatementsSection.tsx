'use client';

/**
 * Admin → Presets → Statements: extend the month grid.
 *
 * ── WHAT THE CLIENT ASKED FOR ────────────────────────────────────────────
 * Modules Plan, Amendment 4: "The Admin Panel provides an Add months/years
 * control on the Statements system structure allowing an admin to extend the
 * grid forward by additional full years (e.g., adding 2033 creates its twelve
 * month rows across every record simultaneously, since the structure is
 * global). Extension is append-only: months can be added, never removed, and
 * the July 2024 start point is fixed."
 *
 * ── WHY THERE IS ONE BUTTON AND NOT A YEAR PICKER ────────────────────────
 * Append-only and contiguous means there is exactly one legal year at any
 * moment: the one after the last. A picker would offer 2035 and then refuse it,
 * which is a control that exists to say no. The button names the year it will
 * add, so the admin still reads it before clicking.
 *
 * ── WHY IT CONFIRMS ──────────────────────────────────────────────────────
 * There is no undo. The database has no remove path, deliberately, because a
 * year may already carry uploaded statements by the time anyone regrets it. So
 * the irreversible step gets the confirmation, the same rule the Recycle Bin's
 * Purge follows.
 */
import { useState, useTransition } from 'react';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { addStatementYearAction } from './actions';
import type { StatementGrid } from '@/lib/records/adminStatements';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function StatementsSection({ grid }: { grid: StatementGrid }) {
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<number | null>(null);

  const add = () => {
    setError(null);
    setAdded(null);
    startTransition(async () => {
      const result = await addStatementYearAction(grid.nextYear);
      setConfirming(false);
      if (result.ok) setAdded(grid.nextYear);
      else setError(result.message ?? 'Could not add that year. Nothing was changed.');
    });
  };

  return (
    <div className="rounded-xl border border-line bg-white">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-[14px] font-semibold text-ink-900">Statements month grid</h2>
        <p className="mt-0.5 text-[12.5px] text-ink-500">
          One global calendar behind the Statements tab. Every record reads the same months, so
          adding a year adds it everywhere at once.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
        <Stat label="Starts" value={`${MONTHS[6]} ${grid.firstYear}`} />
        <Stat label="Ends" value={`${MONTHS[11]} ${grid.lastYear}`} />
        <Stat label="Months" value={grid.months.toLocaleString()} />
        <Stat label="With a statement" value={grid.monthsWithFiles.toLocaleString()} />
      </dl>

      <div className="px-4 py-3.5">
        <div className="mb-3 flex flex-wrap gap-1.5">
          {grid.years.map((y) => (
            <span
              key={y}
              className="rounded-md bg-canvas px-2 py-1 text-[12px] font-semibold tabular text-ink-600 ring-1 ring-inset ring-line"
            >
              {y}
              {y === grid.firstYear ? (
                <span className="ml-1 font-normal text-ink-400">from Jul</span>
              ) : null}
            </span>
          ))}
        </div>

        {confirming ? (
          <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2.5">
            <p className="text-[12.5px] font-semibold text-[#8a5a00]">
              Add all twelve months of {grid.nextYear}?
            </p>
            <p className="mt-0.5 text-[12px] leading-relaxed text-[#8a5a00]/85">
              This appears on every record straight away and cannot be removed — the grid only ever
              grows forward.
            </p>
            <div className="mt-2.5 flex gap-2">
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="plus"
                loading={pending}
                loadingLabel="Adding…"
                onClick={add}
              >
                Yes, add {grid.nextYear}
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="primary" icon="plus" onClick={() => setConfirming(true)}>
            Add {grid.nextYear}
          </Button>
        )}

        {added ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-[12px] font-semibold text-[#1c7a4f]">
            <Icon name="check" size={12} />
            {added} added — twelve months, on every record.
          </p>
        ) : null}

        {error ? (
          <p className="mt-2.5 flex items-center gap-1.5 text-[12px] text-[#b02a30]">
            <Icon name="alert-triangle" size={12} />
            {error}
          </p>
        ) : null}

        <p className="mt-3 text-[11.5px] leading-relaxed text-ink-400">
          July 2024 is the fixed start and never moves. Months can be added, never removed, so a
          year that has been added stays — along with anything uploaded into it.
        </p>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white px-4 py-2.5">
      <dt className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">{label}</dt>
      <dd className="mt-0.5 text-[14px] font-semibold tabular text-ink-900">{value}</dd>
    </div>
  );
}
