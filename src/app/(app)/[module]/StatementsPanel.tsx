'use client';

/**
 * Statements tab — the two-column year grid from `src/proto/ui/tabs.tsx`'s
 * `StatementsTab`, wired to real Supabase Storage uploads. Month rows are
 * the global `statement_periods` lookup (never created/deleted here, only
 * ever admin-extended) — this panel only ever uploads/deletes files against
 * an existing period.
 */
import { useMemo, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { SectionLabel } from '@/proto/ui/kit';
import { monthLabel } from '@/proto/ui/tokens';
import { uploadStatementAction, deleteStatementAction, getStatementUrlAction } from './actions';
import type { StatementPeriod, StatementFile } from '@/lib/records/statements';

export function StatementsPanel({
  moduleSlug,
  recordId,
  periods,
  files,
  editable,
}: {
  moduleSlug: string;
  recordId: string;
  periods: StatementPeriod[];
  files: StatementFile[];
  editable: boolean;
}) {
  const years = useMemo(
    () => Array.from(new Set(periods.map((p) => p.year))).sort((a, b) => a - b),
    [periods],
  );
  const [year, setYear] = useState(years.includes(2026) ? 2026 : (years[years.length - 1] ?? years[0]));

  const monthsForYear = periods
    .filter((p) => p.year === year)
    .sort((a, b) => a.month - b.month);

  const filesByPeriod = useMemo(() => {
    const map: Record<string, StatementFile[]> = {};
    for (const f of files) (map[f.periodId] ??= []).push(f);
    return map;
  }, [files]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SectionLabel>Statements</SectionLabel>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded-md border border-line bg-white px-2 py-1 text-[13px] tabular outline-none transition-colors focus-field"
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
        <span className="text-[12px] text-ink-400">
          Month rows are prebuilt July 2024 – December 2032 and cannot be created or deleted here.
        </span>
      </div>

      <div className="grid gap-2 md:grid-cols-2">
        {monthsForYear.map((period) => (
          <PeriodRow
            key={period.id}
            moduleSlug={moduleSlug}
            recordId={recordId}
            period={period}
            files={filesByPeriod[period.id] ?? []}
            editable={editable}
          />
        ))}
      </div>

      <p className="text-[11.5px] text-ink-400">
        One dataset shown in every module — a file uploaded here is instantly present everywhere
        else this record appears.
      </p>
    </div>
  );
}

function PeriodRow({
  moduleSlug,
  recordId,
  period,
  files,
  editable,
}: {
  moduleSlug: string;
  recordId: string;
  period: StatementPeriod;
  files: StatementFile[];
  editable: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  /** Same as the Files tab: uploaded statements rendered as dead text and
   *  could only be deleted, while `getStatementUrlAction` sat unused. The tab
   *  is opened synchronously on the click so the popup blocker does not eat
   *  it, then pointed at the signed URL when it arrives. */
  const openStatement = async (fileId: string) => {
    setError(null);
    setOpening(fileId);
    const tab = window.open('', '_blank', 'noopener,noreferrer');
    try {
      const url = await getStatementUrlAction(fileId);
      if (tab) tab.location.assign(url);
      // A blocked popup is the only way `tab` is null. Navigating this tab
      // instead would throw away whatever the user has half-typed in the
      // drawer, so it says what happened rather than deciding for them.
      else setError('Your browser blocked the new tab. Allow pop-ups for this site to open statements.');
    } catch {
      tab?.close();
      setError('Could not open that statement. It may have been removed.');
    } finally {
      setOpening(null);
    }
  };
  const inputRef = useRef<HTMLInputElement>(null);
  const periodStr = `${period.year}-${String(period.month).padStart(2, '0')}`;

  const upload = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const formData = new FormData();
    formData.set('file', file);
    startTransition(async () => {
      const result = await uploadStatementAction(moduleSlug, recordId, period, formData);
      if (!result.ok) setError(result.message ?? 'Upload failed.');
      else router.refresh();
      if (inputRef.current) inputRef.current.value = '';
    });
  };

  const remove = (fileId: string) => {
    startTransition(async () => {
      /*
       * Wrapped because these actions return void and THROW on refusal —
       * `requireTabEdit` raises for a viewer without Edit on this tab. Left
       * unguarded, the click did nothing at all: the throw skipped
       * `router.refresh()`, the row stayed on screen, and no message appeared.
       * A delete that silently does nothing is indistinguishable from a broken
       * button.
       */
      try {
        setError(null);
        await deleteStatementAction(moduleSlug, fileId);
        router.refresh();
      } catch {
        setError('Could not delete that statement.');
      }
    });
  };

  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-white px-3 py-2">
      <span className="w-[74px] shrink-0 pt-0.5 text-[12.5px] font-medium text-ink-700 tabular">
        {monthLabel(periodStr)}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          {files.map((file) => (
            <span
              key={file.id}
              title={file.name}
              className="group inline-flex max-w-[180px] items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-[3px] text-[11.5px]"
            >
              <Icon name="file-text" size={11} className="text-ink-400 shrink-0" />
              <button
                type="button"
                title={`Open ${file.name}`}
                disabled={opening === file.id}
                onClick={() => openStatement(file.id)}
                className="truncate text-left underline decoration-line underline-offset-2 transition-colors hover:text-brand-700 hover:decoration-brand-600 disabled:opacity-60"
              >
                {opening === file.id ? 'Opening…' : file.name}
              </button>
              {editable ? (
                <button
                  type="button"
                  title="Delete"
                  disabled={pending}
                  onClick={() => remove(file.id)}
                  className="shrink-0 rounded text-ink-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger disabled:opacity-60"
                >
                  <Icon name="x" size={10} />
                </button>
              ) : null}
            </span>
          ))}
          {editable ? (
            files.length === 0 ? (
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-dashed border-line px-2 py-1 text-[11.5px] text-ink-400 transition-colors hover:border-brand-600 hover:text-brand-700">
                <Icon name="upload" size={11} />
                Upload
                <input ref={inputRef} type="file" className="hidden" disabled={pending} onChange={(e) => upload(e.target.files?.[0])} />
              </label>
            ) : (
              <label
                title="Add another file"
                className="grid size-[22px] cursor-pointer place-items-center rounded-lg text-ink-400 transition-colors duration-150 hover:bg-canvas hover:text-ink-900"
              >
                <Icon name="plus" size={13} />
                <input ref={inputRef} type="file" className="hidden" disabled={pending} onChange={(e) => upload(e.target.files?.[0])} />
              </label>
            )
          ) : files.length === 0 ? (
            <span className="text-[11.5px] text-ink-400/70">—</span>
          ) : null}
        </div>
        {error ? <p className="text-[11px] text-danger">{error}</p> : null}
      </div>
    </div>
  );
}
