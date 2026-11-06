'use client';

/**
 * Automations › Hard-coded automations (client, 6 Nov 2026).
 *
 * One card per job the CRM runs by itself. Displays: what it does and where,
 * Waiting, Last run. Buttons: History, Status, Edit, Turn off — and once it is
 * off, Turn off becomes Delete (with a confirmation). Turning one back on lives
 * in Status, so the row keeps exactly the four buttons the client asked for.
 */
import { useEffect, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, Dialog, Spinner, StatusPill } from '@/proto/ui/kit';
import type { SystemEvent, SystemView } from '@/lib/automations/system';
import { setSystemAutomationAction, systemHistoryAction } from './actions';
import { when } from './bits';

function stateOf(a: SystemView): { label: string; swatch?: 'green' | 'amber' | 'red' } {
  if (!a.enabled) return { label: 'Off' };
  if (a.lastOutcome === 'failed') return { label: 'On · last run failed', swatch: 'red' };
  return { label: 'On', swatch: 'green' };
}

const EVENT_TEXT: Record<SystemEvent['kind'], string> = {
  ran: 'Ran',
  failed: 'Failed',
  turned_on: 'Turned on',
  turned_off: 'Turned off',
  deleted: 'Deleted',
};

export function SystemAutomations({ automations, canEdit }: { automations: SystemView[]; canEdit: boolean }) {
  if (!automations.length) {
    return (
      <div className="rounded-xl border border-dashed border-line bg-white px-6 py-12 text-center">
        <p className="text-[14px] font-semibold text-ink-900">No hard-coded automations left</p>
        <p className="mx-auto mt-1 max-w-[46ch] text-[13px] text-ink-500">Every one has been deleted.</p>
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
  const [dialog, setDialog] = useState<'history' | 'status' | 'off' | 'delete' | null>(null);
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

  return (
    <li className={`rounded-xl border bg-white ${a.enabled ? 'border-line' : 'border-dashed border-line'}`}>
      <div className="grid gap-4 px-4 py-3.5 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={`text-[14px] font-semibold ${a.enabled ? 'text-ink-900' : 'text-ink-500'}`}>{a.name}</h3>
            <StatusPill label={s.label} swatch={s.swatch} />
          </div>
          <p className="mt-1 max-w-[80ch] text-[12.5px] leading-relaxed text-ink-600">{a.what}</p>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-ink-400">
            <span className="inline-flex items-center gap-1">
              <Icon name="layout-list" size={11} /> {a.where}
            </span>
            <span className="inline-flex items-center gap-1">
              <Icon name="clock" size={11} /> {a.when}
            </span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-3 lg:justify-end">
          <dl className="flex gap-5 text-[12px]">
            <div>
              <dt className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Waiting</dt>
              <dd className="mt-0.5 font-semibold tabular-nums text-ink-800">{a.waiting ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Last run</dt>
              <dd className={`mt-0.5 font-semibold ${a.lastOutcome === 'failed' ? 'text-[#b02a30]' : 'text-ink-800'}`}>{a.lastRunAt ? when(a.lastRunAt) : 'Not yet'}</dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" icon="list" onClick={() => setDialog('history')}>
              History
            </Button>
            <Button size="sm" icon="info" onClick={() => setDialog('status')}>
              Status
            </Button>
            {a.edit && canEdit ? (
              <Link
                href={a.edit.href}
                title={`Its settings are in ${a.edit.label}`}
                className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-700 transition-colors hover:border-ink-400 hover:bg-canvas"
              >
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
          </div>
        </div>
      </div>

      {dialog === 'history' ? <HistoryDialog a={a} onClose={() => setDialog(null)} /> : null}

      {dialog === 'status' ? (
        <Dialog title={`${a.name}: status`} onClose={() => setDialog(null)} width={500}>
          <dl className="divide-y divide-line-faint rounded-lg border border-line text-[13px]">
            <Row label="State" value={a.enabled ? 'On' : 'Off'} sub={a.switchedAt ? `${a.enabled ? 'Turned on' : 'Turned off'} by ${a.switchedBy ?? 'an admin'}, ${when(a.switchedAt)}` : undefined} />
            <Row label="Runs" value={a.when} />
            <Row
              label="Last run"
              value={a.lastRunAt ? `${when(a.lastRunAt)} · ${a.lastOutcome === 'failed' ? 'failed' : 'worked'}` : 'Not yet'}
              sub={a.lastNote ?? undefined}
            />
            <Row label="Waiting" value={a.waiting === null ? 'Nothing is queued for it' : String(a.waiting)} />
            <Row label="Where" value={a.where} />
          </dl>
          {!a.enabled && canEdit ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2.5">
              <span className="text-[12.5px] text-ink-600">It is off. Nothing it would do is happening.</span>
              <Button size="sm" variant="primary" icon="check" loading={pending} onClick={() => act('turn_on')}>
                Turn back on
              </Button>
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 text-[12.5px] text-[#b02a30]">
              {error}
            </p>
          ) : null}
        </Dialog>
      ) : null}

      {dialog === 'off' ? (
        <Dialog title={`Turn off ${a.name}?`} confirmLabel={pending ? 'Turning off…' : 'Turn off'} confirmIcon="ban" onConfirm={() => act('turn_off')} onClose={() => setDialog(null)}>
          <p className="text-[13px] leading-relaxed text-ink-600">
            It stops now, including anything already waiting{a.waiting ? ` (${a.waiting} waiting)` : ''}. Nothing it would have done happens until it is turned back on from Status.
          </p>
          {error ? (
            <p role="alert" className="mt-2 text-[12.5px] text-[#b02a30]">
              {error}
            </p>
          ) : null}
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
            It comes off this list and stays off for good. This can’t be undone from here.
          </p>
          {error ? (
            <p role="alert" className="mt-2 text-[12.5px] text-[#b02a30]">
              {error}
            </p>
          ) : null}
        </Dialog>
      ) : null}
    </li>
  );
}

function Row({ label, value, sub }: { label: string; value: string; sub?: string }) {
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

function HistoryDialog({ a, onClose }: { a: SystemView; onClose: () => void }) {
  const [events, setEvents] = useState<SystemEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void systemHistoryAction(a.key).then((r) => {
      if (!live) return;
      if (r.ok) setEvents(r.data);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [a.key]);
  return (
    <Dialog title={`${a.name}: history`} onClose={onClose} width={560}>
      <p className="mb-3 text-[12.5px] text-ink-500">Runs that did something or failed, and every time it was turned on or off.</p>
      {error ? (
        <p role="alert" className="text-[12.5px] text-[#b02a30]">
          {error}
        </p>
      ) : events === null ? (
        <p className="flex items-center gap-2 text-[12.5px] text-ink-500">
          <Spinner /> Loading…
        </p>
      ) : events.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-ink-500">Nothing yet.</p>
      ) : (
        <ul className="max-h-[50vh] divide-y divide-line-faint overflow-y-auto rounded-lg border border-line">
          {events.map((e) => (
            <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-3 py-2 text-[12.5px]">
              <span className={e.kind === 'failed' ? 'font-semibold text-[#b02a30]' : 'text-ink-800'}>
                {EVENT_TEXT[e.kind]}
                {e.kind === 'ran' && e.count ? ` · ${e.count} done` : ''}
                {e.by ? ` by ${e.by}` : ''}
                {e.note ? <span className="block text-[12px] font-normal text-ink-400">{e.note}</span> : null}
              </span>
              <span className="text-ink-400">{when(e.at)}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
