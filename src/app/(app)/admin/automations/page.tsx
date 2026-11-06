/**
 * Admin → Automations. Access follows the Admin module permission: Full edit
 * changes things, View only reads, Hidden never gets here. Two builders side by
 * side: Record automations, and Ticket automations (Ticket Automation Flow
 * Builder spec: "a separate builder called Ticket automations"). A third tab,
 * Hard-coded automations, lists the jobs the CRM runs by itself (client, 6 Nov
 * 2026), each of which can be turned off.
 *
 * All three draw the same row: History, Status, Edit, Turn off, then Delete once it is
 * off. The row itself opens nothing (client: "There should be a dedicated edit button").
 */
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { automationsAccess, authorize } from '@/lib/records/permissions';
import { automationCatalog, type Catalog } from '@/lib/automations/catalog';
import { automationBacklog, listAlerts, listAutomations } from '@/lib/automations/service';
import { listSystemAutomations } from '@/lib/automations/system';
import { CONDITIONS, KINDS, TRIGGERS, actionLabel, conditionsIn, type AutomationKind } from '@/lib/automations/steps';
import type { AutomationSummary } from '@/lib/automations/service';
import { Icon } from '@/proto/ui/icons';
import { Alerts } from './Alerts';
import { AutomationRows } from './AutomationRows';
import { SystemAutomations } from './SystemAutomations';
import { BehindNotice, systemHistoryHref } from './bits';

function flowSummary(a: AutomationSummary): string {
  const starts = a.steps.triggers.map((t) => TRIGGERS[t.type].label);
  const checks = conditionsIn(a.steps).map((c) => CONDITIONS[c.type]);
  const does = a.steps.flow.flatMap((f) => (f.type === 'wait' ? [] : [actionLabel(f.type, a.kind)]));
  const parts = [starts.join(' or '), checks.length ? (checks.length === 1 ? checks[0]! : `${checks.length} conditions`) : null, does.join(', ')];
  return parts.filter(Boolean).join('  →  ') || 'Nothing added yet';
}

/** The modules it is tied to, by its triggers and its Only in module conditions. */
function whereItActs(a: AutomationSummary, catalog: Catalog): string {
  if (a.kind === 'ticket') return 'Every ticket';
  const labels = new Set<string>();
  const moduleLabel = (id: string) => catalog.modules.find((m) => m.value === id)?.label;
  for (const t of a.steps.triggers) {
    const label = 'moduleId' in t ? moduleLabel(t.moduleId) : t.type === 'stage' ? catalog.pipelines.find((p) => p.id === t.pipelineId)?.moduleLabel : undefined;
    if (label) labels.add(label);
  }
  for (const c of conditionsIn(a.steps)) {
    const label = c.type === 'in_module' ? moduleLabel(c.moduleId) : undefined;
    if (label) labels.add(label);
  }
  return labels.size ? [...labels].join(', ') : 'Every module';
}

const EMPTY: Record<AutomationKind, { title: string; body: string; icon: 'route' | 'lifebuoy' }> = {
  record: { title: 'No automations yet', body: 'Start with what should set it off, like an application coming back, then add what it does.', icon: 'route' },
  ticket: {
    title: 'No ticket automations yet',
    body: 'Start a flow from the Awaiting client button on a ticket, or from an email arriving in your support inbox.',
    icon: 'lifebuoy',
  },
};

export default async function AdminAutomationsPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const ctx = await authorize();
  const access = await automationsAccess(ctx);
  if (access === 'hidden') redirect('/dashboard');

  const asked = (await searchParams).kind;
  const system = asked === 'system';
  const kind: AutomationKind = asked === 'ticket' ? 'ticket' : 'record';
  const [records, tickets, alerts, catalog, hardCoded, backlog] = await Promise.all([
    listAutomations(ctx, 'record'),
    listAutomations(ctx, 'ticket'),
    listAlerts(ctx),
    automationCatalog(ctx),
    listSystemAutomations(ctx),
    automationBacklog(ctx),
  ]);
  const automations = kind === 'ticket' ? tickets : records;
  const counts: Record<AutomationKind, number> = { record: records.length, ticket: tickets.length };
  const noInbox = catalog.inboxes.length === 0;

  return (
    <div className="space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-ink-900">Automations</h1>
          <p className="text-[13px] text-ink-500">
            {system
              ? 'What the CRM does by itself. Turn one off to stop it.'
              : kind === 'ticket'
                ? 'Act on tickets without anyone doing it by hand.'
                : 'Act on records without anyone doing it by hand.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={system ? systemHistoryHref('all') : '/admin/automations/runs'} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3.5 py-2 text-[13.5px] font-semibold text-ink-700 transition-colors hover:border-ink-400 hover:bg-canvas">
            <Icon name="list" size={15} /> Run history
          </Link>
          {access === 'full' && !system ? (
            <Link
              href={`/admin/automations/new?kind=${kind}`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3.5 py-2 text-[13.5px] font-semibold text-accent-ink shadow-[0_1px_2px_rgba(14,28,52,.08)] transition-colors hover:bg-accent-dim"
            >
              <Icon name="plus" size={15} /> {kind === 'ticket' ? 'New ticket automation' : 'New automation'}
            </Link>
          ) : null}
        </div>
      </div>

      <nav aria-label="Builders" className="flex gap-1 border-b border-line">
        {(Object.keys(KINDS) as AutomationKind[]).map((k) => (
          <Link
            key={k}
            href={k === 'record' ? '/admin/automations' : '/admin/automations?kind=ticket'}
            aria-current={!system && k === kind ? 'page' : undefined}
            className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13.5px] font-semibold transition-colors ${
              !system && k === kind ? 'border-brand-700 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-900'
            }`}
          >
            <Icon name={k === 'ticket' ? 'lifebuoy' : 'route'} size={14} className={!system && k === kind ? 'text-brand-700' : 'text-ink-400'} />
            {KINDS[k].label}
            <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${!system && k === kind ? 'bg-brand-50 text-brand-800' : 'bg-canvas text-ink-500'}`}>{counts[k]}</span>
          </Link>
        ))}
        <Link
          href="/admin/automations?kind=system"
          aria-current={system ? 'page' : undefined}
          className={`-mb-px inline-flex items-center gap-2 border-b-2 px-3 py-2 text-[13.5px] font-semibold transition-colors ${
            system ? 'border-brand-700 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-900'
          }`}
        >
          <Icon name="cog" size={14} className={system ? 'text-brand-700' : 'text-ink-400'} />
          Hard-coded automations
          <span className={`rounded-full px-1.5 text-[11px] tabular-nums ${system ? 'bg-brand-50 text-brand-800' : 'bg-canvas text-ink-500'}`}>{hardCoded.length}</span>
        </Link>
      </nav>

      <BehindNotice backlog={backlog} />

      {access === 'view' ? (
        <p className="flex items-center gap-2 rounded-lg border border-line-soft bg-canvas px-3 py-2 text-[12.5px] text-ink-600">
          <Icon name="eye" size={13} className="text-ink-400" /> View only. You can see automations and their run history, but change nothing.
        </p>
      ) : null}

      {system ? <SystemAutomations automations={hardCoded} canEdit={access === 'full'} /> : null}

      {system ? null : noInbox && access === 'full' ? (
        <p className="flex items-center gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[12.5px] text-[#8a5a09]">
          <Icon name="alert-triangle" size={13} /> No inbox is connected yet, so a Send email step has nothing to send from.
        </p>
      ) : null}

      {system ? null : <Alerts alerts={alerts} canDismiss={access === 'full'} />}

      {system ? null : automations.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center">
          <span className="mx-auto grid size-10 place-items-center rounded-full bg-brand-50 text-brand-700"><Icon name={EMPTY[kind].icon} size={18} /></span>
          <p className="mt-3 text-[14px] font-semibold text-ink-900">{EMPTY[kind].title}</p>
          <p className="mx-auto mt-1 max-w-[46ch] text-[13px] text-ink-500">{EMPTY[kind].body}</p>
        </div>
      ) : (
        <AutomationRows
          noun={KINDS[kind].noun}
          canEdit={access === 'full'}
          rows={automations.map((a) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            what: flowSummary(a),
            where: whereItActs(a, catalog),
            testTarget: a.status === 'test' ? (a.testCaseLabel ?? a.testRecordLabel) : null,
            waiting: a.waiting,
            lastRunAt: a.lastRunAt,
          }))}
        />
      )}
    </div>
  );
}
