'use client';

/**
 * Under a conversation's header in the Chat module: the records it is linked to, and
 * linking it to another. Draws nothing when there is neither, so a look-only view of
 * someone's chat stays as it was.
 */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { ChatRecords } from '@/lib/msteams/types';
import { findRecordsToLinkAction, linkChatToRecordAction } from '../actions';

export function ChatRecordLinks({ chatKey, online }: { chatKey: string; online: boolean }) {
  const [data, setData] = useState<ChatRecords | null>(null);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/msteams/chat-records?key=${encodeURIComponent(chatKey)}`, { cache: 'no-store' });
      if (res.ok) setData((await res.json()) as ChatRecords);
    } catch {
      // The conversation still works without this row; it comes back on the next open.
    }
  }, [chatKey]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the first load, when the conversation opens
    void load();
  }, [load]);

  if (!data || (data.records.length === 0 && !data.canLink)) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-b border-line bg-canvas px-5 py-1.5 text-[12px]">
      {data.records.map((r) => (
        <Link key={r.recordId} href={r.href} className="inline-flex max-w-[260px] items-center gap-1 rounded border border-line bg-white px-1.5 py-0.5 font-medium text-ink-700 hover:border-ink-400">
          <Icon name="link" size={11} className="shrink-0 text-ink-400" />
          <span className="truncate">{r.name}</span>
        </Link>
      ))}
      {data.canLink ? (
        <button type="button" disabled={!online} onClick={() => setPicking(true)} className="inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 font-medium text-ink-600 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-50">
          <Icon name="plus" size={11} />
          Link to a record
        </button>
      ) : null}
      {picking ? (
        <RecordPicker
          chatKey={chatKey}
          linkedIds={data.records.map((r) => r.recordId)}
          onClose={() => setPicking(false)}
          onLinked={() => {
            setPicking(false);
            void load();
          }}
        />
      ) : null}
    </div>
  );
}

function RecordPicker({ chatKey, linkedIds, onClose, onLinked }: { chatKey: string; linkedIds: string[]; onClose: () => void; onLinked: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const search = (text: string) => {
    setQ(text);
    setError(null);
    const ticket = ++latest.current;
    if (text.trim().length < 2) {
      setResults(null);
      return;
    }
    window.setTimeout(() => {
      if (ticket !== latest.current) return;
      void findRecordsToLinkAction({ q: text }).then((r) => {
        if (ticket !== latest.current) return;
        if (r.ok) setResults(r.data);
        else setError(r.message);
      });
    }, 250);
  };

  const link = async (recordId: string) => {
    setBusy(true);
    setError(null);
    const r = await linkChatToRecordAction({ recordId, key: chatKey });
    setBusy(false);
    if (r.ok) onLinked();
    else setError(r.message);
  };

  const shown = (results ?? []).filter((r) => !linkedIds.includes(r.id));

  return (
    <Dialog title="Link to a record" onClose={onClose} width={480}>
      <div className="space-y-2.5">
        <p className="text-[12.5px] text-ink-600">
          People who see all of that record&rsquo;s communication will see this chat&rsquo;s name and who linked it. Only people in the chat can read it.
        </p>
        <input
          autoFocus
          value={q}
          onChange={(e) => search(e.target.value)}
          placeholder="Search by merchant name"
          aria-label="Search by merchant name"
          className="w-full rounded-md border border-line bg-white px-2.5 py-1.5 text-[13px] text-ink-800 outline-none focus:border-ink-500"
        />
        {error ? <p role="alert" className="text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}
        {results !== null ? (
          <ul className="max-h-[260px] divide-y divide-line overflow-y-auto rounded-md border border-line">
            {shown.length === 0 ? <li className="px-3 py-5 text-center text-[12.5px] text-ink-400">No records you can link this to.</li> : null}
            {shown.map((r) => (
              <li key={r.id} className="flex items-center gap-2 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-800">{r.name}</span>
                <Button size="sm" variant="secondary" loading={busy} onClick={() => void link(r.id)}>
                  Link
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Dialog>
  );
}
