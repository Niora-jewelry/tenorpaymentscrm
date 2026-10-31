/**
 * Run history. Spec: each run, with the record, the time, the steps that ran,
 * any steps that were skipped, and any errors. A run that never started, because
 * its conditions weren't met, is left out unless asked for.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { automationsAccess, authorize } from '@/lib/records/permissions';
import { listAutomations, listRuns } from '@/lib/automations/service';
import { TRIGGERS, type TriggerType } from '@/lib/automations/steps';
import { Icon } from '@/proto/ui/icons';
import { RunBadge, RUN_STATUSES, when } from '../bits';
import { RunFilters } from './RunFilters';

const STEP_ICON = { done: 'check', waiting: 'clock', skipped: 'ban', failed: 'alert-triangle' } as const;
const STEP_TONE = { done: 'text-[#1f7a4d]', waiting: 'text-[#8a5a09]', skipped: 'text-[#b02a30]', failed: 'text-[#b02a30]' } as const;

export default async function AutomationRunsPage({ searchParams }: { searchParams: Promise<{ automation?: string; status?: string; page?: string }> }) {
  const ctx = await authorize();
  if ((await automationsAccess(ctx)) === 'hidden') redirect('/dashboard');

  const params = await searchParams;
  const page = Math.max(0, Number(params.page ?? 0) || 0);
  const [{ runs, total, pageSize }, automations] = await Promise.all([
    listRuns(ctx, { automationId: params.automation, status: params.status, page }),
    listAutomations(ctx),
  ]);
  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (params.automation) q.set('automation', params.automation);
    if (params.status) q.set('status', params.status);
    if (p) q.set('page', String(p));
    const s = q.toString();
    return `/admin/automations/runs${s ? `?${s}` : ''}`;
  };

  return (
    <div className="space-y-5 p-6">
      <div>
        <Link href="/admin/automations" className="inline-flex items-center gap-1 text-[12.5px] font-medium text-ink-500 hover:text-ink-900">
          <Icon name="chevron-left" size={13} /> Automations
        </Link>
        <h1 className="mt-1 text-xl font-semibold text-ink-900">Run history</h1>
        <p className="text-[13px] text-ink-500">Every time an automation ran on a record.</p>
      </div>

      <RunFilters automations={automations.map((a) => ({ value: a.id, label: a.name }))} statuses={RUN_STATUSES} automation={params.automation ?? ''} status={params.status ?? ''} />

      {runs.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-white px-6 py-10 text-center text-[13px] text-ink-500">No runs to show.</p>
      ) : (
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id} className="overflow-hidden rounded-xl border border-line bg-white">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-canvas">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink-900">{r.recordLabel ?? 'No single record'}</span>
                    <span className="block truncate text-[12px] text-ink-500">
                      {r.automationName}
                      {r.triggerKind && r.triggerKind in TRIGGERS ? ` · ${TRIGGERS[r.triggerKind as TriggerType].label}` : ''}
                    </span>
                  </span>
                  <RunBadge status={r.status} />
                  <time dateTime={r.startedAt} className="w-[120px] shrink-0 text-right text-[12px] tabular-nums text-ink-400">{when(r.startedAt)}</time>
                </summary>
                <div className="border-t border-line-soft bg-canvas/40 px-4 py-3">
                  {r.steps.length === 0 ? <p className="text-[12.5px] text-ink-500">{r.reason ?? 'No steps ran.'}</p> : null}
                  <ol className="space-y-1.5">
                    {r.steps.map((s) => (
                      <li key={s.id} className="flex items-start gap-2 text-[12.5px] text-ink-800">
                        <Icon name={STEP_ICON[s.outcome]} size={13} className={`mt-[3px] shrink-0 ${STEP_TONE[s.outcome]}`} />
                        <span className="min-w-0 flex-1 break-words">{s.detail}</span>
                        <time dateTime={s.at} className="shrink-0 text-[11.5px] tabular-nums text-ink-400">{when(s.at)}</time>
                      </li>
                    ))}
                  </ol>
                  {r.resumeAt ? <p className="mt-2 text-[12px] text-ink-500">Carries on {when(r.resumeAt)}.</p> : null}
                  {r.recordHref ? (
                    <Link href={r.recordHref} className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-700 hover:underline">
                      Open record <Icon name="arrow-right" size={12} />
                    </Link>
                  ) : null}
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}

      {total > pageSize ? (
        <nav className="flex items-center justify-between text-[12.5px] text-ink-500">
          <span>
            {page * pageSize + 1}–{Math.min(total, (page + 1) * pageSize)} of {total}
          </span>
          <span className="flex gap-3">
            {page > 0 ? <Link href={pageHref(page - 1)} className="font-medium text-brand-700 hover:underline">Newer</Link> : null}
            {(page + 1) * pageSize < total ? <Link href={pageHref(page + 1)} className="font-medium text-brand-700 hover:underline">Older</Link> : null}
          </span>
        </nav>
      ) : null}
    </div>
  );
}
