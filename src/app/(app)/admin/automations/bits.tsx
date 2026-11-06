import type { ReactNode } from 'react';
import type { Backlog } from '@/lib/automations/backlog';
import { STATUSES, type AutomationStatus } from '@/lib/automations/steps';
import type { SystemEventKind } from '@/lib/automations/system';
import { Icon } from '@/proto/ui/icons';
import { StatusPill } from '@/proto/ui/kit';
import type { Swatch } from '@/proto/schema';

const SWATCH: Record<AutomationStatus, Swatch | undefined> = { draft: undefined, test: 'amber', on: 'green', off: undefined };

export function StatusBadge({ status }: { status: AutomationStatus }) {
  return <StatusPill label={STATUSES[status].label} swatch={SWATCH[status]} />;
}

const RUN_LABEL: Record<string, { label: string; swatch?: Swatch }> = {
  running: { label: 'Running', swatch: 'blue' },
  sending: { label: 'Sending email', swatch: 'blue' },
  waiting: { label: 'Waiting', swatch: 'amber' },
  choosing: { label: 'Waiting for a ticket choice', swatch: 'amber' },
  completed: { label: 'Completed', swatch: 'green' },
  skipped: { label: 'Stopped: skipped', swatch: 'red' },
  failed: { label: 'Stopped: failed', swatch: 'red' },
  not_matched: { label: 'Didn’t run' },
  switched_off: { label: 'Switched off' },
  cancelled: { label: 'Cancelled' },
  expired: { label: 'Expired: no ticket chosen' },
};

export function RunBadge({ status }: { status: string }) {
  const s = RUN_LABEL[status] ?? { label: status };
  return <StatusPill label={s.label} swatch={s.swatch} />;
}

export const RUN_STATUSES = Object.entries(RUN_LABEL).map(([value, s]) => ({ value, label: s.label }));

const SYSTEM_EVENT: Record<SystemEventKind, { label: string; swatch?: Swatch }> = {
  ran: { label: 'Ran', swatch: 'green' },
  failed: { label: 'Failed', swatch: 'red' },
  turned_on: { label: 'Turned on' },
  turned_off: { label: 'Turned off' },
  deleted: { label: 'Deleted' },
  restored: { label: 'Restored' },
  purged: { label: 'Purged' },
};

export function SystemEventBadge({ kind }: { kind: SystemEventKind }) {
  return <StatusPill label={SYSTEM_EVENT[kind].label} swatch={SYSTEM_EVENT[kind].swatch} />;
}

export const SYSTEM_EVENT_STATUSES = Object.entries(SYSTEM_EVENT).map(([value, s]) => ({ value, label: s.label }));

/** A hard-coded automation's entries in Run history, or all of them. */
export const systemHistoryHref = (key: string | 'all') => `/admin/automations/runs?automation=system:${key}`;

/** A link that sits in a row of buttons, looking like the small secondary one. */
export const ROW_LINK =
  'inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 transition-colors hover:border-ink-400 hover:bg-canvas';

/**
 * One automation on any of the three tabs (client, 6 Nov 2026: "Each automation should
 * have buttons/displays"). The row itself opens nothing: every action is its own button.
 */
export function AutomationCard({
  off,
  name,
  pill,
  what,
  meta,
  waiting,
  lastRun,
  lastRunBad,
  actions,
  children,
}: {
  off: boolean;
  name: string;
  pill: ReactNode;
  what: string;
  meta: { icon: 'layout-list' | 'clock' | 'play'; text: string }[];
  waiting: ReactNode;
  lastRun: string;
  lastRunBad?: boolean;
  actions: ReactNode;
  children?: ReactNode;
}) {
  return (
    <li className={`rounded-xl border bg-white ${off ? 'border-dashed border-line' : 'border-line'}`}>
      <div className="grid gap-4 px-4 py-3.5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={`text-[14px] font-semibold ${off ? 'text-ink-500' : 'text-ink-900'}`}>{name}</h3>
            {pill}
          </div>
          <p className="mt-1 max-w-[80ch] text-[12.5px] leading-relaxed text-ink-600">{what}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-400">
            {meta.map((m) => (
              <span key={m.text} className="inline-flex items-center gap-1">
                <Icon name={m.icon} size={11} /> {m.text}
              </span>
            ))}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 lg:justify-end">
          <dl className="flex gap-5 text-[12px]">
            <div>
              <dt className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Waiting</dt>
              <dd className="mt-0.5 font-semibold tabular-nums text-ink-800">{waiting}</dd>
            </div>
            <div>
              <dt className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Last run</dt>
              <dd className={`mt-0.5 font-semibold ${lastRunBad ? 'text-[#b02a30]' : 'text-ink-800'}`}>{lastRun}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-1.5">{actions}</div>
        </div>
      </div>
      {children}
    </li>
  );
}

/** One line of a Status dialog. */
export function StatusLine({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="grid gap-0.5 px-3 py-2.5 sm:grid-cols-[110px_minmax(0,1fr)] sm:gap-3">
      <dt className="text-[12px] font-semibold text-ink-500">{label}</dt>
      <dd className="text-ink-900">
        {value}
        {sub ? <span className="mt-0.5 block text-[12px] text-ink-400">{sub}</span> : null}
      </dd>
    </div>
  );
}

export function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** The one-minute timer has stopped. Without this the only sign is "Never". */
export function BehindNotice({ backlog }: { backlog: Backlog | null }) {
  if (!backlog) return null;
  return (
    <section role="status" className="flex items-start gap-3 rounded-xl border border-[#f7e0af] bg-[#fdf1d8] px-4 py-3 text-[#8a5a09]">
      <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <h2 className="text-[13.5px] font-semibold">Automations are running late</h2>
        <p className="mt-0.5 text-[12.5px] leading-relaxed">
          {backlog.count === 1 ? '1 job is' : `${backlog.count} jobs are`} waiting to run, the oldest since {when(backlog.since)}. The CRM&rsquo;s
          one-minute timer has stopped, so triggers and waits aren&rsquo;t moving. Nothing is lost: they run in order once the timer is back.
          If this stays, check Cron Jobs in Vercel.
        </p>
      </div>
    </section>
  );
}
