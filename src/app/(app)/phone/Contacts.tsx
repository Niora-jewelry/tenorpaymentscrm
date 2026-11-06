'use client';

/**
 * Contacts, on both the Phone and the SMS tab (client, Phone UI review):
 * "Add contact" top left, a search box in the middle (name or number), and on
 * each contact two minimized bars at the bottom, Call history and Text history.
 *
 * ── WHAT "SYNC WITH CONTACT" MEANS HERE ──────────────────────────────────
 * The history under a contact is matched BY NUMBER rather than by a stored
 * link, so a call that happened before the contact existed still appears under
 * it. It loads when a bar is first opened: an address book of two hundred
 * people should not cost two hundred histories to open.
 *
 * ── REMOVE ASKS FIRST, AND SAYS WHAT SURVIVES ────────────────────────────
 * Removing a contact has no bin ("Delete" in the CRM means the Recycle Bin and
 * exists only in the Records List). The confirmation says plainly that the
 * entry goes and the calls and texts stay.
 */
import { useMemo, useState, useTransition, type ReactNode } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, StatusPill, Spinner } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import type { Contact, ContactActivity } from '@/lib/phone/contacts';
import { ContactForm } from './ContactForm';
import { contactActivityAction, removeContactAction } from './contactActions';
import { ListenButton } from './ListenButton';
import { PanelEmpty, RowButton, SearchBox } from './PhoneBits';
import { callDuration, initials, isMissed, matches } from './phoneBook';

export function Contacts({
  contacts,
  onText,
  onCall,
  addRequest,
}: {
  contacts: Contact[];
  onText: (e164: string) => void;
  onCall: (e164: string) => void;
  /** "Add contact" pressed on a call or a text: open the form with that number. */
  addRequest: { number: string; key: number } | null;
}) {
  const [query, setQuery] = useState('');
  // Opened already when the page switched here to add a number from a call.
  const [adding, setAdding] = useState<{ number: string; key: number } | null>(addRequest);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, ContactActivity | 'loading' | 'error'>>({});

  // A new request while this list is already open (Add contact in the SMS panel).
  const [seenRequest, setSeenRequest] = useState(addRequest);
  if (addRequest !== seenRequest) {
    setSeenRequest(addRequest);
    if (addRequest) {
      setEditing(null);
      setNotice(null);
      setAdding(addRequest);
    }
  }

  const list = useMemo(
    () =>
      contacts.filter((c) =>
        matches(query, c.displayName, c.company, c.email, ...c.numbers.flatMap((n) => [n.e164, formatPhoneDisplay(n.e164)])),
      ),
    [contacts, query],
  );

  const load = async (id: string) => {
    if (activity[id] && activity[id] !== 'error') return;
    setActivity((prev) => ({ ...prev, [id]: 'loading' }));
    try {
      const result = await contactActivityAction(id);
      setActivity((prev) => ({ ...prev, [id]: result }));
    } catch {
      setActivity((prev) => ({ ...prev, [id]: 'error' }));
    }
  };

  const done = (message: string) => {
    setAdding(null);
    setEditing(null);
    setNotice(message);
    // A changed contact may now cover different numbers: drop cached histories.
    setActivity({});
  };

  return (
    <div>
      <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 border-b border-line-soft p-4 sm:grid-cols-[auto_minmax(0,1fr)_auto]">
        <Button
          icon="plus"
          disabled={adding !== null || editing !== null}
          onClick={() => {
            setNotice(null);
            setAdding({ number: '', key: Date.now() });
          }}
        >
          Add contact
        </Button>
        <SearchBox value={query} onChange={setQuery} label="Search contacts" className="mx-auto w-full max-w-[420px]" />
        <span className="hidden whitespace-nowrap text-[12px] text-ink-400 tabular sm:block">
          {query.trim() ? `${list.length} of ${contacts.length}` : contacts.length} contact{contacts.length === 1 ? '' : 's'}
        </span>
      </div>

      {notice ? (
        <p role="status" className="mx-4 mt-3 flex items-center gap-1.5 rounded-lg bg-ok-bg px-3 py-1.5 text-[12.5px] font-medium text-ink-800">
          <Icon name="check" size={13} strokeWidth={2.5} className="text-ok" />
          {notice}
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="ml-auto text-ink-400 hover:text-ink-900">
            <Icon name="x" size={12} />
          </button>
        </p>
      ) : null}

      {adding ? (
        <div className="px-4 pt-3">
          <ContactForm key={adding.key} initialNumber={adding.number || undefined} onDone={done} onCancel={() => setAdding(null)} />
        </div>
      ) : null}
      {editing ? (
        <div className="px-4 pt-3">
          <ContactForm key={editing.id} contact={editing} onDone={done} onCancel={() => setEditing(null)} />
        </div>
      ) : null}

      {contacts.length === 0 ? (
        adding ? null : (
          <PanelEmpty
            icon="users"
            title="No contacts yet"
            body="Add someone by hand, or keep working: a contact appears here by itself when you call or text a number that matches a record."
          />
        )
      ) : list.length === 0 ? (
        <PanelEmpty icon="search" title="No contacts match" body={`Nothing matches “${query.trim()}”.`} />
      ) : (
        <ul className="max-h-[640px] divide-y divide-line-soft overflow-y-auto">
          {list.map((c) => (
            <ContactRow
              key={c.id}
              c={c}
              act={activity[c.id]}
              onLoad={() => void load(c.id)}
              onText={onText}
              onCall={onCall}
              onEdit={() => {
                setNotice(null);
                setAdding(null);
                setEditing(c);
              }}
              onRemoved={(name) => {
                setNotice(`${name} removed from your contacts.`);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ContactRow({
  c,
  act,
  onLoad,
  onText,
  onCall,
  onEdit,
  onRemoved,
}: {
  c: Contact;
  act: ContactActivity | 'loading' | 'error' | undefined;
  onLoad: () => void;
  onText: (e164: string) => void;
  onCall: (e164: string) => void;
  onEdit: () => void;
  onRemoved: (name: string) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const primary = c.numbers.find((n) => n.isPrimary)?.e164 ?? c.numbers[0]?.e164 ?? null;
  const loaded = act && act !== 'loading' && act !== 'error' ? act : null;

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await removeContactAction(c.id);
      if (result.ok) {
        setConfirm(false);
        onRemoved(c.displayName);
      } else {
        setError(result.message ?? 'That contact could not be removed.');
      }
    });
  };

  return (
    <li className="px-4 py-3.5">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5">
        <span className="grid size-10 shrink-0 place-items-center rounded-full bg-brand-900 text-[12px] font-bold text-white">
          {initials(c.displayName)}
        </span>
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[14px] font-semibold text-ink-900">{c.displayName}</span>
            {c.source === 'auto' ? <StatusPill label="From a record" swatch="teal" dot={false} /> : null}
          </span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[12px] text-ink-400">
            {c.numbers.map((n, i) => (
              <span key={n.id} className="tabular">
                {i > 0 ? <span aria-hidden className="mr-1.5">·</span> : null}
                {formatPhoneDisplay(n.e164)}
                {n.label ? <span className="ml-1 text-ink-300">{n.label}</span> : null}
              </span>
            ))}
            {c.company ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{c.company}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {primary ? (
            <>
              <RowButton icon="phone" label="Call" tone="brand" hideLabelOnSmall onClick={() => onCall(primary)} />
              <RowButton icon="message-square" label="Text" hideLabelOnSmall onClick={() => onText(primary)} />
            </>
          ) : null}
          <button
            type="button"
            aria-label={`Edit ${c.displayName}`}
            title="Edit"
            onClick={onEdit}
            className="grid size-7 place-items-center rounded-full text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900"
          >
            <Icon name="pencil" size={13} />
          </button>
          <button
            type="button"
            aria-label={`Remove ${c.displayName}`}
            title="Remove from contacts"
            onClick={() => {
              setError(null);
              setConfirm((v) => !v);
            }}
            className="grid size-7 place-items-center rounded-full text-ink-400 transition-colors hover:bg-danger-bg hover:text-danger"
          >
            <Icon name="x" size={13} />
          </button>
        </span>
      </div>

      {confirm ? (
        <div className="mt-2.5 rounded-xl bg-danger-bg/50 px-3 py-2.5 sm:ml-[54px]">
          <p className="text-[12.5px] leading-relaxed text-ink-800">
            Remove <strong className="font-semibold">{c.displayName}</strong> from your contacts? This cannot be
            undone. <span className="text-ink-600">Their calls, texts and recordings are kept.</span>
          </p>
          {error ? (
            <p role="alert" className="mt-1.5 text-[12px] text-danger">
              {error}
            </p>
          ) : null}
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirm(false)}>
              Keep
            </Button>
            <button
              type="button"
              disabled={pending}
              onClick={remove}
              className="rounded-md bg-danger px-2.5 py-1 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {pending ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      ) : null}

      {c.notes ? (
        <p className="mt-2 rounded-lg bg-canvas px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink-600 sm:ml-[54px]">{c.notes}</p>
      ) : null}

      <div className="mt-2.5 grid items-start gap-2 sm:ml-[54px] sm:grid-cols-2">
        <HistoryBar icon="clock" label="Call history" count={loaded?.calls.length} loading={act === 'loading'} failed={act === 'error'} onOpen={onLoad}>
          {loaded && loaded.calls.length > 0 ? (
            <ul className="divide-y divide-line-faint">
              {loaded.calls.map((k) => {
                const missed = isMissed(k);
                return (
                  <li key={k.id} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2 text-[12px]">
                    <Icon
                      name={missed ? 'phone-missed' : k.direction === 'in' ? 'phone-in' : 'phone-out'}
                      size={12}
                      className={missed ? 'text-danger' : 'text-ink-400'}
                    />
                    <span className="text-ink-600 tabular">{formatDateTime(k.startedAt)}</span>
                    <span className={`tabular ${missed ? 'font-medium text-danger' : 'text-ink-400'}`}>
                      {missed ? 'Missed' : k.durationSeconds ? callDuration(k.durationSeconds) : k.status.replace(/-/g, ' ')}
                    </span>
                    {k.recording ? (
                      <span className="ml-auto">
                        <ListenButton recording={k.recording} />
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
        </HistoryBar>
        <HistoryBar icon="message-square" label="Text history" count={loaded?.messages.length} loading={act === 'loading'} failed={act === 'error'} onOpen={onLoad}>
          {loaded && loaded.messages.length > 0 ? (
            <ul className="max-h-[260px] divide-y divide-line-faint overflow-y-auto">
              {loaded.messages.map((m) => (
                <li key={m.id} className="px-3 py-2">
                  <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-800">
                    {m.direction === 'out' ? <span className="text-ink-400">You: </span> : null}
                    {m.body}
                  </p>
                  <p className="mt-0.5 text-[11px] text-ink-400 tabular">{formatDateTime(m.sentAt ?? m.createdAt)}</p>
                </li>
              ))}
            </ul>
          ) : null}
        </HistoryBar>
      </div>
    </li>
  );
}

/** A minimized bar that opens to show one kind of history. */
function HistoryBar({
  icon,
  label,
  count,
  loading,
  failed,
  onOpen,
  children,
}: {
  icon: 'clock' | 'message-square';
  label: string;
  count: number | undefined;
  loading: boolean;
  failed: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="overflow-hidden rounded-xl border border-line-soft bg-canvas/40">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen();
          setOpen((o) => !o);
        }}
        className="flex h-9 w-full items-center gap-2 px-3 text-[12px] font-semibold text-ink-500 transition-colors hover:text-ink-900"
      >
        <Icon name={icon} size={13} />
        <span className="flex-1 text-left">{label}</span>
        {count !== undefined ? (
          <span className="rounded-full bg-white px-1.5 text-[11px] font-medium text-ink-500 tabular">{count}</span>
        ) : null}
        <Icon name="chevron-down" size={13} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open ? (
        <div className="border-t border-line-soft bg-white">
          {loading ? (
            <p className="flex items-center gap-2 px-3 py-3 text-[12px] text-ink-400">
              <Spinner className="size-3" />
              Loading…
            </p>
          ) : failed ? (
            <p className="flex items-center gap-2 px-3 py-3 text-[12px] text-danger">
              Could not load the history.
              <button type="button" onClick={onOpen} className="font-semibold underline underline-offset-2">
                Try again
              </button>
            </p>
          ) : count === 0 || count === undefined ? (
            <p className="px-3 py-3 text-[12px] text-ink-400">Nothing yet.</p>
          ) : (
            children
          )}
        </div>
      ) : null}
    </div>
  );
}
