import { STATUSES, type AutomationStatus } from '@/lib/automations/steps';
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
  completed: { label: 'Completed', swatch: 'green' },
  skipped: { label: 'Stopped: skipped', swatch: 'red' },
  failed: { label: 'Stopped: failed', swatch: 'red' },
  not_matched: { label: 'Didn’t run' },
  switched_off: { label: 'Switched off' },
  cancelled: { label: 'Cancelled' },
};

export function RunBadge({ status }: { status: string }) {
  const s = RUN_LABEL[status] ?? { label: status };
  return <StatusPill label={s.label} swatch={s.swatch} />;
}

export const RUN_STATUSES = Object.entries(RUN_LABEL).map(([value, s]) => ({ value, label: s.label }));

export function when(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
