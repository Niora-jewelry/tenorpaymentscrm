'use client';

/**
 * @ on a field.
 *
 * `FieldMentionButton` — the small @ beside a field's label. Opens a box with
 * a people picker (only people who can see this exact field), an optional
 * note, and "Include previous value" when the sender changed the field in
 * the last ten minutes. Sending creates one notification per person — and
 * nothing in the Updates feed.
 *
 * `FieldMentionNote` — what the mentioned person sees: a dot on the label,
 * and a small panel beside the field with who, when, the note and the
 * values. Opening it marks the mention read; the previous value is shown
 * this once and then gone (the client's rule).
 *
 * Both panels render through `MenuSurface` — a body portal — because every
 * field cell sits inside an `overflow-hidden` card, which clipped the box at
 * the card's edge and let the next card paint over it. No z-index fixes that.
 */
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, Spinner } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { relative } from '@/proto/ui/tokens';
import { UserAvatar } from './UserAvatar';
import { fieldMentionAction, fieldMentionContextAction } from './actions';
import { openNotificationAction } from '../actions';
import type { Candidate, RecentChange, NotificationView } from '@/lib/records/notifications';
import { announceNotificationsChanged } from '../useLiveCounts';

const NOTE_MAX = 500;

/** A field's value as the short text a mention carries — the same shape the
 *  database snapshots (`values ->> key`), readable for people. */
export function valueText(v: unknown): string {
  if (v == null || v === '') return '';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' && x ? JSON.stringify(x) : String(x))).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function FieldMentionButton({
  recordId,
  fieldKey,
  fieldLabel,
  currentValue,
  /** Keeps the button visible even when the cell is not hovered. */
  alwaysVisible = false,
}: {
  recordId: string;
  fieldKey: string;
  fieldLabel: string;
  currentValue: string;
  alwaysVisible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(null), 3_000);
    return () => clearTimeout(t);
  }, [sent]);

  return (
    <span className="relative inline-flex items-center">
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Mention someone on ${fieldLabel}`}
        title={`Mention someone on ${fieldLabel}`}
        className={`grid size-5 place-items-center rounded text-ink-400 transition-[opacity,color,background-color] hover:bg-brand-50 hover:text-brand-700 focus-visible:opacity-100 ${
          open || alwaysVisible ? 'opacity-100' : 'opacity-0 group-hover/cell:opacity-100 [@media(hover:none)]:opacity-100'
        } ${open ? 'bg-brand-50 text-brand-700' : ''}`}
      >
        <Icon name="at-sign" size={12} strokeWidth={2} />
      </button>
      {sent ? (
        <span role="status" className="ml-1 inline-flex items-center gap-1 whitespace-nowrap rounded-md bg-[#e3f6e8] px-1.5 py-px text-[10.5px] font-semibold text-[#1a7a3c]">
          <Icon name="check" size={10} /> {sent}
        </span>
      ) : null}
      {open ? (
        <MentionBox
          anchorRef={anchor}
          recordId={recordId}
          fieldKey={fieldKey}
          fieldLabel={fieldLabel}
          currentValue={currentValue}
          onClose={close}
          onSent={(names) => {
            setOpen(false);
            setSent(`Sent to ${names.length <= 2 ? names.join(' and ') : `${names[0]} +${names.length - 1}`}`);
          }}
        />
      ) : null}
    </span>
  );
}

function MentionBox({
  anchorRef,
  recordId,
  fieldKey,
  fieldLabel,
  currentValue,
  onClose,
  onSent,
}: {
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  recordId: string;
  fieldKey: string;
  fieldLabel: string;
  currentValue: string;
  onClose: () => void;
  onSent: (names: string[]) => void;
}) {
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [recent, setRecent] = useState<RecentChange>(null);
  const [picked, setPicked] = useState<Candidate[]>([]);
  const [query, setQuery] = useState('');
  const [note, setNote] = useState('');
  const [includePrevious, setIncludePrevious] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    let live = true;
    void fieldMentionContextAction({ recordId, fieldKey }).then((r) => {
      if (!live) return;
      setCandidates(r.candidates);
      setRecent(r.recentChange);
    });
    return () => {
      live = false;
    };
  }, [recordId, fieldKey]);

  const pickedIds = new Set(picked.map((p) => p.id));
  const shown = (candidates ?? []).filter((c) => !pickedIds.has(c.id) && c.name.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 8);

  const send = () => {
    if (!picked.length) return setError('Choose at least one person.');
    setError(null);
    start(async () => {
      const r = await fieldMentionAction({
        recordId,
        fieldKey,
        userIds: picked.map((p) => p.id),
        note: note.trim() || null,
        includePrevious: Boolean(recent) && includePrevious,
      });
      if (!r.ok) return setError(r.message ?? 'Could not send that mention.');
      if (!r.sent) return setError('Nobody picked can see this field any more.');
      onSent(picked.map((p) => p.name));
    });
  };

  return (
    <MenuSurface open onClose={onClose} anchorRef={anchorRef} align="left" width={320} role="dialog" padded={false} label={`Mention someone on ${fieldLabel}`}>
    <div className="animate-pop-in p-3 text-left" onClick={(e) => e.stopPropagation()}>
      <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
        <Icon name="at-sign" size={11} /> Mention on {fieldLabel}
      </p>

      <div className="rounded-lg border border-line px-2 py-1.5 focus-within:border-brand-600">
        <div className="flex flex-wrap items-center gap-1">
          {picked.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-px pl-1 pr-1.5 text-[12px] text-ink-800">
              <UserAvatar userId={p.id} name={p.name} size={16} />
              {p.name}
              <button type="button" aria-label={`Remove ${p.name}`} onClick={() => setPicked((l) => l.filter((x) => x.id !== p.id))} className="grid size-4 place-items-center rounded-full opacity-60 hover:bg-white hover:opacity-100">
                <Icon name="x" size={9} />
              </button>
            </span>
          ))}
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && shown[0]) {
                e.preventDefault();
                setPicked((l) => [...l, shown[0]]);
                setQuery('');
              } else if (e.key === 'Backspace' && !query && picked.length) setPicked((l) => l.slice(0, -1));
            }}
            placeholder={picked.length ? '' : 'Who should see this?'}
            aria-label="Who to mention"
            className="min-w-[120px] flex-1 bg-transparent px-1 py-0.5 text-[13px] text-ink-900 outline-none placeholder:text-ink-300"
          />
        </div>
      </div>
      <div className="mt-1 max-h-40 overflow-y-auto rounded-lg border border-line-faint">
        {candidates === null ? (
          <p className="flex items-center gap-2 px-2.5 py-2 text-[12px] text-ink-400">
            <Spinner /> Finding who can see this field…
          </p>
        ) : shown.length === 0 ? (
          <p className="px-2.5 py-2 text-[12px] text-ink-400">{candidates.length === 0 ? 'Nobody else can see this field.' : picked.length === candidates.length ? 'Everyone who can see it is picked.' : 'No one matches.'}</p>
        ) : (
          shown.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setPicked((l) => [...l, c]);
                setQuery('');
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[13px] text-ink-800 hover:bg-canvas"
            >
              <UserAvatar userId={c.id} name={c.name} size={20} />
              {c.name}
            </button>
          ))
        )}
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
        rows={2}
        placeholder="Add a note (optional)"
        aria-label="Note"
        className="mt-2 w-full resize-none rounded-lg border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-600"
      />
      <p className="mt-0.5 text-right text-[10.5px] tabular text-ink-300">
        {note.length}/{NOTE_MAX}
      </p>

      <div className="mt-1 rounded-lg bg-canvas px-2.5 py-2 text-[12px] text-ink-600">
        <p>
          <span className="text-ink-400">Current value: </span>
          <span className="font-medium text-ink-800">{currentValue || '—'}</span>
        </p>
        {recent ? (
          <label className="mt-1.5 flex cursor-pointer items-start gap-2">
            <input type="checkbox" checked={includePrevious} onChange={(e) => setIncludePrevious(e.target.checked)} className="mt-0.5 accent-brand-600" />
            <span>
              Include previous value
              <span className="block text-[11.5px] text-ink-400">
                You changed this {relative(recent.changedAt, new Date())}: was <span className="font-medium text-ink-700">{recent.previousValue || '—'}</span>
              </span>
            </span>
          </label>
        ) : null}
      </div>

      {error ? (
        <p role="alert" className="mt-2 text-[12px] text-[#b02a30]">
          {error}
        </p>
      ) : null}
      <div className="mt-2.5 flex items-center justify-end gap-1.5">
        <Button size="sm" variant="ghost" onClick={onClose} disabled={pending}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" icon="send" loading={pending} loadingLabel="Sending…" disabled={!picked.length} onClick={send}>
          Send
        </Button>
      </div>
    </div>
    </MenuSurface>
  );
}

/** The recipient's side: the dot on the field, and the note beside it. */
export function FieldMentionNote({
  mentions,
  autoOpen,
  onRead,
}: {
  /** Unread mentions on this field, oldest first. */
  mentions: NotificationView[];
  /** Arrived here by a link: open straight away. */
  autoOpen?: NotificationView | null;
  onRead: (id: string) => void;
}) {
  const [open, setOpen] = useState<NotificationView | null>(autoOpen ?? null);
  const [shown, setShown] = useState<NotificationView | null>(autoOpen ?? null);
  const anchor = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(null), []);
  const [now] = useState(() => new Date());

  const show = (m: NotificationView) => {
    setOpen(m);
    setShown(m);
    void openNotificationAction({ id: m.id }).then((r) => {
      if (r.notification) setShown(r.notification);
      onRead(m.id);
      announceNotificationsChanged();
    });
  };

  const first = mentions[0];
  if (!first && !open) return null;
  // The dot stays while its panel is open, even once the mention was read
  // (it is the panel's anchor); it turns grey to say so.
  const unread = Boolean(first);
  return (
    <span className="relative inline-flex items-center">
      <button
        ref={anchor}
        type="button"
        onClick={() => (first ? show(first) : setOpen(null))}
        aria-label={unread ? `${mentions.length} unread mention${mentions.length === 1 ? '' : 's'} on this field` : 'Mention read'}
        title={unread ? `${first?.actorName ?? 'Someone'} mentioned you here` : 'Read'}
        className={`inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-bold text-white ${unread ? 'bg-brand-600 hover:bg-brand-700' : 'bg-ink-300'}`}
      >
        <Icon name="at-sign" size={9} strokeWidth={2.5} />
        {mentions.length > 1 ? mentions.length : null}
      </button>
      {open && shown ? (
        <MenuSurface open onClose={close} anchorRef={anchor} align="left" width={300} role="dialog" padded={false} label="Mention">
        <div className="animate-pop-in rounded-xl border border-brand-200 p-3 text-left">
          <div className="flex items-center gap-2">
            {shown.actorId ? <UserAvatar userId={shown.actorId} name={shown.actorName ?? 'Someone'} size={24} /> : null}
            <p className="min-w-0 flex-1 text-[12.5px]">
              <span className="font-semibold text-ink-900">{shown.actorName ?? 'Someone'}</span>
              <span className="text-ink-500"> mentioned you · {relative(shown.createdAt, now)}</span>
            </p>
            <button type="button" aria-label="Close" onClick={() => setOpen(null)} className="grid size-6 place-items-center rounded-md text-ink-400 hover:bg-canvas hover:text-ink-900">
              <Icon name="x" size={12} />
            </button>
          </div>
          {shown.note ? <p className="mt-2 whitespace-pre-wrap rounded-lg bg-brand-50/60 px-2.5 py-2 text-[13px] leading-relaxed text-ink-800">{shown.note}</p> : null}
          <dl className="mt-2 space-y-1 text-[12px]">
            {shown.previousValue != null ? (
              <div className="flex gap-2">
                <dt className="w-[88px] shrink-0 text-ink-400">Previous value</dt>
                <dd className="min-w-0 break-words text-ink-600 line-through decoration-ink-300">{shown.previousValue || '—'}</dd>
              </div>
            ) : null}
            <div className="flex gap-2">
              <dt className="w-[88px] shrink-0 text-ink-400">{shown.previousValue != null ? 'Then' : 'Value then'}</dt>
              <dd className="min-w-0 break-words font-medium text-ink-800">{shown.currentValue || '—'}</dd>
            </div>
          </dl>
          {shown.previousValue != null ? <p className="mt-2 text-[10.5px] text-ink-400">The previous value is shown once and then removed.</p> : null}
          {mentions.length > 1 ? (
            <p className="mt-2 border-t border-line-faint pt-2 text-[11.5px] text-ink-400">{mentions.length - 1} more unread mention{mentions.length - 1 === 1 ? '' : 's'} on this field — see Notifications.</p>
          ) : null}
        </div>
        </MenuSurface>
      ) : null}
    </span>
  );
}
