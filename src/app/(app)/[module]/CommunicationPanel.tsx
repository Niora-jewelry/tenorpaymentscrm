'use client';

/**
 * Communication tab — Email · Phone · Teams (UI spec §5).
 *
 * Phone holds everything that travels over the phone line, behind one
 * segmented control — Calls | Texts | Call recordings — and opens on Calls.
 * Texts and Call recordings used to be sub-tabs of their own; their content
 * moved here unchanged (nothing deleted). Instantly is gone, sub-tab and
 * integration both.
 *
 * Display only (client, 6 Nov 2026): emails, calls and texts are made from
 * their own modules, and this shows what happened. Last merchant response and
 * Last outreach keep filling from the same traffic.
 *
 * Which sub-tab shows the chats linked to this record is read from
 * `subtabs.shows_record_chats`, and which is a placeholder from
 * `subtabs.coming_soon`, rather than decided here (CLAUDE.md rule 1). Teams is a
 * placeholder for now (migration 9921); the chats panel comes back with the flag.
 */
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { CHANNEL_ICON } from '@/proto/ui/icons';
import { EmptyState, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import type { Message, MessageChannel } from '@/lib/records/messages';
import type { PhoneCall } from '@/lib/phone/calls';
import type { PhoneMessage } from '@/lib/phone/messages';
import { PhonePanel, RecordingsPanel, SmsThread } from './PhonePanels';
import { PHONE_VIEWS, phoneViewFrom, type PhoneView } from './phoneViews';

// Loaded with the sub-tab: it brings the chat composer and its editor along.
const RecordChatsPanel = dynamic(() => import('../chat/ui/RecordChatsPanel').then((m) => m.RecordChatsPanel), { ssr: false });

function channelMeta(channel: MessageChannel) {
  if (channel === 'text') return { label: 'SMS', swatch: 'teal' as const };
  return { label: 'Outlook', swatch: 'blue' as const };
}

function relativeTime(iso: string, now: number): string {
  const days = Math.floor((now - new Date(iso).getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function CommunicationPanel({
  subtabId,
  comingSoon,
  showsRecordChats,
  recordId,
  messages,
  moduleSlug,
  calls,
  smsMessages,
}: {
  subtabId: string;
  comingSoon: boolean;
  /** Migration 9907: this sub-tab holds the record's linked Teams chats. */
  showsRecordChats: boolean;
  recordId: string;
  messages: Message[];
  moduleSlug: string;
  calls: PhoneCall[];
  smsMessages: PhoneMessage[];
}) {
  const [now] = useState(() => Date.now());

  /*
   * The flag decides, not this file: an admin can switch a sub-tab to
   * "coming soon" and back in Presets (migration 70 cleared it for Phone).
   */
  if (showsRecordChats) return <RecordChatsPanel recordId={recordId} />;

  if (comingSoon) {
    return <p className="rounded-xl border border-dashed border-line bg-canvas px-6 py-14 text-center text-[13.5px] text-ink-400">Placeholder</p>;
  }

  if (subtabId === 'phone') {
    return (
      <PhoneViews
        moduleSlug={moduleSlug}
        calls={calls}
        messages={messages}
        smsMessages={smsMessages}
        now={now}
      />
    );
  }

  return <ChannelMessages channel="email" messages={messages} smsMessages={smsMessages} moduleSlug={moduleSlug} now={now} />;
}

/**
 * Calls | Texts | Call recordings. The chosen view is kept in the URL
 * (`view=`) without a navigation, so a notification about a text or a
 * voicemail lands on the right one and a refresh stays put.
 */
function PhoneViews({
  moduleSlug,
  calls,
  messages,
  smsMessages,
  now,
}: {
  moduleSlug: string;
  calls: PhoneCall[];
  messages: Message[];
  smsMessages: PhoneMessage[];
  now: number;
}) {
  const [view, setView] = useState<PhoneView>(() =>
    typeof window === 'undefined' ? 'calls' : phoneViewFrom(new URL(window.location.href).searchParams.get('view')),
  );
  const pick = (next: PhoneView) => {
    setView(next);
    const u = new URL(window.location.href);
    if (next === 'calls') u.searchParams.delete('view');
    else u.searchParams.set('view', next);
    window.history.replaceState(window.history.state, '', u);
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Phone" className="inline-flex rounded-lg border border-line bg-canvas p-0.5">
        {PHONE_VIEWS.map((v) => {
          const on = v.key === view;
          return (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => pick(v.key)}
              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
                on ? 'bg-white text-ink-900 shadow-[0_1px_2px_rgba(14,28,52,.10)] ring-1 ring-line' : 'text-ink-500 hover:text-ink-900'
              }`}
            >
              <Icon name={v.icon} size={12} className={on ? 'text-brand-600' : 'text-ink-400'} />
              {v.label}
            </button>
          );
        })}
      </div>

      <div role="tabpanel">
        {view === 'calls' ? (
          <PhonePanel calls={calls} moduleSlug={moduleSlug} />
        ) : view === 'recordings' ? (
          <RecordingsPanel calls={calls} moduleSlug={moduleSlug} />
        ) : (
          <ChannelMessages channel="text" messages={messages} smsMessages={smsMessages} moduleSlug={moduleSlug} now={now} />
        )}
      </div>
    </div>
  );
}

/** Email, or Texts under Phone: the history, newest first. */
function ChannelMessages({
  channel,
  messages,
  smsMessages,
  moduleSlug,
  now,
}: {
  channel: MessageChannel;
  messages: Message[];
  smsMessages: PhoneMessage[];
  moduleSlug: string;
  now: number;
}) {
  const channelMessages = useMemo(
    () => messages.filter((m) => m.channel === channel),
    [messages, channel],
  );

  return (
    <div className="space-y-3">
      {channel === 'text' ? <SmsThread moduleSlug={moduleSlug} messages={smsMessages} /> : null}

      {/* Two sources feed Texts — `messages` (provider webhook) and
          `phone_messages` (our own Twilio traffic) — so the empty state is
          suppressed once live texts exist. */}
      {channelMessages.length === 0 ? (
        channel === 'text' && smsMessages.length > 0 ? null : (
          <EmptyState icon={CHANNEL_ICON[channel]} title="No messages yet" body="Nothing has arrived on this channel." />
        )
      ) : (
        <ul className="space-y-2">
          {channelMessages.map((m) => {
            const meta = channelMeta(m.channel);
            return (
              <li
                key={m.id}
                className={`rounded-xl border p-3 transition-colors ${
                  m.direction === 'in' ? 'border-line bg-white' : 'border-brand-100 bg-brand-50/60'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill label={meta.label} swatch={meta.swatch} dot={false} />
                  <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-700">
                    <Icon name={m.direction === 'in' ? 'reply' : 'send'} size={12} className="text-ink-400" />
                    {m.direction === 'in' ? m.from : `to ${m.to}`}
                  </span>
                  <span className="ml-auto text-[11.5px] text-ink-400 tabular">{formatDateTime(m.sentAt)}</span>
                </div>
                {m.subject ? <p className="mt-2 text-[13.5px] font-semibold text-ink-900">{m.subject}</p> : null}
                <p className="mt-1 text-[13.5px] leading-relaxed text-ink-700">{m.body}</p>
                <p className="mt-1.5 text-[11.5px] text-ink-400">{relativeTime(m.sentAt, now)}</p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
