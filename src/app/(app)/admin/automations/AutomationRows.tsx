'use client';

/**
 * Automations › Record automations and Ticket automations, one row each (client, 6 Nov
 * 2026). The same buttons as a hard-coded automation: History, Status, Edit, Turn off,
 * and once it is off, Delete with a confirmation. Turning off stops everything it had
 * under way, which `automation_set_status` does. A draft has nothing running, so it goes
 * straight to Delete. Delete moves it to the Recycle Bin.
 */
import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, Dialog } from '@/proto/ui/kit';
import { STATUSES, type AutomationStatus } from '@/lib/automations/steps';
import { deleteAutomationAction, setStatusAction } from './actions';
import { AutomationCard, ROW_LINK, StatusBadge, StatusLine, when } from './bits';

export type AutomationRowView = {
  id: string;
  name: string;
  status: AutomationStatus;
  what: string;
  where: string;
  testTarget: string | null;
  waiting: number;
  lastRunAt: string | null;
};

export function AutomationRows({ rows, canEdit, noun }: { rows: AutomationRowView[]; canEdit: boolean; noun: string }) {
  return (
    <ul className="space-y-3">
      {rows.map((a) => (
        <AutomationRow key={a.id} a={a} canEdit={canEdit} noun={noun} />
      ))}
    </ul>
  );
}

function AutomationRow({ a, canEdit, noun }: { a: AutomationRowView; canEdit: boolean; noun: string }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'status' | 'off' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const running = a.status === 'on' || a.status === 'test';

  const finish = (r: { ok: true } | { ok: false; message: string }) => {
    if (!r.ok) return setError(r.message);
    setDialog(null);
    router.refresh();
  };
  const setStatus = (status: 'on' | 'off') =>
    start(async () => {
      setError(null);
      finish(await setStatusAction({ id: a.id, status, testRecordId: null, testCaseId: null }));
    });
  const remove = () =>
    start(async () => {
      setError(null);
      finish(await deleteAutomationAction(a.id));
    });
  const open = (next: typeof dialog) => {
    setError(null);
    setDialog(next);
  };

  const problem = error ? (
    <p role="alert" className="mt-3 text-[12.5px] text-[#b02a30]">
      {error}
    </p>
  ) : null;
  const waitingWords = a.waiting === 1 ? `1 ${noun} is waiting` : `${a.waiting} ${noun}s are waiting`;

  return (
    <AutomationCard
      off={!running}
      name={a.name}
      pill={<StatusBadge status={a.status} />}
      what={a.what}
      meta={[{ icon: 'layout-list', text: a.where }, ...(a.testTarget ? [{ icon: 'play' as const, text: `Testing on ${a.testTarget}` }] : [])]}
      waiting={a.waiting || '—'}
      lastRun={a.lastRunAt ? when(a.lastRunAt) : 'Never'}
      actions={
        <>
          <Link href={`/admin/automations/runs?automation=${a.id}`} className={ROW_LINK}>
            <Icon name="list" size={13} /> History
          </Link>
          <Button size="sm" icon="info" onClick={() => open('status')}>
            Status
          </Button>
          <Link href={`/admin/automations/${a.id}`} className={ROW_LINK}>
            <Icon name={canEdit ? 'pencil' : 'eye'} size={13} /> {canEdit ? 'Edit' : 'View'}
          </Link>
          {canEdit ? (
            running ? (
              <Button size="sm" icon="ban" onClick={() => open('off')}>
                Turn off
              </Button>
            ) : (
              <Button size="sm" variant="danger" icon="trash" onClick={() => open('delete')}>
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
            <StatusLine label="State" value={STATUSES[a.status].label} sub={a.testTarget ? `Testing on ${a.testTarget}` : undefined} />
            <StatusLine label="Last run" value={a.lastRunAt ? when(a.lastRunAt) : 'Never'} />
            <StatusLine label="Waiting" value={a.waiting ? waitingWords : 'Nothing is waiting on it'} />
            <StatusLine label="Where" value={a.where} />
          </dl>
          {a.status === 'off' && canEdit ? (
            <div className="mt-3 flex items-center justify-between gap-3 rounded-lg bg-canvas px-3 py-2.5">
              <span className="text-[12.5px] text-ink-600">It is off. Turned on, it runs on every matching {noun} from then on.</span>
              <Button size="sm" variant="primary" icon="check" loading={pending} onClick={() => setStatus('on')}>
                Turn on
              </Button>
            </div>
          ) : null}
          {a.status === 'draft' ? <p className="mt-3 text-[12.5px] text-ink-500">It is a draft and has never run. Finish it in {canEdit ? 'Edit' : 'the builder'}.</p> : null}
          {problem}
        </Dialog>
      ) : null}

      {dialog === 'off' ? (
        <Dialog title={`Turn off ${a.name}?`} confirmLabel={pending ? 'Turning off…' : 'Turn off'} confirmIcon="ban" onConfirm={() => setStatus('off')} onClose={() => setDialog(null)}>
          <p className="text-[13px] leading-relaxed text-ink-600">
            It stops now, along with everything it has under way{a.waiting ? `: ${waitingWords} and won’t finish` : ''}. Emails it was holding are cancelled.
          </p>
        </Dialog>
      ) : null}

      {dialog === 'delete' ? (
        <Dialog title={`Delete ${a.name}?`} tone="danger" confirmLabel={pending ? 'Deleting…' : 'Delete'} confirmIcon="trash" onConfirm={remove} onClose={() => setDialog(null)}>
          <p className="text-[13px] leading-relaxed text-ink-600">It moves to the Recycle Bin, where an admin can restore it or purge it. Its run history stays.</p>
        </Dialog>
      ) : null}
    </AutomationCard>
  );
}
