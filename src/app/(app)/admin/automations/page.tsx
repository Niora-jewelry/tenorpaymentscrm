/**
 * Admin → Automations. Access follows the Admin module permission: Full edit
 * changes things, View only reads, Hidden never gets here.
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { automationsAccess, authorize } from '@/lib/records/permissions';
import { automationCatalog } from '@/lib/automations/catalog';
import { listAlerts, listAutomations } from '@/lib/automations/service';
import { ACTIONS, CONDITIONS, TRIGGERS, conditionsIn } from '@/lib/automations/steps';
import type { AutomationSummary } from '@/lib/automations/service';
import { Icon } from '@/proto/ui/icons';
import { Alerts } from './Alerts';
import { StatusBadge, when } from './bits';

function flowSummary(a: AutomationSummary): string {
  const starts = a.steps.triggers.map((t) => TRIGGERS[t.type].label);
  const checks = conditionsIn(a.steps).map((c) => CONDITIONS[c.type]);
  const does = a.steps.flow.flatMap((f) => (f.type === 'wait' ? [] : [ACTIONS[f.type]]));
  const parts = [starts.join(' or '), checks.length ? (checks.length === 1 ? checks[0]! : `${checks.length} conditions`) : null, does.join(', ')];
  return parts.filter(Boolean).join('  →  ') || 'Nothing added yet';
}

export default async function AdminAutomationsPage() {
  const ctx = await authorize();
  const access = await automationsAccess(ctx);
  if (access === 'hidden') redirect('/dashboard');

  const [automations, alerts, catalog] = await Promise.all([listAutomations(ctx), listAlerts(ctx), automationCatalog(ctx)]);
  const noInbox = catalog.inboxes.length === 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Automations</h1>
          <p className="text-[13px] text-ink-500">Act on records without anyone doing it by hand.</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/admin/automations/runs" className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3.5 py-2 text-[13.5px] font-semibold text-ink-700 transition-colors hover:border-ink-400 hover:bg-canvas">
            <Icon name="list" size={15} /> Run history
          </Link>
          {access === 'full' ? (
            <Link href="/admin/automations/new" className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(8,32,47,.08)] transition-colors hover:bg-accent-dim">
              <Icon name="plus" size={15} /> New automation
            </Link>
          ) : null}
        </div>
      </div>

      {access === 'view' ? (
        <p className="flex items-center gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2 text-[12.5px] text-ink-600">
          <Icon name="eye" size={13} className="text-ink-400" /> View only. You can see automations and their run history, but change nothing.
        </p>
      ) : null}

      {noInbox && access === 'full' ? (
        <p className="flex items-center gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[12.5px] text-[#8a5a09]">
          <Icon name="alert-triangle" size={13} /> No inbox is connected yet, so a Send email step has nothing to send from.
        </p>
      ) : null}

      <Alerts alerts={alerts} canDismiss={access === 'full'} />

      {automations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-full bg-brand-50 text-brand-700"><Icon name="route" size={18} /></span>
          <p className="mt-3 text-[14px] font-semibold text-ink-900">No automations yet</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[13px] text-ink-500">Start with what should set it off, like an application coming back, then add what it does.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_90px_90px_110px] gap-4 border-b border-line-soft bg-canvas px-4 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400 lg:grid">
            <span>Name</span>
            <span>What it does</span>
            <span>Status</span>
            <span className="text-right">Waiting</span>
            <span className="text-right">Last run</span>
          </div>
          <ul className="divide-y divide-line-faint">
            {automations.map((a) => (
              <li key={a.id}>
                <Link href={`/admin/automations/${a.id}`} className="grid gap-x-4 gap-y-1 px-4 py-3 transition-colors hover:bg-canvas lg:grid-cols-[minmax(0,1.1fr)_minmax(0,2fr)_90px_90px_110px] lg:items-center">
                  <span className="min-w-0">
                    <span className="block truncate text-[13.5px] font-semibold text-ink-900">{a.name}</span>
                    {a.status === 'test' && a.testRecordLabel ? <span className="block truncate text-[11.5px] text-ink-400">On {a.testRecordLabel}</span> : null}
                  </span>
                  <span className="truncate text-[12.5px] text-ink-600">{flowSummary(a)}</span>
                  <span><StatusBadge status={a.status} /></span>
                  <span className="text-[12.5px] tabular-nums text-ink-600 lg:text-right">{a.waiting || '—'}</span>
                  <span className="text-[12px] text-ink-400 lg:text-right">{a.lastRunAt ? when(a.lastRunAt) : 'Never'}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
