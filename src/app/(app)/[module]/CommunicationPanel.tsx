'use client';

/**
 * Communication tab — layout ported from `src/proto/ui/tabs.tsx`'s
 * `CommunicationTab`/`LastMessageReceived`, reading the real `messages`
 * table. Teams/Phone/Call recordings stay `ComingSoon` (the client's own
 * spec, not a cut corner — no provider is wired for those yet). Email/
 * Instantly/Text are real reads: no send path exists here because messages
 * only ever arrive through a provider webhook running as the service role,
 * which bypasses RLS entirely (`messages_select`'s own policy comment) — the
 * empty state you see today is real absence of data, not a stubbed screen.
 */
import { useMemo, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { CHANNEL_ICON } from '@/proto/ui/icons';
import { ComingSoon, EmptyState, OutlineChip, SpecNote, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import type { Message, MessageChannel } from '@/lib/records/messages';
import type { PhoneCall } from '@/lib/phone/calls';
import type { PhoneMessage } from '@/lib/phone/messages';
import { PhonePanel, RecordingsPanel, SmsThread } from './PhonePanels';

function channelMeta(channel: MessageChannel) {
  if (channel === 'instantly') return { label: 'Instantly', swatch: 'purple' as const };
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
  subtabLabel,
  messages,
  moduleSlug,
  calls,
  smsMessages,
}: {
  subtabId: string;
  comingSoon: boolean;
  subtabLabel: string;
  messages: Message[];
  moduleSlug: string;
  calls: PhoneCall[];
  smsMessages: PhoneMessage[];
}) {
  const [now] = useState(() => Date.now());
  const channel: MessageChannel = subtabId === 'text' ? 'text' : subtabId === 'instantly' ? 'instantly' : 'email';

  const channelMessages = useMemo(
    () => messages.filter((m) => m.channel === channel),
    [messages, channel],
  );

  /*
   * The flag decides, not this file.
   *
   * An earlier version checked the subtab key BEFORE `comingSoon` so the new
   * Twilio panels would render regardless of what the database said. That
   * worked and was wrong: it moved the decision into code, where an admin
   * cannot reach it, and quietly removed their ability to switch Phone or Call
   * recordings back off. Migration 70 clears the flag for those two instead —
   * configuration, not code (CLAUDE.md rule 1).
   */
  if (comingSoon) {
    const icon = subtabId === 'teams' ? 'video' : subtabId === 'recordings' ? 'mic' : 'phone';
    return <ComingSoon what={subtabLabel} icon={icon} />;
  }

  if (subtabId === 'phone') return <PhonePanel calls={calls} />;
  if (subtabId === 'recordings') return <RecordingsPanel calls={calls} />;

  return (
    <div className="space-y-3">
      <LastMessageReceived messages={messages} now={now} />

      <SpecNote>
        Inbound messages land on a record by matching the sender against <strong>sync-enabled</strong>{' '}
        Email and Phone fields. If an identity matches several records the message deposits into{' '}
        <strong>all</strong> of them; if the sender already exists, no new record is ever created.
        Sync is forward-only — no historical backfill.
      </SpecNote>

      {/*
        ── ORDER MATTERS ON THE TEXT SUBTAB ───────────────────────────────
        History first, composer LAST. A conversation reads downward to the
        newest message with the send box beneath it; the first arrangement put
        the composer on top with older messages below, which reads backwards.

        The empty state is also suppressed once live texts exist. Two sources
        feed this tab — `messages` (arrived through a provider webhook) and
        `phone_messages` (sent and received over Twilio by us) — and checking
        only the first one printed "No messages yet. Nothing has arrived on
        this channel." directly above a visible thread of real texts.
      */}
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

      {channel === 'text' ? (
        <SmsThread
          moduleSlug={moduleSlug}
          messages={smsMessages}
          toE164={replyTarget(smsMessages, calls)}
        />
      ) : null}
    </div>
  );
}

function LastMessageReceived({ messages, now }: { messages: Message[]; now: number }) {
  const last = messages.find((m) => m.direction === 'in');

  if (!last) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-dashed border-line bg-white/60 px-3.5 py-2.5">
        <Icon name="reply" size={15} className="text-ink-400" />
        <span className="text-[12.5px] font-semibold uppercase tracking-[.06em] text-ink-400">
          Last message received
        </span>
        <span className="text-[13px] text-ink-400">
          Nothing inbound yet — every message on this record was sent by us.
        </span>
      </div>
    );
  }

  const stale = now - new Date(last.sentAt).getTime() > 14 * 86_400_000;
  const meta = channelMeta(last.channel);

  return (
    <div className="rounded-xl border border-line bg-white p-3.5 shadow-[0_1px_2px_rgba(8,32,47,.04)]">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="reply" size={15} className="text-brand-600" />
        <span className="text-[12.5px] font-semibold uppercase tracking-[.06em] text-ink-400">
          Last message received
        </span>
        <StatusPill label={meta.label} swatch={meta.swatch} dot={false} />
        <span className="ml-auto flex items-center gap-2">
          {stale ? <OutlineChip tone="warn">No reply in 2 weeks</OutlineChip> : null}
          <span className="text-[11.5px] text-ink-400 tabular">{relativeTime(last.sentAt, now)}</span>
        </span>
      </div>
      <p className="mt-2 line-clamp-2 text-[13.5px] leading-relaxed text-ink-900">{last.body}</p>
      <p className="mt-1 text-[11.5px] text-ink-400">
        {last.from} · {formatDateTime(last.sentAt)}
      </p>
    </div>
  );
}

/**
 * Which number a reply should go to.
 *
 * The most recent counterpart wins: the last person who texted, else the last
 * number called. Deriving it rather than asking means the composer works
 * without a picker on the overwhelmingly common case — one merchant, one
 * number. Null when the record has no telephony history at all, and the
 * composer then explains what to do instead of rendering a dead box.
 */
function replyTarget(messages: PhoneMessage[], calls: PhoneCall[]): string | null {
  const lastMessage = messages[messages.length - 1];
  if (lastMessage) {
    return lastMessage.direction === 'in' ? lastMessage.fromE164 : lastMessage.toE164;
  }
  const lastCall = calls[0]; // already newest-first
  if (lastCall) return lastCall.direction === 'in' ? lastCall.fromE164 : lastCall.toE164;
  return null;
}
