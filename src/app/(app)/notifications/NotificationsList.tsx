'use client';

/**
 * The Notifications module. Unread / Read / All, mark one or all read (and
 * back to unread), and a click that lands on the exact update, reply or
 * field the mention came from. Follows the live count: when a mention
 * arrives or is read elsewhere (another tab, the drawer), the list refetches.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Button, Spinner } from '@/proto/ui/kit';
import { relative } from '@/proto/ui/tokens';
import { UserAvatar } from '../[module]/UserAvatar';
import { usePeople, usePeopleById } from '@/proto/ui/people';
import { notificationsAction, openNotificationAction, markNotificationsAction, markAllReadAction } from '../actions';
import { announceNotificationsChanged, CHANGED_EVENT } from '../useLiveCounts';
import type { NotificationView, NotificationCursor, NotificationFilter } from '@/lib/records/notifications';

type Page = { rows: NotificationView[]; next: NotificationCursor };

const FILTERS: Array<{ id: NotificationFilter; label: string }> = [
  { id: 'unread', label: 'Unread' },
  { id: 'read', label: 'Read' },
  { id: 'all', label: 'All' },
];

const PHONE_ICON: Record<string, IconName> = { call: 'phone', voicemail: 'mic', recording: 'mic', sms: 'message-square' };

/** "Update", "Case #10012", "Field: Chargeback Fee" — where the mention sits. */
function whereOf(n: NotificationView): { icon: IconName; label: string; detail?: string } {
  switch (n.sourceKind) {
    case 'mention_update':
      return { icon: 'message-square', label: n.parentUpdateId ? 'Reply' : 'Update' };
    case 'mention_case_reply':
      return { icon: 'lifebuoy', label: n.caseNumber ? `Case #${n.caseNumber}` : 'Case' };
    case 'mention_field':
      return { icon: 'file-pen', label: `Field: ${n.fieldLabel ?? n.fieldKey ?? ''}` };
    case 'agreement':
      return { icon: 'file-pen', label: 'Agreement' };
    case 'automation':
      return { icon: 'route', label: 'Automation' };
    case 'automation_alert':
      return { icon: 'alert-triangle', label: 'Automation stopped' };
    default:
      return { icon: PHONE_ICON[n.sourceKind] ?? 'bell', label: n.sourceKind === 'sms' ? 'Text message' : n.sourceKind === 'call' ? 'Call' : n.sourceKind === 'voicemail' ? 'Voicemail' : 'Recording' };
  }
}

export function NotificationsList({
  initial,
  initialUnread,
  canSeeAll = false,
  viewerId,
}: {
  initial: Page;
  initialUnread: number;
  /** Notifications = All users (Permissions spec): may look at someone
   *  else's notifications, or everyone's. */
  canSeeAll?: boolean;
  viewerId?: string;
}) {
  const router = useRouter();
  const people = usePeople();
  const [who, setWho] = useState<string>('me');
  const [filter, setFilter] = useState<NotificationFilter>('unread');
  const [pages, setPages] = useState<Record<NotificationFilter, Page | null>>({ unread: initial, read: null, all: null });
  const [loading, setLoading] = useState(false);
  const [more, startMore] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [unread, setUnread] = useState(initialUnread);
  const seq = useRef(0);
  const whoRef = useRef('me');
  const own = who === 'me' || who === viewerId;

  const load = useCallback(async (f: NotificationFilter, cursor: NotificationCursor, append: boolean) => {
    const n = ++seq.current;
    if (!append) setLoading(true);
    try {
      const page = await notificationsAction({ filter: f, cursor, who: whoRef.current });
      if (n !== seq.current && !append) return;
      setPages((p) => ({ ...p, [f]: append && p[f] ? { rows: [...p[f]!.rows, ...page.rows], next: page.next } : page }));
      setNow(new Date());
    } finally {
      if (!append) setLoading(false);
    }
  }, []);

  // Someone mentioned me, or I read one somewhere else: this view is stale.
  useEffect(() => {
    const on = () => {
      void load(filter, null, false);
    };
    window.addEventListener(CHANGED_EVENT, on);
    return () => window.removeEventListener(CHANGED_EVENT, on);
  }, [filter, load]);
  useEffect(() => {
    const on = (e: Event) => {
      const c = (e as CustomEvent<{ mentions: number; phone: number }>).detail;
      if (c) setUnread(c.mentions + c.phone);
    };
    window.addEventListener('tapdash:notifications-count', on);
    return () => window.removeEventListener('tapdash:notifications-count', on);
  }, []);

  const pick = (f: NotificationFilter) => {
    setFilter(f);
    if (!pages[f]) void load(f, null, false);
  };

  /** Switching whose notifications are shown drops every cached page. */
  const pickWho = (next: string) => {
    whoRef.current = next;
    setWho(next);
    setPages({ unread: null, read: null, all: null });
    void load(filter, null, false);
  };

  const page = pages[filter];
  const rows = page?.rows ?? [];

  const setRead = (ids: string[], read: boolean) => {
    const at = read ? new Date().toISOString() : null;
    setPages((p) => {
      const next = { ...p };
      for (const f of Object.keys(next) as NotificationFilter[]) {
        const pg = next[f];
        if (pg) next[f] = { ...pg, rows: pg.rows.map((r) => (ids.includes(r.id) ? { ...r, readAt: at } : r)) };
      }
      return next;
    });
  };

  const mark = (n: NotificationView, read: boolean) => {
    setRead([n.id], read);
    void markNotificationsAction({ ids: [n.id], read }).then(() => announceNotificationsChanged());
  };

  const markAll = () => {
    void markAllReadAction({ scope: 'all' }).then((r) => {
      setNote(r.changed ? `Marked ${r.changed} as read.` : 'Nothing was unread.');
      setPages({ unread: null, read: null, all: null });
      void load(filter, null, false);
      announceNotificationsChanged();
    });
  };

  const open = (n: NotificationView) => {
    // Someone else's notification: go there, but leave it unread for them.
    if (n.recipientId && n.recipientId !== viewerId) {
      if (n.href) router.push(n.href);
      else setNote('This item is no longer available.');
      return;
    }
    setRead([n.id], true);
    void openNotificationAction({ id: n.id, follow: true }).then(({ href }) => {
      announceNotificationsChanged();
      if (href) router.push(href);
      else setNote('This item is no longer available.');
    });
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-.01em] text-ink-900">Notifications</h1>
          <p className="mt-1 text-[13px] text-ink-500">
            {own
              ? `${unread > 0 ? `${unread} unread · ` : ''}Mentions on updates, cases and fields from the last 90 days.`
              : 'Read only — they stay unread for the person they went to.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canSeeAll ? (
            <label className="inline-flex items-center gap-2 text-[12.5px] text-ink-500">
              Showing
              <select
                value={who}
                onChange={(e) => pickWho(e.target.value)}
                className="rounded-lg border border-line bg-white px-2.5 py-1.5 text-[13px] font-medium text-ink-800 outline-none hover:border-ink-300 focus-field"
              >
                <option value="me">Mine</option>
                <option value="everyone">Everyone&rsquo;s</option>
                <optgroup label="One person">
                  {people
                    .filter((p) => !p.suspended && p.id !== viewerId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                </optgroup>
              </select>
            </label>
          ) : null}
          {own ? (
            <Button variant="secondary" size="sm" icon="check" onClick={markAll} disabled={unread === 0}>
              Mark all as read
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="tablist" aria-label="Filter" className="inline-flex rounded-lg border border-line bg-white p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => pick(f.id)}
              className={`rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                filter === f.id ? 'bg-ink-900 text-white shadow-[0_1px_2px_rgba(8,32,47,.15)]' : 'text-ink-500 hover:text-ink-900'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {loading ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-400">
            <Spinner /> Loading…
          </span>
        ) : null}
        {note ? (
          <p role="status" className="ml-auto flex items-center gap-2 text-[12.5px] text-ink-500">
            {note}
            <button type="button" aria-label="Dismiss" onClick={() => setNote(null)} className="opacity-60 hover:opacity-100">
              <Icon name="x" size={12} />
            </button>
          </p>
        ) : null}
      </div>

      {page && rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line bg-white px-6 py-14 text-center">
          <span className="mx-auto mb-3 grid size-11 place-items-center rounded-full bg-canvas text-ink-300">
            <Icon name={filter === 'unread' ? 'check' : 'bell'} size={20} />
          </span>
          <p className="text-[14px] font-semibold text-ink-700">
            {filter === 'unread' ? 'You’re all caught up.' : filter === 'read' ? 'Nothing read yet.' : 'No notifications yet.'}
          </p>
          <p className="mx-auto mt-1 max-w-[42ch] text-[12.5px] leading-relaxed text-ink-400">
            When someone @mentions you in an update, a case or on a field, it shows up here — and in your email.
          </p>
        </div>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-line bg-white">
          {rows.map((n) => (
            <Row key={n.id} n={n} now={now} viewerId={viewerId} onOpen={() => open(n)} onMark={(read) => mark(n, read)} />
          ))}
        </ul>
      )}

      {page?.next ? (
        <div className="mt-4 flex justify-center">
          <Button variant="ghost" size="sm" loading={more} loadingLabel="Loading…" onClick={() => startMore(() => void load(filter, page.next, true))}>
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Row({
  n, now, viewerId, onOpen, onMark,
}: {
  n: NotificationView;
  now: Date;
  viewerId?: string;
  onOpen: () => void;
  onMark: (read: boolean) => void;
}) {
  const byId = usePeopleById();
  const others = Boolean(n.recipientId && n.recipientId !== viewerId);
  const toName = others ? (byId.get(n.recipientId!)?.name ?? 'someone') : null;
  const unread = !n.readAt;
  const where = whereOf(n);
  const isMention = n.sourceKind.startsWith('mention_');
  const actor = n.actorName ?? (isMention ? 'Someone' : 'TapDash');
  const preview = isMention
    ? n.sourceKind === 'mention_field'
      ? n.note || (n.currentValue != null ? `Value: ${n.currentValue || '—'}` : '')
      : (n.preview ?? '').replace(/^Case #\d+:\s*/, '')
    : n.body;
  const stamp = new Date(n.createdAt);
  return (
    <li className={`group relative flex items-start gap-3 border-b border-line-faint px-4 py-3 last:border-b-0 ${unread ? 'bg-brand-50/40' : 'bg-white'}`}>
      {unread ? <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] bg-brand-600" /> : null}
      <div className="mt-0.5 shrink-0">
        {n.actorId ? (
          <UserAvatar userId={n.actorId} name={actor} size={30} />
        ) : (
          <span className="grid size-[30px] place-items-center rounded-full bg-canvas text-ink-400">
            <Icon name={where.icon} size={14} />
          </span>
        )}
      </div>
      <button type="button" onClick={onOpen} className="min-w-0 flex-1 text-left">
        <p className={`flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13.5px] ${unread ? 'font-semibold text-ink-900' : 'text-ink-700'}`}>
          {isMention ? (
            <>
              <span>{actor}</span>
              <span className={unread ? 'font-medium text-ink-500' : 'text-ink-400'}>mentioned {toName ?? 'you'}</span>
            </>
          ) : (
            <span>{where.label}{toName ? <span className="font-normal text-ink-400"> · to {toName}</span> : null}</span>
          )}
          <span className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-1.5 py-px text-[11px] font-semibold text-ink-600">
            <Icon name={where.icon} size={11} className="text-ink-400" />
            {where.label}
          </span>
          {n.recordName ? (
            <>
              <span className="text-ink-300">·</span>
              <span className={unread ? 'text-ink-800' : 'text-ink-600'}>{n.recordName}</span>
            </>
          ) : null}
          {n.moduleLabel ? <span className="text-[11.5px] font-medium text-ink-400">{n.moduleLabel}</span> : null}
        </p>
        {preview ? <p className={`mt-0.5 line-clamp-2 text-[12.5px] leading-relaxed ${unread ? 'text-ink-600' : 'text-ink-500'}`}>{preview}</p> : null}
      </button>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <time dateTime={n.createdAt} title={stamp.toLocaleString()} className="text-[11.5px] tabular text-ink-400">
          {relative(n.createdAt, now)}
        </time>
        {others ? null : <button
          type="button"
          /* `onMark(read)`: an unread row is marked read, a read one unread. */
          onClick={() => onMark(unread)}
          className="rounded-md px-1.5 py-0.5 text-[11.5px] font-semibold text-ink-400 opacity-0 transition-opacity hover:bg-canvas hover:text-ink-900 focus:opacity-100 group-hover:opacity-100"
        >
          {unread ? 'Mark read' : 'Mark unread'}
        </button>}
      </div>
    </li>
  );
}
