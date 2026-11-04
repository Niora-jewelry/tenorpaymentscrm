'use client';

/**
 * Calendar and Chat on the settings page: which connected accounts feed them (one
 * Microsoft connection feeds Email, Calendar and Chat), a Reconnect or Approve where
 * one is needed, and, for Admins and Super admins, the two hide switches.
 */
import { useState, useTransition } from 'react';
import { Button } from '@/proto/ui/kit';
import type { AccountView } from '@/lib/msteams/types';
import { setTeamsPrivacyAction } from './teamsActions';

const START = '/api/mail/oauth/start';
const go = (email: string) => window.location.assign(new URL(`${START}?${new URLSearchParams({ kind: 'personal', return: '/email/settings', hint: email }).toString()}`, window.location.origin).toString());

export function TeamsSettings({ accounts, waiting, canHide, hideCalendar, hideChat, readOnly }: { accounts: AccountView[]; waiting: boolean; canHide: boolean; hideCalendar: boolean; hideChat: boolean; readOnly: boolean }) {
  const [calendar, setCalendar] = useState(hideCalendar);
  const [chat, setChat] = useState(hideChat);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const save = (next: { calendar: boolean; chat: boolean }, undo: () => void, text: string) => {
    start(async () => {
      const r = await setTeamsPrivacyAction(next);
      if (!r.ok) undo();
      setMessage({ ok: r.ok, text: r.ok ? text : r.message });
    });
  };

  return (
    <section id="teams" className="scroll-mt-6 space-y-3">
      <h2 className="text-[15px] font-semibold text-ink-900">Calendar and Chat</h2>
      <p className="max-w-[62ch] text-[12.5px] leading-relaxed text-ink-500">The Microsoft accounts connected above also feed Calendar and Chat once they have approved calendar and chat access. Disconnecting an account removes its email, calendar and chats from Tenor.</p>
      {waiting ? <p className="rounded-md border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[12.5px] font-medium text-[#8a5a09]">Waiting for admin approval: your organization’s Microsoft admin has to approve Tenor before your account can finish connecting. Open Calendar or Chat to copy a request for them.</p> : null}
      {accounts.length ? (
        <ul className="divide-y divide-line-faint rounded-xl border border-line bg-white">
          {accounts.map((a) => (
            <li key={a.identityId} className="flex items-center gap-3 px-4 py-3">
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink-800">{a.email}</span>
              {a.status === 'reconnect' ? (
                <>
                  <span className="text-[12px] font-semibold text-[#b02a30]">Needs reconnect</span>
                  {!readOnly ? (
                    <Button size="sm" variant="secondary" onClick={() => go(a.email)}>
                      Reconnect
                    </Button>
                  ) : null}
                </>
              ) : a.approved ? (
                <span className="text-[12px] font-semibold text-[#1a7a3c]">Calendar and Chat on</span>
              ) : (
                <>
                  <span className="text-[12px] text-ink-500">Email only</span>
                  {!readOnly ? (
                    <Button size="sm" variant="primary" onClick={() => go(a.email)}>
                      Approve calendar and chat
                    </Button>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {canHide && !readOnly ? (
        <div className="space-y-2">
          {(
            [
              { key: 'calendar', label: 'Hide my Calendar from other admins', value: calendar, set: setCalendar },
              { key: 'chat', label: 'Hide my Chat from other admins', value: chat, set: setChat },
            ] as const
          ).map((row) => (
            <label key={row.key} className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-white p-4">
              <input
                type="checkbox"
                role="switch"
                checked={row.value}
                disabled={pending}
                aria-label={row.label}
                onChange={(e) => {
                  const v = e.target.checked;
                  row.set(v);
                  const next = row.key === 'calendar' ? { calendar: v, chat } : { calendar, chat: v };
                  save(next, () => row.set(!v), v ? `Your ${row.key === 'calendar' ? 'Calendar' : 'Chat'} is now hidden from everyone else.` : `Others with All users can see your ${row.key === 'calendar' ? 'Calendar' : 'Chat'} again.`);
                }}
                className="mt-0.5 accent-brand-600"
              />
              <span>
                <span className="block text-[13.5px] font-semibold text-ink-900">{row.label}</span>
                <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-500">Nobody else can pick you in {row.key === 'calendar' ? 'Calendar' : 'Chat'}, Super admins included. You always see your own.</span>
              </span>
            </label>
          ))}
          {message ? <p className={`text-[12.5px] font-medium ${message.ok ? 'text-[#1a7a3c]' : 'text-[#b02a30]'}`}>{message.text}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
