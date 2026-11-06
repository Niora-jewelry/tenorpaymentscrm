import type { Backlog } from '@/lib/automations/backlog';
import { STATUSES, type AutomationStatus } from '@/lib/automations/steps';
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
