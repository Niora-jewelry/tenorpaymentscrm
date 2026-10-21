'use client';

/**
 * Middle pane: one row per conversation, newest first, grouped the way a
 * mail client groups (Pinned · Today · Yesterday · Tuesday · Last week …).
 *
 * Unread is carried by THREE cues at once — the brand edge bar, the weight
 * of the sender, and the colour of the subject — so it survives a quick scan
 * and does not depend on colour alone.
 *
 * ↑/↓ move through conversations while the list has focus; the next page
 * loads as the end scrolls into view.
 */
import { useEffect, useMemo, useRef } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { dateGroup, rowStamp } from '@/lib/mail/dates';
import type { ConversationRow } from '@/lib/mail/viewTypes';
import { swatchFor } from './people';

export type ListFilter = 'all' | 'unread' | 'attachments';

export function ConversationList({
  pinned,
  rows,
  selectedKey,
  onOpen,
  hasMore,
  loadingMore,
  onLoadMore,
  showMailbox,
  mailboxLabel,
  now,
  checked,
  onCheck,
}: {
  pinned: ConversationRow[];
  rows: ConversationRow[];
  selectedKey: string | null;
  onOpen: (row: ConversationRow) => void;
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  showMailbox: boolean;
  mailboxLabel: (mailboxId: string) => string;
  now: Date;
  /** Multi-select: row ids (mailboxId~key) that are ticked; null when the person can't act. */
  checked: ReadonlySet<string> | null;
  onCheck: (row: ConversationRow, range: boolean) => void;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onLoadMore();
    }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, onLoadMore]);

  const groups = useMemo(() => {
    const out: Array<{ label: string; rows: ConversationRow[] }> = [];
    if (pinned.length) out.push({ label: 'Pinned', rows: pinned });
    for (const r of rows) {
      const label = dateGroup(r.lastAt, now);
      const last = out[out.length - 1];
      if (last && last.label === label && label !== 'Pinned') last.rows.push(r);
      else out.push({ label, rows: [r] });
    }
    return out;
  }, [pinned, rows, now]);

  const flat = useMemo(() => [...pinned, ...rows], [pinned, rows]);
  const rowKey = (r: ConversationRow) => `${r.mailboxId}~${r.key}`;

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const i = flat.findIndex((r) => rowKey(r) === selectedKey);
    const next = flat[e.key === 'ArrowDown' ? Math.min(i + 1, flat.length - 1) : Math.max(i - 1, 0)];
    if (!next) return;
    onOpen(next);
    listRef.current?.querySelector<HTMLElement>(`[data-row="${CSS.escape(rowKey(next))}"]`)?.focus();
  }

  return (
    <div ref={listRef} role="listbox" aria-label="Conversations" onKeyDown={onKeyDown} className="pb-6">
      {groups.map((g) => (
        <div key={`${g.label}-${g.rows[0] ? rowKey(g.rows[0]) : ''}`} role="group" aria-label={g.label}>
          <div className="sticky top-0 z-[1] flex items-center gap-1.5 border-b border-line-faint bg-white/95 px-4 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-[.1em] text-ink-400 backdrop-blur-sm">
            {g.label === 'Pinned' ? <Icon name="pin" size={11} /> : null}
            {g.label}
          </div>
          {g.rows.map((r) => (
            <Row
              key={rowKey(r)}
              row={r}
              id={rowKey(r)}
              selected={rowKey(r) === selectedKey}
              onOpen={() => onOpen(r)}
              now={now}
              mailbox={showMailbox ? mailboxLabel(r.mailboxId) : null}
              checked={checked ? checked.has(rowKey(r)) : null}
              selecting={Boolean(checked && checked.size > 0)}
              onCheck={(range) => onCheck(r, range)}
            />
          ))}
        </div>
      ))}
      {hasMore ? (
        <div ref={sentinel} className="flex items-center justify-center gap-2 py-5 text-[12px] text-ink-400">
          {loadingMore ? (
            <>
              <Spinner /> Loading older conversations…
            </>
          ) : (
            <button type="button" onClick={onLoadMore} className="font-semibold text-ink-500 hover:text-ink-900">
              Load more
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Row({
  row,
  id,
  selected,
  onOpen,
  now,
  mailbox,
  checked,
  selecting,
  onCheck,
}: {
  row: ConversationRow;
  id: string;
  selected: boolean;
  onOpen: () => void;
  now: Date;
  mailbox: string | null;
  checked: boolean | null;
  selecting: boolean;
  onCheck: (range: boolean) => void;
}) {
  const unread = row.unread > 0;
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-row={id}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className={`group/row relative cursor-pointer border-b border-line-faint py-2.5 pl-9 pr-4 outline-none transition-colors duration-100 [content-visibility:auto] [contain-intrinsic-size:auto_76px] focus-visible:bg-brand-50/60 ${
        selected || checked ? 'bg-brand-50' : 'hover:bg-canvas'
      }`}
    >
      {checked !== null ? (
        <span className="absolute left-0 top-0 grid h-full w-9 place-items-start justify-center pt-[13px]">
          <input
            type="checkbox"
            checked={checked}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onCheck((e.nativeEvent as MouseEvent).shiftKey)}
            aria-label={`Select conversation: ${row.subject}`}
            className={`size-[15px] cursor-pointer accent-brand-600 transition-opacity ${
              checked || selecting ? 'opacity-100' : 'opacity-0 focus:opacity-100 group-hover/row:opacity-100'
            }`}
          />
        </span>
      ) : null}
      {unread || selected ? (
        <span
          aria-hidden
          className={`absolute inset-y-0 left-0 w-[3px] ${selected ? 'bg-brand-600' : 'bg-brand-500'}`}
        />
      ) : null}

      <div className="flex items-baseline gap-2">
        <span className={`min-w-0 flex-1 truncate text-[13.5px] ${unread ? 'font-semibold text-ink-900' : 'text-ink-700'}`}>
          {row.outbound ? <span className="font-normal text-ink-400">To: </span> : null}
          {row.who}
        </span>
        {row.important ? (
          <span title="High importance" className="text-[12px] font-bold leading-none text-[#d33b41]">!</span>
        ) : null}
        <span className={`shrink-0 text-[11.5px] tabular ${unread ? 'font-semibold text-brand-700' : 'text-ink-400'}`}>
          {rowStamp(row.lastAt, now)}
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-1.5">
        {row.hasDraft ? <span className="shrink-0 text-[12px] font-semibold text-[#b02a30]">[Draft]</span> : null}
        <span className={`min-w-0 truncate text-[12.5px] ${unread ? 'font-semibold text-brand-800' : 'text-ink-600'}`}>
          {row.subject}
        </span>
        {row.count > 1 ? (
          <span className="shrink-0 rounded-full bg-line-soft px-1.5 text-[10.5px] font-semibold tabular text-ink-500">{row.count}</span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-ink-400">
          {row.pinned ? <Icon name="pin" size={12} /> : null}
          {row.hasAttachments ? <Icon name="paperclip" size={12} /> : null}
        </span>
      </div>

      <div className="mt-0.5 flex items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-[12px] leading-[1.45] text-ink-400">{row.preview || ' '}</p>
        {mailbox ? (
          <span className="inline-flex max-w-[40%] shrink-0 items-center gap-1 text-[10.5px] text-ink-400" title={mailbox}>
            <span aria-hidden className="size-[6px] shrink-0 rounded-full" style={{ background: swatchFor(mailbox).dot }} />
            <span className="truncate">{mailbox.split('@')[0]}</span>
          </span>
        ) : null}
      </div>

      {row.firstAttachment ? (
        <span className="mt-1.5 inline-flex max-w-[85%] items-center gap-1 rounded-md border border-line bg-white px-1.5 py-[1px] text-[11px] text-ink-600">
          <Icon name="paperclip" size={10} className="shrink-0 text-ink-400" />
          <span className="truncate">{row.firstAttachment}</span>
          {row.attachmentCount > 1 ? <span className="shrink-0 text-ink-400">+{row.attachmentCount - 1}</span> : null}
        </span>
      ) : null}
    </div>
  );
}
