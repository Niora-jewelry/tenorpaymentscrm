'use client';

/**
 * The last twenty imports, with their error messages.
 *
 * ── WHY THE ERROR MESSAGE IS ON THE SCREEN ───────────────────────────────
 * The handoff's own description of this page: it "lists the last 20 imports
 * with their `error_message`, so a failed import is visible without a DB
 * query."
 *
 * A failed import leaves a row with `status = 'failed'` and the reason in a
 * column. Without this list, the only evidence an operator has is that the
 * month still looks empty — which is indistinguishable from never having
 * tried. The commit action reports its own failure to whoever was watching;
 * this is for everyone after that, including the person asking why June has no
 * figures.
 *
 * ── THE FAILURE REASON IS QUOTED, NOT SUMMARISED ─────────────────────────
 * `error_message` carries whatever the RPC raised — a SQLSTATE message, a
 * constraint name, a row number. Those are the words that let somebody search
 * the codebase or ask a sensible question, and a friendlier paraphrase would
 * lose exactly the detail that makes them useful.
 */
import { Icon } from '@/proto/ui/icons';
import { OutlineChip, StatusPill } from '@/proto/ui/kit';
import type { ImportHistoryRow } from '@/lib/records/residualImport';
import { Empty, Panel, PanelHead } from './ResidualsTabs';

function when(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function monthLabel(iso: string | null): string {
  if (iso === null) return '—';
  return new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function Status({ status }: { status: string }) {
  if (status === 'completed') return <StatusPill label="Imported" swatch="teal" dot={false} />;
  if (status === 'failed') return <StatusPill label="Failed" swatch="amber" dot={false} />;
  if (status === 'processing') return <StatusPill label="In flight" swatch="blue" dot={false} />;
  /* A retired import is how a replaced month is recorded. Hiding it would make
     a re-import look like a first import. */
  if (status === 'replaced') return <OutlineChip>Replaced</OutlineChip>;
  return <OutlineChip>{status}</OutlineChip>;
}

export function ImportHistory({ imports }: { imports: ImportHistoryRow[] }) {
  if (imports.length === 0) {
    return (
      <Panel>
        <Empty
          title="Nothing has been imported yet"
          body="Every attempt appears here once one has been made — including the ones that fail, with the reason the database gave."
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead>
        <h2 className="text-[14px] font-semibold text-ink-900">
          Recent imports{' '}
          <span className="ml-1 font-normal text-ink-400">({imports.length})</span>
        </h2>
        <span className="text-[12px] text-ink-400">Newest first</span>
      </PanelHead>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] text-left">
          <thead>
            <tr className="border-b border-line-soft text-[11px] uppercase tracking-wide text-ink-400">
              <th className="px-4 py-2 font-semibold">File</th>
              <th className="px-3 py-2 font-semibold">Month</th>
              <th className="px-3 py-2 font-semibold">Kind</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 text-right font-semibold">Rows</th>
              <th className="px-3 py-2 font-semibold">When</th>
            </tr>
          </thead>
          <tbody>
            {imports.map((im) => (
              <tr key={im.id}>
                <td className="border-b border-line-faint px-4 py-2 align-top">
                  <span className="block max-w-[34ch] truncate text-[12.5px] text-ink-900">
                    {im.originalFilename ?? <span className="text-ink-400">no filename</span>}
                  </span>
                  {im.sizeBytes !== null ? (
                    <span className="text-[10.5px] text-ink-400">
                      {(im.sizeBytes / 1024).toFixed(0)} KB
                    </span>
                  ) : null}
                </td>
                <td className="border-b border-line-faint px-3 py-2 align-top text-[12.5px] text-ink-700">
                  {monthLabel(im.statementMonth)}
                </td>
                <td className="border-b border-line-faint px-3 py-2 align-top">
                  <span className="text-[12px] text-ink-500">
                    {im.sourceType === 'pdf' ? 'PDF statement' : 'Fee report'}
                  </span>
                  {im.processor ? (
                    <span className="block text-[10.5px] text-ink-400">{im.processor}</span>
                  ) : null}
                </td>
                <td className="border-b border-line-faint px-3 py-2 align-top">
                  <Status status={im.status} />
                  {/*
                    Verbatim. These are the words that let somebody search the
                    codebase or ask a sensible question; a paraphrase would lose
                    the row number or the constraint name that makes them
                    useful.
                  */}
                  {im.errorMessage ? (
                    <p className="mt-1 flex max-w-[46ch] items-start gap-1 text-[11px] leading-snug text-[#b02a30]">
                      <Icon name="alert-triangle" size={11} className="mt-[2px] shrink-0" />
                      <span className="break-words">{im.errorMessage}</span>
                    </p>
                  ) : null}
                </td>
                <td className="border-b border-line-faint px-3 py-2 align-top text-right text-[12.5px] tabular text-ink-700">
                  {im.rowCount ?? <span className="text-ink-300">—</span>}
                </td>
                <td className="border-b border-line-faint px-3 py-2 align-top text-[11.5px] text-ink-500">
                  {when(im.createdAt)}
                  {im.processedAt !== null && im.processedAt !== im.createdAt ? (
                    <span className="block text-[10.5px] text-ink-400">
                      finished {when(im.processedAt)}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Only when there is one to explain. A legend for a state nothing on
          screen is in is noise competing with the rows. */}
      {imports.some((i) => i.status === 'replaced') ? (
      <p className="border-t border-line-faint px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-400">
        &ldquo;Replaced&rdquo; is an import that was retired when a later file took over its month.
        Its lines are retired with it and both are recoverable &mdash; nothing here is destroyed,
        so the record of what was loaded when stays intact.
      </p>
      ) : null}
    </Panel>
  );
}
