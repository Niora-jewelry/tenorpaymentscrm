'use client';

/**
 * What the Calendar and Chat screens share: the browser check, the Connect screen, the
 * person picker and the notices. Not a route: this folder has no page.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { AccountView, PersonChoice, PersonResult, Staleness, TeamsKind } from '@/lib/msteams/types';

const START = '/api/mail/oauth/start';

export const connectHref = (kind: TeamsKind, hint?: string) => {
  const q = new URLSearchParams({ kind: 'personal', return: kind === 'calendar' ? '/calendar' : '/chat' });
  if (hint) q.set('hint', hint);
  return `${START}?${q.toString()}`;
};

/** A navigation, not a link: the route answers with a redirect out to Microsoft. */
export const goToMicrosoft = (href: string) => window.location.assign(new URL(href, window.location.origin).toString());

/** Chrome on a laptop or desktop, as Email. */
export function isSupportedBrowser(ua: string): boolean {
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(ua)) return false;
  if (/Edg\/|OPR\/|Opera|SamsungBrowser|Vivaldi|YaBrowser|Brave/i.test(ua)) return false;
  return /Chrome\/\d+/i.test(ua);
}

export function BrowserGate({ label, children }: { label: string; children: ReactNode }) {
  // Assumed fine until the browser has been asked, so the page is not blank for everyone.
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    const narrow = window.matchMedia('(max-width: 767px)').matches;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the user agent exists only in the browser
    setSupported(!narrow && isSupportedBrowser(navigator.userAgent));
  }, []);
  if (supported) return <>{children}</>;
  return (
    <div className="grid h-full place-items-center bg-canvas px-6 text-center">
      <div className="max-w-[420px]">
        <h1 className="text-[17px] font-semibold text-ink-900">{label} is not supported here</h1>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-500">Open Tenor in Chrome on a laptop or desktop computer to use {label}.</p>
      </div>
    </div>
  );
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const sync = () => setOnline(navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);
  return online;
}

type Tone = 'info' | 'warn' | 'error';
const TONE: Record<Tone, string> = {
  info: 'border-[#cfdcf2] bg-[#edf3fc] text-[#1e4080]',
  warn: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]',
  error: 'border-[#f7cfd1] bg-[#fce9ea] text-[#b02a30]',
};

export function Notice({ tone, children, action }: { tone: Tone; children: ReactNode; action?: ReactNode }) {
  return (
    <div role="status" className={`flex items-center gap-2 border-b px-4 py-2 text-[12.5px] font-medium ${TONE[tone]}`}>
      <Icon name={tone === 'info' ? 'info' : 'alert-triangle'} size={14} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Every state the spec names, one line each, the most serious first. */
export function StatusNotices({ kind, online, stale, accounts, lookingAt, waiting, onApprove }: { kind: TeamsKind; online: boolean; stale: Staleness; accounts: AccountView[]; lookingAt: string | null; waiting: boolean; onApprove?: (email: string) => void }) {
  const broken = accounts.filter((a) => a.status === 'reconnect');
  const unapproved = accounts.filter((a) => !a.approved && a.status === 'ok');
  return (
    <>
      {!online ? <Notice tone="warn">You are offline. This is the data already loaded. Sending and changes are switched off until the connection returns, and nothing is queued.</Notice> : null}
      {broken.map((a) => (
        <Notice
          key={a.identityId}
          tone="error"
          action={
            <button type="button" onClick={() => goToMicrosoft(connectHref(kind, a.email))} className="shrink-0 rounded-md border border-current px-2 py-0.5 text-[12px] font-semibold">
              Reconnect
            </button>
          }
        >
          Microsoft stopped accepting {a.email}. Reconnect it. What is shown from it is out of date.
        </Notice>
      ))}
      {stale === 'reconnect' && broken.length === 0 ? <Notice tone="error">Microsoft stopped accepting this connection. What is shown is out of date.</Notice> : null}
      {stale === 'down' ? <Notice tone="warn">Microsoft is not responding. This is the last loaded data, so it may be out of date.</Notice> : null}
      {waiting ? <Notice tone="warn">Waiting for admin approval on an account you tried to connect.</Notice> : null}
      {!waiting && onApprove
        ? unapproved.map((a) => (
            <Notice
              key={a.identityId}
              tone="info"
              action={
                <button type="button" onClick={() => onApprove(a.email)} className="shrink-0 rounded-md border border-current px-2 py-0.5 text-[12px] font-semibold">
                  Approve
                </button>
              }
            >
              {a.email} has not approved calendar and chat access yet, so nothing from it shows here.
            </Notice>
          ))
        : null}
      {lookingAt ? <Notice tone="info">You are looking at {lookingAt}. This is look only: nothing can be sent, changed or answered for them.</Notice> : null}
    </>
  );
}

export function PersonPicker({ people, value, label }: { people: PersonChoice[]; value: string; label: string }) {
  const router = useRouter();
  if (people.length <= 1) return null;
  return (
    <label className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink-500">
      <span className="sr-only">{label}</span>
      <Icon name="users" size={14} />
      <select
        aria-label={label}
        value={value}
        onChange={(e) => {
          const own = people.find((p) => p.userId === e.target.value)?.own;
          // A real navigation of the page, so the server re-checks who may look at whom.
          router.push(own ? window.location.pathname : `${window.location.pathname}?as=${e.target.value}`);
        }}
        className="max-w-[210px] cursor-pointer rounded-md border border-line bg-white px-2 py-1 text-[12.5px] font-semibold text-ink-800 outline-none hover:border-ink-400 focus:border-ink-500"
      >
        {people.map((p) => (
          <option key={p.userId} value={p.userId}>
            {p.name}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The screen before anything can load. Own accounts only: an All users setting does not skip it. */
export function ConnectScreen({ kind, accounts, waiting, requestText, errorText, impersonating }: { kind: TeamsKind; accounts: AccountView[]; waiting: boolean; requestText: string; errorText: string | null; impersonating: boolean }) {
  const label = kind === 'calendar' ? 'Calendar' : 'Chat';
  const [copied, setCopied] = useState(false);
  const toApprove = accounts.filter((a) => !a.approved);

  const heading = waiting ? 'Waiting for admin approval' : toApprove.length ? 'Approve calendar and chat access' : `Connect Microsoft to use ${label}`;

  return (
    <div className="grid h-full place-items-center overflow-y-auto bg-canvas px-6 py-10">
      <div className="w-full max-w-[480px] rounded-xl border border-line bg-white p-7">
        <span className="grid size-10 place-items-center rounded-lg bg-canvas text-ink-700">
          <Icon name={kind === 'calendar' ? 'calendar' : 'message-square'} size={20} />
        </span>
        <h1 className="mt-4 text-[18px] font-semibold tracking-[-.01em] text-ink-900">{heading}</h1>

        {errorText ? <p className="mt-3 rounded-md border border-[#f7cfd1] bg-[#fce9ea] px-3 py-2 text-[12.5px] text-[#b02a30]">{errorText}</p> : null}

        {impersonating ? (
          <p className="mt-2 text-[13px] leading-relaxed text-ink-500">This is not available while signed in as someone else.</p>
        ) : waiting ? (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-500">Your organization’s Microsoft admin has to approve Tenor before your account can finish connecting. No data loads until they do. Copy this request and send it to them, then try again once they have approved it.</p>
            <textarea readOnly aria-label="Request for your Microsoft admin" value={requestText} rows={7} className="mt-3 w-full resize-none rounded-md border border-line bg-canvas px-3 py-2 text-[12px] leading-relaxed text-ink-700 outline-none" />
            <div className="mt-3 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon={copied ? 'check' : 'copy'}
                onClick={() => {
                  void navigator.clipboard.writeText(requestText).then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy request'}
              </Button>
              <Button variant="primary" icon="refresh-cw" onClick={() => goToMicrosoft(connectHref(kind, toApprove[0]?.email))}>
                Try again
              </Button>
            </div>
          </>
        ) : toApprove.length ? (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-500">You already connected Outlook for Email. Approve the extra access once and {label} is ready. You do not connect a second time, and your email keeps working.</p>
            <ul className="mt-4 divide-y divide-line-faint rounded-lg border border-line">
              {toApprove.map((a) => (
                <li key={a.identityId} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-800">{a.email}</span>
                  <Button variant="primary" size="sm" onClick={() => goToMicrosoft(connectHref(kind, a.email))}>
                    Approve
                  </Button>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-500">Sign in with Microsoft and approve access to your mail, calendar and chats. That one connection feeds Email, Calendar and Chat.</p>
            <div className="mt-4">
              <Button variant="primary" onClick={() => goToMicrosoft(connectHref(kind))}>
                Connect Microsoft
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Finds people in Microsoft and the CRM, and takes a typed address as well. */
export function PeoplePicker({ picked, onChange, search, placeholder, disabled }: { picked: { email: string; name?: string }[]; onChange: (next: { email: string; name?: string }[]) => void; search: (q: string) => Promise<PersonResult[]>; placeholder: string; disabled?: boolean }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PersonResult[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return;
    let live = true;
    const t = setTimeout(() => {
      void search(term).then((r) => {
        if (live) setResults(r);
      });
    }, 220);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, search]);

  const add = (email: string, name?: string) => {
    if (!picked.some((p) => p.email.toLowerCase() === email.toLowerCase())) onChange([...picked, { email, name }]);
    setQ('');
    setResults([]);
  };
  const typed = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(q.trim()) ? q.trim() : null;
  const shown = q.trim().length >= 2 ? results.filter((r) => !picked.some((p) => p.email.toLowerCase() === r.email.toLowerCase())) : [];

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-line bg-white px-2 py-1.5 focus-within:border-ink-500">
        {picked.map((p) => (
          <span key={p.email} className="inline-flex items-center gap-1 rounded bg-canvas px-1.5 py-0.5 text-[12px] font-medium text-ink-700">
            {p.name || p.email}
            <button type="button" aria-label={`Remove ${p.name || p.email}`} onClick={() => onChange(picked.filter((x) => x.email !== p.email))} className="text-ink-400 hover:text-ink-700">
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        <input
          value={q}
          disabled={disabled}
          aria-label={placeholder}
          placeholder={picked.length ? '' : placeholder}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const top = shown[0];
              if (top) add(top.email, top.name);
              else if (typed) add(typed);
            }
          }}
          className="min-w-[120px] flex-1 bg-transparent py-0.5 text-[13px] text-ink-800 outline-none placeholder:text-ink-400"
        />
      </div>
      {open && (shown.length > 0 || typed) ? (
        <ul className="absolute z-30 mt-1 max-h-[220px] w-full overflow-y-auto rounded-md border border-line bg-white py-1 shadow-lg">
          {shown.map((r) => (
            <li key={r.email}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(r.email, r.name)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-canvas">
                <span className="min-w-0 flex-1 truncate text-[13px] text-ink-800">
                  {r.name} <span className="text-ink-400">{r.email}</span>
                </span>
                <span className="text-[10.5px] font-medium text-ink-400">{r.source === 'crm' ? 'Tenor' : 'Microsoft'}</span>
              </button>
            </li>
          ))}
          {typed && !shown.some((s) => s.email.toLowerCase() === typed.toLowerCase()) ? (
            <li>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => add(typed)} className="w-full px-3 py-1.5 text-left text-[13px] text-ink-700 hover:bg-canvas">
                Add {typed}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}
