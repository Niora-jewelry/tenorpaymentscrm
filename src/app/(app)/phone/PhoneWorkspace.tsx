'use client';

/**
 * The Phone page's layout (client, Phone UI review):
 *
 *   - Two tabs on top, Phone and SMS. Phone is open by default.
 *   - On the left, sub-tabs: Recent calls (Recent messages on SMS) and Contacts.
 *   - On the right, the keypad (Phone) or the SMS panel showing the topmost
 *     conversation, with New SMS (SMS).
 *
 * Text and Call anywhere on the page move to the right tab with the number in
 * hand: Text opens that conversation (or a new one), Call puts the number on
 * the keypad, ready to press Call. The tab is kept in the address (?tab=sms),
 * so a link or a reload lands on the same one.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '@/proto/ui/icons';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import type { PhoneCall } from '@/lib/phone/calls';
import type { PhoneMessage, PhoneThread } from '@/lib/phone/messages';
import type { Contact } from '@/lib/phone/contacts';
import { Keypad, RecentCalls } from './Dialer';
import { RecentMessages, SmsPanel } from './Sms';
import { Contacts } from './Contacts';
import { nameBook } from './phoneBook';

type Main = 'phone' | 'sms';
/** Stable, so the SMS panel does not see a "new" new message on every render. */
const FIRST_MESSAGE = { to: '', key: 0 };
type Sub = 'recent' | 'contacts';

export function PhoneWorkspace({
  calls,
  threads,
  contacts,
  myNumber,
  initialTab,
  initialThread,
  smsExtra,
}: {
  calls: PhoneCall[];
  threads: PhoneThread[];
  contacts: Contact[];
  myNumber: string | null;
  initialTab: Main;
  initialThread: { key: string; stamp: string; messages: PhoneMessage[] } | null;
  /** Broadcast and group texts, under the SMS tab. */
  smsExtra?: ReactNode;
}) {
  const [main, setMain] = useState<Main>(initialTab);
  const [sub, setSub] = useState<Sub>('recent');
  const [dialValue, setDialValue] = useState('');
  const [focusKey, setFocusKey] = useState(0);
  const [thread, setThread] = useState<string | null>(initialThread?.key ?? threads[0]?.threadKey ?? null);
  const [composing, setComposing] = useState<{ to: string; key: number } | null>(null);
  const [addRequest, setAddRequest] = useState<{ number: string; key: number } | null>(null);

  const book = useMemo(() => nameBook(contacts), [contacts]);
  // No conversation yet: the SMS panel opens on a new one.
  const smsComposing = composing ?? (threads.length === 0 ? FIRST_MESSAGE : null);
  const activeThread = smsComposing ? null : thread ?? threads[0]?.threadKey ?? null;

  const switchMain = useCallback((m: Main) => {
    setMain(m);
    try {
      const url = new URL(window.location.href);
      if (m === 'sms') url.searchParams.set('tab', 'sms');
      else url.searchParams.delete('tab');
      window.history.replaceState(window.history.state, '', url.toString());
    } catch {
      // The address is a convenience; the tab works without it.
    }
  }, []);

  const openText = useCallback(
    (e164: string) => {
      switchMain('sms');
      if (threads.some((t) => t.threadKey === e164)) {
        setThread(e164);
        setComposing(null);
      } else {
        setComposing({ to: formatPhoneDisplay(e164), key: Date.now() });
      }
    },
    [threads, switchMain],
  );

  const callNumber = useCallback(
    (e164: string) => {
      switchMain('phone');
      setDialValue(formatPhoneDisplay(e164));
      setFocusKey((k) => k + 1);
    },
    [switchMain],
  );

  const addContact = useCallback((e164: string) => {
    setSub('contacts');
    setAddRequest({ number: e164, key: Date.now() });
  }, []);

  const subTabs: { key: Sub; label: string; count: number }[] = [
    { key: 'recent', label: main === 'phone' ? 'Recent calls' : 'Recent messages', count: main === 'phone' ? calls.length : threads.length },
    { key: 'contacts', label: 'Contacts', count: contacts.length },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-ink-900">Phone</h1>
          <p className="mt-0.5 text-[13px] text-ink-500">
            Calls are recorded and attached to a merchant automatically when the number matches one.
          </p>
        </div>
        <div role="tablist" aria-label="Phone or SMS" className="inline-flex rounded-xl border border-line bg-white p-1">
          {(['phone', 'sms'] as Main[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={main === m}
              onClick={() => switchMain(m)}
              className={`inline-flex items-center gap-2 rounded-lg px-5 py-2 text-[13.5px] font-semibold transition-colors ${
                main === m ? 'bg-brand-900 text-white' : 'text-ink-500 hover:text-ink-900'
              }`}
            >
              <Icon name={m === 'phone' ? 'phone' : 'message-square'} size={15} />
              {m === 'phone' ? 'Phone' : 'SMS'}
            </button>
          ))}
        </div>
      </header>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px] xl:items-start">
        <section className="min-w-0 overflow-hidden rounded-2xl border border-line bg-white shadow-[0_1px_2px_rgba(16,35,71,.04)]">
          <div role="tablist" aria-label={main === 'phone' ? 'Calls or contacts' : 'Messages or contacts'} className="flex gap-6 border-b border-line-soft px-5">
            {subTabs.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={sub === s.key}
                onClick={() => {
                  setSub(s.key);
                  // A request to add a number is used once, not again on the next visit.
                  if (s.key !== 'contacts') setAddRequest(null);
                }}
                className={`-mb-px inline-flex items-center gap-2 border-b-2 py-3.5 text-[13.5px] font-semibold transition-colors ${
                  sub === s.key ? 'border-brand-900 text-ink-900' : 'border-transparent text-ink-400 hover:text-ink-900'
                }`}
              >
                {s.label}
                <span className="rounded-full bg-canvas px-1.5 text-[11px] font-medium text-ink-500 tabular">{s.count}</span>
              </button>
            ))}
          </div>

          {sub === 'contacts' ? (
            <Contacts contacts={contacts} onText={openText} onCall={callNumber} addRequest={addRequest} />
          ) : main === 'phone' ? (
            <RecentCalls calls={calls} book={book} onText={openText} onCall={callNumber} onAddContact={addContact} />
          ) : (
            <RecentMessages
              threads={threads}
              book={book}
              active={activeThread}
              onOpen={(key) => {
                setThread(key);
                setComposing(null);
              }}
            />
          )}
        </section>

        <aside className="xl:sticky xl:top-5">
          {main === 'phone' ? (
            <Keypad myNumber={myNumber} value={dialValue} onChange={setDialValue} book={book} focusKey={focusKey} />
          ) : (
            <SmsPanel
              threadKey={activeThread}
              composing={smsComposing}
              threads={threads}
              book={book}
              initial={initialThread}
              onNew={() => setComposing({ to: '', key: Date.now() })}
              onCancelNew={() => setComposing(null)}
              onSent={(e164) => {
                setThread(e164);
                setComposing(null);
              }}
              onCall={callNumber}
              onAddContact={addContact}
            />
          )}
        </aside>
      </div>

      {main === 'sms' && smsExtra ? <div>{smsExtra}</div> : null}
    </div>
  );
}
