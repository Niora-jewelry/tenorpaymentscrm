'use client';

/**
 * The address book, on the phone page.
 *
 * ── WHAT "SYNC WITH CONTACT" MEANS HERE ──────────────────────────────────
 * The client asked that "call recordings, call history, and texts should sync
 * with contact". Expanding a contact loads exactly that, matched BY NUMBER
 * rather than by a stored link — so a call that happened before the contact
 * existed still appears under it, and adding a second number to a contact
 * brings that number's whole history with it.
 *
 * Loaded on demand rather than with the page: an address book of two hundred
 * people should not cost two hundred histories to open.
 *
 * ── REMOVE ASKS FIRST, AND SAYS WHAT SURVIVES ────────────────────────────
 * Removing a contact is immediate and there is no bin to recover it from —
 * "Delete" in TapDash means the Recycle Bin and exists only in the Records
 * List, which this is not. So the confirmation says plainly what goes and what
 * stays: the entry goes, the calls and texts do not.
 */
import { useMemo, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, EmptyState, StatusPill, Spinner } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import { RecordingRow } from '@/app/(app)/[module]/PhonePanels';
import type { Contact, ContactActivity } from '@/lib/phone/contacts';
import { ContactForm } from './ContactForm';
import { contactActivityAction, removeContactAction } from './contactActions';
import { usePhone } from './PhoneProvider';

/** Initials for the avatar, from whatever the name happens to be. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function duration(seconds: number | null): string {
  if (seconds === null || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function Contacts({ contacts }: { contacts: Contact[] }) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [activity, setActivity] = useState<Record<string, ContactActivity>>({});
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const { dial, deviceState, activeCall } = usePhone();
  const canCall = activeCall === null && deviceState !== 'error';

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    // Digits typed into the search box should find a number regardless of how
    // it was punctuated when saved.
    const digits = q.replace(/\D/g, '');
    return contacts.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        (c.company ?? '').toLowerCase().includes(q) ||
        (c.email ?? '').toLowerCase().includes(q) ||
        (digits.length >= 3 && c.numbers.some((n) => n.e164.includes(digits))),
    );
  }, [contacts, query]);

  const toggle = (c: Contact) => {
    if (openId === c.id) {
      setOpenId(null);
      return;
    }
    setOpenId(c.id);
    if (activity[c.id]) return;

    setLoadingId(c.id);
    startTransition(async () => {
      const result = await contactActivityAction(c.id);
      setActivity((prev) => ({ ...prev, [c.id]: result }));
      setLoadingId(null);
    });
  };

  const remove = (c: Contact) => {
    setError(null);
    startTransition(async () => {
      const result = await removeContactAction(c.id);
      if (result.ok) {
        setConfirmRemove(null);
        setOpenId(null);
        setNotice(`${c.displayName} removed from your contacts.`);
      } else {
        setError(result.message ?? 'That contact could not be removed.');
      }
    });
  };

  const done = (message: string) => {
    setAdding(false);
    setEditing(null);
    setNotice(message);
    // The edited contact's history may now cover different numbers, so drop
    // what was cached for it rather than showing a stale list.
    setActivity({});
  };

  return (
    <section className="rounded-2xl border border-line bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-[13.5px] font-semibold text-ink-900">
          Contacts
          {contacts.length > 0 ? (
            <span className="rounded-full bg-canvas px-1.5 py-0.5 text-[11px] font-medium text-ink-500 tabular">
              {contacts.length}
            </span>
          ) : null}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {contacts.length > 0 ? (
            <div className="relative">
              <Icon
                name="search"
                size={12}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400"
              />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name or number"
                aria-label="Search contacts"
                className="w-[210px] rounded-lg border border-line bg-white py-1.5 pl-7 pr-2 text-[12.5px] text-ink-900 outline-none focus-field"
              />
            </div>
          ) : null}
          <Button
            size="sm"
            icon="plus"
            disabled={adding || editing !== null}
            onClick={() => {
              setNotice(null);
              setAdding(true);
            }}
          >
            Add contact
          </Button>
        </div>
      </div>

      {notice ? (
        <p role="status" className="mt-3 flex items-center gap-1.5 rounded-lg bg-ok-bg px-3 py-1.5 text-[12.5px] font-medium text-ink-800">
          <Icon name="check" size={13} strokeWidth={2.5} className="text-ok" />
          {notice}
        </p>
      ) : null}

      {adding ? (
        <div className="mt-3">
          <ContactForm onDone={done} onCancel={() => setAdding(false)} />
        </div>
      ) : null}

      {editing ? (
        <div className="mt-3">
          <ContactForm contact={editing} onDone={done} onCancel={() => setEditing(null)} />
        </div>
      ) : null}

      {contacts.length === 0 && !adding ? (
        <div className="mt-3">
          <EmptyState
            icon="users"
            title="No contacts yet"
            body="Add someone by hand, or keep working — a contact appears here automatically when you call or text a number that matches a record."
          />
        </div>
      ) : null}

      {filtered.length === 0 && contacts.length > 0 ? (
        <p className="mt-4 text-center text-[13px] text-ink-400">
          Nothing matches “{query}”.
        </p>
      ) : null}

      <ul className="mt-3 space-y-2">
        {filtered.map((c) => {
          const open = openId === c.id;
          const act = activity[c.id];
          const primary = c.numbers[0]?.e164 ?? null;

          return (
            <li key={c.id} className="rounded-xl border border-line-soft">
              <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full bg-brand-50 text-[11.5px] font-semibold text-brand-700">
                  {initials(c.displayName)}
                </span>

                <button
                  type="button"
                  onClick={() => toggle(c)}
                  className="min-w-0 flex-1 text-left"
                  aria-expanded={open}
                >
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[13.5px] font-medium text-ink-900">
                      {c.displayName}
                    </span>
                    {/* Said out loud: this one arrived by itself because the
                        number matched a record. */}
                    {c.source === 'auto' ? (
                      <StatusPill label="From a record" swatch="teal" dot={false} />
                    ) : null}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[12px] text-ink-500">
                    {c.company ? <span className="truncate">{c.company}</span> : null}
                    {c.company && primary ? <span className="text-ink-300">·</span> : null}
                    {c.numbers.map((n) => (
                      <span key={n.id} className="tabular">
                        {formatPhoneDisplay(n.e164)}
                        {n.label ? (
                          <span className="ml-1 text-ink-400">{n.label}</span>
                        ) : null}
                      </span>
                    ))}
                  </span>
                </button>

                <span className="flex shrink-0 items-center gap-1">
                  {primary ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="phone"
                        disabled={!canCall}
                        onClick={() => void dial(primary)}
                      >
                        Call
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon="message-square"
                        onClick={() => {
                          // The composer lives in the Messages section; take
                          // them to it with the number already in hand.
                          window.dispatchEvent(
                            new CustomEvent('tapdash:compose-sms', { detail: { to: primary } }),
                          );
                        }}
                      >
                        Text
                      </Button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    aria-label={`Edit ${c.displayName}`}
                    onClick={() => {
                      setNotice(null);
                      setAdding(false);
                      setEditing(c);
                    }}
                    className="grid size-7 place-items-center rounded-md text-ink-400 transition-colors hover:bg-canvas hover:text-ink-900"
                  >
                    <Icon name="pencil" size={13} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${c.displayName}`}
                    onClick={() => {
                      setError(null);
                      setConfirmRemove(confirmRemove === c.id ? null : c.id);
                    }}
                    className="grid size-7 place-items-center rounded-md text-ink-400 transition-colors hover:bg-danger-bg hover:text-danger"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                  <Icon
                    name={open ? 'chevron-up' : 'chevron-down'}
                    size={12}
                    className="text-ink-400"
                  />
                </span>
              </div>

              {/* ── remove confirmation ───────────────────────────────── */}
              {confirmRemove === c.id ? (
                <div className="border-t border-line-faint bg-danger-bg/40 px-3 py-2.5">
                  <p className="text-[12.5px] leading-relaxed text-ink-800">
                    Remove <strong className="font-semibold">{c.displayName}</strong> from your
                    contacts? This cannot be undone.{' '}
                    <span className="text-ink-600">
                      Their calls, texts and recordings are kept — only the contact entry is
                      removed.
                    </span>
                  </p>
                  {error ? (
                    <p role="alert" className="mt-1.5 text-[12px] text-danger">
                      {error}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-2">
                    <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmRemove(null)}>
                      Keep
                    </Button>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => remove(c)}
                      className="rounded-md bg-danger px-2.5 py-1 text-[12px] font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-60"
                    >
                      {pending ? 'Removing…' : 'Remove'}
                    </button>
                  </div>
                </div>
              ) : null}

              {/* ── activity ──────────────────────────────────────────── */}
              {open ? (
                <div className="space-y-3 border-t border-line-faint px-3 py-3">
                  {c.notes ? (
                    <p className="rounded-lg bg-canvas px-2.5 py-1.5 text-[12.5px] leading-relaxed text-ink-700">
                      {c.notes}
                    </p>
                  ) : null}
                  {c.email ? (
                    <p className="flex items-center gap-1.5 text-[12.5px] text-ink-600">
                      <Icon name="mail" size={12} className="text-ink-400" />
                      {c.email}
                    </p>
                  ) : null}

                  {loadingId === c.id || !act ? (
                    <p className="flex items-center gap-2 py-2 text-[12.5px] text-ink-400">
                      <Spinner className="size-3" />
                      Loading history…
                    </p>
                  ) : act.calls.length === 0 && act.messages.length === 0 ? (
                    <p className="py-2 text-[12.5px] text-ink-400">
                      No calls or texts with this contact yet.
                    </p>
                  ) : (
                    <div className="grid gap-4 lg:grid-cols-2">
                      {/* calls + recordings */}
                      <div>
                        <h4 className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
                          Calls &amp; recordings
                          <span className="ml-1.5 font-normal tabular text-ink-300">
                            {act.calls.length}
                          </span>
                        </h4>
                        {act.calls.length === 0 ? (
                          <p className="mt-1.5 text-[12.5px] text-ink-400">No calls yet.</p>
                        ) : (
                          <ul className="mt-1.5 space-y-1.5">
                            {act.calls.map((call) => (
                              <li
                                key={call.id}
                                className="rounded-lg border border-line-faint px-2.5 py-1.5"
                              >
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <Icon
                                    name={call.direction === 'in' ? 'reply' : 'send'}
                                    size={11}
                                    className="text-ink-400"
                                  />
                                  <span className="text-[12.5px] font-medium text-ink-900">
                                    {call.direction === 'in' ? 'Incoming' : 'Outgoing'}
                                  </span>
                                  <span className="text-[11.5px] text-ink-400 tabular">
                                    {duration(call.durationSeconds)}
                                  </span>
                                  <span className="ml-auto text-[11.5px] text-ink-400 tabular">
                                    {formatDateTime(call.startedAt)}
                                  </span>
                                </div>
                                {call.recording ? (
                                  <div className="mt-1.5">
                                    <RecordingRow recording={call.recording} />
                                  </div>
                                ) : null}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>

                      {/* texts */}
                      <div>
                        <h4 className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
                          Texts
                          <span className="ml-1.5 font-normal tabular text-ink-300">
                            {act.messages.length}
                          </span>
                        </h4>
                        {act.messages.length === 0 ? (
                          <p className="mt-1.5 text-[12.5px] text-ink-400">No texts yet.</p>
                        ) : (
                          <ul className="mt-1.5 max-h-[220px] space-y-1.5 overflow-y-auto pr-1">
                            {act.messages.map((m) => (
                              <li
                                key={m.id}
                                className={`rounded-lg px-2.5 py-1.5 ${
                                  m.direction === 'in' ? 'bg-canvas' : 'bg-brand-50'
                                }`}
                              >
                                <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-ink-800">
                                  {m.body}
                                </p>
                                <p className="mt-0.5 text-[11px] text-ink-400 tabular">
                                  {m.direction === 'in' ? 'Received' : 'Sent'}{' '}
                                  {formatDateTime(m.sentAt ?? m.createdAt)}
                                </p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
