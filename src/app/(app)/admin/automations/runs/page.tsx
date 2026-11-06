/**
 * Run history. Spec: each run, with the record, the time, the steps that ran,
 * any steps that were skipped, and any errors. All means all (client, 6 Nov 2026: "I
 * dont see the full history of all runs"), so a run whose conditions weren't met is
 * listed too, as Didn't run.
 *
 * Every row's History button lands here. Hard-coded jobs keep their own log, so
 * `?automation=system:<key>` reads that one instead, and `system:all` all of them.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { automationsAccess, authorize } from '@/lib/records/permissions';
import { automationBacklog, listAutomations, listRuns } from '@/lib/automations/service';
import { TRIGGERS, type TriggerType } from '@/lib/automations/steps';
import { SYSTEM, SYSTEM_KEYS, isSystemKey, systemEvents } from '@/lib/automations/system';
import { Icon } from '@/proto/ui/icons';
import { BehindNotice, RunBadge, RUN_STATUSES, SYSTEM_EVENT_STATUSES, SystemEventBadge, when } from '../bits';
import { RunFilters } from './RunFilters';

const STEP_ICON = { done: 'check', waiting: 'clock', skipped: 'ban', failed: 'alert-triangle' } as const;
const STEP_TONE = { done: 'text-[#1f7a4d]', waiting: 'text-[#8a5a09]', skipped: 'text-[#b02a30]', failed: 'text-[#b02a30]' } as const;

export default async function AutomationRunsPage({ searchParams }: { searchParams: Promise<{ automation?: string; status?: string; page?: string }> }) {
  const ctx = await authorize();
  if ((await automationsAccess(ctx)) === 'hidden') redirect('/dashboard');

  const params = await searchParams;
  const page = Math.max(0, Number(params.page ?? 0) || 0);
  const hardCoded = params.automation?.startsWith('system:') ?? false;
  const key = hardCoded ? params.automation!.slice('system:'.length) : '';
  const [built, log, records, tickets, backlog] = await Promise.all([
    hardCoded ? null : listRuns(ctx, { automationId: params.automation, status: params.status, page }),
    hardCoded ? systemEvents(ctx, { key: isSystemKey(key) ? key : undefined, kind: params.status, page }) : null,
    listAutomations(ctx, 'record'),
    listAutomations(ctx, 'ticket'),
    automationBacklog(ctx),
  ]);
  const automations = [
    ...records.map((a) => ({ value: a.id, label: a.name, group: 'Record automations' })),
    ...tickets.map((a) => ({ value: a.id, label: a.name, group: 'Ticket automations' })),
    { value: 'system:all', label: 'All hard-coded automations', group: 'Hard-coded automations' },
    ...SYSTEM_KEYS.map((k) => ({ value: `system:${k}`, label: SYSTEM[k].name, group: 'Hard-coded automations' })),
  ];
  const runs = built?.runs ?? [];
  const events = log?.events ?? [];
  const total = built?.total ?? log?.total ?? 0;
  const pageSize = built?.pageSize ?? log?.pageSize ?? 1;
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
        <p className="max-w-[80ch] text-[13px] text-ink-500">
          {hardCoded
            ? 'Every run that did something or failed, and every time one was turned on or off, deleted or restored. The every-minute checks that found nothing to do are not listed.'
            : 'Every time an automation ran on a record or a ticket, including the times its conditions weren’t met.'}
        </p>
      </div>

      <BehindNotice backlog={backlog} />

      <RunFilters automations={automations} statuses={hardCoded ? SYSTEM_EVENT_STATUSES : RUN_STATUSES} automation={params.automation ?? ''} status={params.status ?? ''} />

      {runs.length === 0 && events.length === 0 ? (
        <p className="rounded-xl border border-dashed border-line bg-white px-6 py-10 text-center text-[13px] text-ink-500">No runs to show.</p>
      ) : hardCoded ? (
        <ul className="divide-y divide-line-faint overflow-hidden rounded-xl border border-line bg-white">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13.5px] font-semibold text-ink-900">{e.name}</span>
                {e.count || e.by || e.note ? (
                  <span className="block text-[12px] text-ink-500">
                    {[e.count ? `${e.count} done` : null, e.by ? `By ${e.by}` : null, e.note].filter(Boolean).join(' · ')}
                  </span>
                ) : null}
              </span>
              <SystemEventBadge kind={e.kind} />
              <time dateTime={e.at} className="w-[120px] shrink-0 text-right text-[12px] tabular-nums text-ink-400">{when(e.at)}</time>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="space-y-2">
          {runs.map((r) => (
            <li key={r.id} className="overflow-hidden rounded-xl border border-line bg-white">
              <details>
                <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 hover:bg-canvas">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13.5px] font-semibold text-ink-900">
                      {r.recordLabel ?? 'No single record'}
                      {r.caseLabel ? <span className="font-medium text-ink-500"> · {r.caseLabel}</span> : null}
                    </span>
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
                  {r.steps.length > 0 && r.reason && ['cancelled', 'expired', 'switched_off', 'choosing'].includes(r.status) ? (
                    <p className="mt-2 text-[12px] text-ink-500">{r.reason}</p>
                  ) : null}
                  {r.resumeAt ? <p className="mt-2 text-[12px] text-ink-500">Carries on {when(r.resumeAt)}.</p> : null}
                  {r.recordHref ? (
                    <Link href={r.caseLabel ? `${r.recordHref}&tab=cases` : r.recordHref} className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-brand-700 hover:underline">
                      {r.caseLabel ? 'Open ticket' : 'Open record'} <Icon name="arrow-right" size={12} />
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
