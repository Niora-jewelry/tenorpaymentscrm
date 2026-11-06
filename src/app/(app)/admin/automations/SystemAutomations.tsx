'use client';

/**
 * Automations › Hard-coded automations (client, 6 Nov 2026).
 *
 * One card per job the CRM runs by itself. Displays: what it does and where,
 * Waiting, Last run. Buttons: History, Status, Edit, Turn off — and once it is
 * off, Turn off becomes Delete (with a confirmation), and Delete moves it to the
 * Recycle Bin. Turning one back on lives in Status, so the row keeps exactly the four
 * buttons the client asked for. History opens Run history, on this job.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, Dialog, StatusPill } from '@/proto/ui/kit';
import type { SystemView } from '@/lib/automations/system';
import { setSystemAutomationAction } from './actions';
import { AutomationCard, ROW_LINK, StatusLine, systemHistoryHref, when } from './bits';

function stateOf(a: SystemView): { label: string; swatch?: 'green' | 'amber' | 'red' } {
  if (!a.enabled) return { label: 'Off' };
  if (a.lastOutcome === 'failed') return { label: 'On · last run failed', swatch: 'red' };
  return { label: 'On', swatch: 'green' };
}

export function SystemAutomations({ automations, canEdit }: { automations: SystemView[]; canEdit: boolean }) {
  if (!automations.length) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center">
        <p className="text-[14px] font-semibold text-ink-900">No hard-coded automations left</p>
        <p className="mx-auto mt-1 max-w-[46ch] text-[13px] text-ink-500">Every one has been deleted. An admin can restore them from the Recycle Bin.</p>
      </div>
    );
  }
  return (
    <ul className="space-y-3">
      {automations.map((a) => (
        <SystemRow key={a.key} a={a} canEdit={canEdit} />
      ))}
    </ul>
  );
}

function SystemRow({ a, canEdit }: { a: SystemView; canEdit: boolean }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'status' | 'off' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const s = stateOf(a);

  const act = (action: 'turn_on' | 'turn_off' | 'delete') =>
    start(async () => {
      setError(null);
      const r = await setSystemAutomationAction({ key: a.key, action });
      if (!r.ok) return setError(r.message);
      setDialog(null);
      router.refresh();
    });

  const problem = error ? (
    <p role="alert" className="mt-3 text-[12.5px] text-[#b02a30]">
      {error}
    </p>
  ) : null;

  return (
    <AutomationCard
      off={!a.enabled}
      name={a.name}
      pill={<StatusPill label={s.label} swatch={s.swatch} />}
      what={a.what}
      meta={[
        { icon: 'layout-list', text: a.where },
        { icon: 'clock', text: a.when },
      ]}
      waiting={a.waiting ?? '—'}
      lastRun={a.lastRunAt ? when(a.lastRunAt) : 'Not yet'}
      lastRunBad={a.lastOutcome === 'failed'}
      actions={
        <>
          <Link href={systemHistoryHref(a.key)} className={ROW_LINK}>
            <Icon name="list" size={13} /> History
          </Link>
          <Button size="sm" icon="info" onClick={() => setDialog('status')}>
            Status
          </Button>
          {a.edit && canEdit ? (
            <Link href={a.edit.href} title={`Its settings are in ${a.edit.label}`} className={ROW_LINK}>
              <Icon name="pencil" size={13} /> Edit
            </Link>
          ) : (
            <Button size="sm" icon="pencil" disabled title={canEdit ? 'It has nothing to set: its rules are part of the CRM.' : 'You can see automations but not change them.'}>
              Edit
            </Button>
          )}
          {canEdit ? (
            a.enabled ? (
              <Button size="sm" icon="ban" onClick={() => setDialog('off')}>
                Turn off
              </Button>
            ) : (
              <Button size="sm" variant="danger" icon="trash" onClick={() => setDialog('delete')}>
                Delete
              </Button>
            )
          ) : null}
        </>
      }
    >
      {error && dialog !== 'status' ? (
        <p role="alert" className="border-t border-line-faint px-4 py-2 text-[12.5px] text-[#b02a30]">
          {error}
        </p>
      ) : null}

      {dialog === 'status' ? (
        <Dialog title={`${a.name}: status`} onClose={() => setDialog(null)} width={500}>
          <dl className="divide-y divide-line-faint rounded-lg border border-line text-[13px]">
            <StatusLine label="State" value={a.enabled ? 'On' : 'Off'} sub={a.switchedAt ? `${a.enabled ? 'Turned on' : 'Turned off'} by ${a.switchedBy ?? 'an admin'}, ${when(a.switchedAt)}` : undefined} />
            <StatusLine label="Runs" value={a.when} />
            <StatusLine
              label="Last run"
              value={a.lastRunAt ? `${when(a.lastRunAt)} · ${a.lastOutcome === 'failed' ? 'failed' : 'worked'}` : 'Not yet'}
              sub={a.lastNote ?? undefined}
            />
            <StatusLine label="Waiting" value={a.waiting === null ? 'Nothing is queued for it' : String(a.waiting)} />
            <StatusLine label="Where" value={a.where} />
          </dl>
          {!a.enabled && canEdit ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2.5">
              <span className="text-[12.5px] text-ink-600">It is off. Nothing it would do is happening.</span>
              <Button size="sm" variant="primary" icon="check" loading={pending} onClick={() => act('turn_on')}>
                Turn back on
              </Button>
            </div>
          ) : null}
          {problem}
        </Dialog>
      ) : null}

      {dialog === 'off' ? (
        <Dialog title={`Turn off ${a.name}?`} confirmLabel={pending ? 'Turning off…' : 'Turn off'} confirmIcon="ban" onConfirm={() => act('turn_off')} onClose={() => setDialog(null)}>
          <p className="text-[13px] leading-relaxed text-ink-600">
            It stops now, including anything already waiting{a.waiting ? ` (${a.waiting} waiting)` : ''}. Nothing it would have done happens until it is turned back on from Status.
          </p>
        </Dialog>
      ) : null}

      {dialog === 'delete' ? (
        <Dialog
          title={`Delete ${a.name}?`}
          tone="danger"
          confirmLabel={pending ? 'Deleting…' : 'Delete'}
          confirmIcon="trash"
          onConfirm={() => act('delete')}
          onClose={() => setDialog(null)}
        >
          <p className="text-[13px] leading-relaxed text-ink-600">
            It comes off this list and moves to the Recycle Bin, staying off. An admin can restore it there, or purge it for good.
          </p>
        </Dialog>
      ) : null}
    </AutomationCard>
  );
}
