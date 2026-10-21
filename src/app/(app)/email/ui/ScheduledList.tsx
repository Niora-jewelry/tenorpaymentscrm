'use client';

/**
 * Mail this person scheduled and that has not gone yet. "Edit" cancels the
 * schedule and brings the message back into the composer, nothing lost.
 */
import { useEffect, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { fullStamp } from '@/lib/mail/dates';
import type { ComposeInit, ScheduledItem } from '@/lib/mail/viewTypes';
import { scheduledAction, undoSendAction } from '../composeActions';

export function ScheduledList({
  refreshKey,
  onEdit,
  onError,
  addressOf,
}: {
  refreshKey: number;
  onEdit: (init: ComposeInit) => void;
  onError: (message: string) => void;
  addressOf: (mailboxId: string) => string;
}) {
  const [items, setItems] = useState<ScheduledItem[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void scheduledAction().then((r) => {
      if (live) setItems(r.ok ? r.data : []);
    });
    return () => {
      live = false;
    };
  }, [refreshKey]);

  if (items === null) {
    return (
      <div aria-busy="true" className="space-y-2 p-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton h-14 w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center px-8 pt-20 text-center">
        <span className="mb-3 grid size-10 place-items-center rounded-full bg-canvas text-ink-300">
          <Icon name="clock" size={18} />
        </span>
        <p className="text-[13.5px] font-semibold text-ink-700">Nothing scheduled.</p>
        <p className="mt-1 max-w-[34ch] text-[12.5px] leading-relaxed text-ink-400">Use “Schedule send…” next to Send to choose when a message goes.</p>
      </div>
    );
  }
  return (
    <ul aria-label="Scheduled messages">
      {items.map((s) => (
        <li key={s.id} className="border-b border-line-faint px-4 py-3">
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold text-ink-900">
              <span className="font-normal text-ink-400">To: </span>
              {s.to.map((a) => a.name || a.address).join(', ') || '—'}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-600">{s.subject}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-md bg-brand-50 px-1.5 py-[2px] text-[11.5px] font-semibold text-brand-800">
              <Icon name="clock" size={11} />
              {fullStamp(s.releaseAt)}
            </span>
            <span className="truncate text-[11px] text-ink-400">{addressOf(s.mailboxId)}</span>
            <button
              type="button"
              disabled={busy === s.id}
              onClick={async () => {
                setBusy(s.id);
                const r = await undoSendAction({ outboxId: s.id });
                setBusy(null);
                if (!r.ok) return onError(r.message);
                setItems((list) => (list ?? []).filter((x) => x.id !== s.id));
                if (r.data) onEdit(r.data);
              }}
              className="ml-auto rounded-md border border-line bg-white px-2 py-1 text-[12px] font-semibold text-ink-700 transition-colors hover:border-ink-400 disabled:opacity-50"
            >
              Edit or cancel
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
