'use client';

/**
 * Statement MIDs that do not resolve to a merchant record.
 *
 * ── WHAT LINKING IS AND IS NOT FOR ───────────────────────────────────────
 * Said on the screen, not just in a comment, because getting it wrong in the
 * other direction is expensive. Daniel:
 *
 *   "What it is for: attaching a residual row to the CRM merchant record it
 *    belongs to, so the module can be navigated from the CRM and vice versa.
 *    What it is NOT for: keying reference data... Linking is a convenience for
 *    humans; pricing never depends on it."
 *
 * An operator who believes an unlinked MID is miscalculating will go hunting
 * for a problem that is not there. One who believes linking fixes a wrong
 * number will link something incorrectly to make a figure move, and it will
 * not move.
 *
 * ── AMBIGUOUS IS NOT AN ERROR ────────────────────────────────────────────
 * Two candidate records is the system refusing to guess, which is the
 * behaviour being protected. It is shown as something needing a decision, not
 * as a fault.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, OutlineChip, StatusPill } from '@/proto/ui/kit';
import type { LinkWorklistRow } from '@/lib/records/adminResiduals';
import { Empty, Panel, PanelHead } from './ResidualsTabs';
import { linkMidAction, sweepLinksAction } from './actions';

function Verdict({ kind, count }: { kind: string; count: number }) {
  if (kind === 'ambiguous') {
    return <StatusPill label={`${count} possible matches`} swatch="amber" dot={false} />;
  }
  if (kind === 'unmatched') return <OutlineChip>No match</OutlineChip>;
  return <OutlineChip tone="brand">{kind}</OutlineChip>;
}

export function LinksSection({ worklist }: { worklist: LinkWorklistRow[] }) {
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const link = (mid: string, recordId: string) => {
    setError(null);
    startTransition(async () => {
      const r = await linkMidAction(mid, recordId);
      if (r.ok) setNotice(`${mid} linked. ${r.message ?? ''}`.trim());
      else setError(r.message ?? 'That could not be linked.');
    });
  };

  const sweep = () => {
    setError(null);
    startTransition(async () => {
      const r = await sweepLinksAction();
      if (r.ok) setNotice(r.message ?? 'Re-checked.');
      else setError(r.message ?? 'That did not work.');
    });
  };

  if (worklist.length === 0) {
    return (
      <Panel>
        <Empty
          title="Nothing unmatched"
          body="Every statement MID resolves to a merchant record — or there are no statement lines yet, which is the case until a fee report is imported."
        />
      </Panel>
    );
  }

  return (
    <Panel>
      <PanelHead>
        <h2 className="text-[14px] font-semibold text-ink-900">
          Unmatched MIDs <span className="ml-1 font-normal text-ink-400">({worklist.length})</span>
        </h2>
        <Button size="sm" variant="ghost" icon="rotate-ccw" disabled={pending} onClick={sweep}>
          {pending ? 'Checking…' : 'Re-check all'}
        </Button>
      </PanelHead>

      {notice ? (
        <p role="status" className="flex items-center gap-1.5 border-b border-line-faint bg-ok-bg px-4 py-2 text-[12.5px] text-ink-800">
          <Icon name="check" size={13} strokeWidth={2.5} className="text-ok" />
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-center gap-1.5 border-b border-line-faint px-4 py-2 text-[12.5px] text-danger">
          <Icon name="alert-triangle" size={13} />
          {error}
        </p>
      ) : null}

      <ul className="divide-y divide-line-faint">
        {worklist.map((row) => (
          <li key={row.mid} className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-[13.5px] font-medium tabular text-ink-900">{row.mid}</span>
              <Verdict kind={row.matchKind} count={row.candidateCount} />
              <span className="text-[12px] text-ink-400">
                {[
                  row.lineRows ? `${row.lineRows} fee line${row.lineRows === 1 ? '' : 's'}` : null,
                  row.volumeRows ? `${row.volumeRows} volume` : null,
                  row.planRows ? `${row.planRows} plan` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </div>

            {row.candidates.length > 0 ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] text-ink-400">Link to:</span>
                {row.candidates.map((c) => (
                  <button
                    key={c.recordId}
                    type="button"
                    disabled={pending}
                    onClick={() => link(row.mid, c.recordId)}
                    className="inline-flex items-center gap-1.5 rounded-full border border-brand-600/15 bg-brand-50 px-2.5 py-1 text-[12px] font-medium text-brand-700 transition-colors hover:border-brand-600/30 hover:bg-brand-100 disabled:opacity-50"
                  >
                    <Icon name="link" size={11} />
                    {c.dealName ?? c.mid}
                    <span className="tabular text-brand-700/60">{c.mid}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-1.5 text-[11.5px] text-ink-400">
                No merchant record carries this MID. Add it to the record&rsquo;s MID field and it
                will link itself.
              </p>
            )}
          </li>
        ))}
      </ul>

      <p className="border-t border-line-faint px-4 py-2.5 text-[11.5px] leading-relaxed text-ink-400">
        Linking is for navigation between the CRM and this module. It does not change any
        calculation &mdash; rates are keyed on the statement MID itself, so an unmatched merchant
        is still costed correctly.
      </p>
    </Panel>
  );
}
