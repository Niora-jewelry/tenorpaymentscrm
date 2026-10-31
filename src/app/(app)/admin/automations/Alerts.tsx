'use client';

/** Spec: when an automation stops on a record, the alert shows in the admin panel. */
import { useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { AlertView } from '@/lib/automations/service';
import { Icon } from '@/proto/ui/icons';
import { IconButton } from '@/proto/ui/kit';
import { dismissAlertAction } from './actions';
import { when } from './bits';

export function Alerts({ alerts, canDismiss }: { alerts: AlertView[]; canDismiss: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (alerts.length === 0) return null;

  const dismiss = (runId: string) =>
    start(async () => {
      await dismissAlertAction(runId);
      router.refresh();
    });

  return (
    <section aria-label="Automations that stopped" className="overflow-hidden rounded-xl border border-[#f7cfd1] bg-white">
      <h2 className="flex items-center gap-2 border-b border-[#f7cfd1] bg-[#fce9ea] px-4 py-2 text-[12.5px] font-semibold text-[#b02a30]">
        <Icon name="alert-triangle" size={13} />
        {alerts.length === 1 ? '1 automation stopped' : `${alerts.length} automations stopped`}
      </h2>
      <ul className="divide-y divide-line-faint">
        {alerts.map((a) => (
          <li key={a.runId} className="flex items-start gap-3 px-4 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] text-ink-900">
                <Link href={`/admin/automations/${a.automationId}`} className="font-semibold hover:underline">{a.automationName}</Link>
                {' on '}
                {a.recordHref ? <Link href={a.recordHref} className="hover:underline">{a.recordLabel ?? 'a record'}</Link> : a.recordLabel ?? 'a record'}
              </p>
              <p className="text-[12.5px] text-ink-600">{a.reason}</p>
            </div>
            <span className="shrink-0 pt-0.5 text-[11.5px] text-ink-400">{when(a.at)}</span>
            {canDismiss ? <IconButton icon="x" size={22} title="Dismiss" onClick={() => !pending && dismiss(a.runId)} /> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
