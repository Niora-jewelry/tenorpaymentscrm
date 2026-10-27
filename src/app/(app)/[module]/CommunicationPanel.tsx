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
 * TEAMS is still `ComingSoon`, by the client's own spec: no provider is wired
 * for it. Which sub-tab is a placeholder is read from `subtabs.coming_soon`
 * rather than decided here (CLAUDE.md rule 1).
 *
 * Email is a real read of `messages`; there is no send path on THIS panel
 * because those rows only ever arrive through a provider running as the
 * service role. Texting does have a send path — the composer on Texts.
 */
import { useMemo, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { CHANNEL_ICON } from '@/proto/ui/icons';
import { ComingSoon, EmptyState, OutlineChip, SpecNote, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import type { Message, MessageChannel } from '@/lib/records/messages';
import type { PhoneCall } from '@/lib/phone/calls';
import type { PhoneMessage } from '@/lib/phone/messages';
import type { TextableNumber } from '@/lib/phone/textableNumbers';
import { PhonePanel, RecordingsPanel, SmsThread } from './PhonePanels';
import { PHONE_VIEWS, phoneViewFrom, type PhoneView } from './phoneViews';

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
  subtabLabel,
  messages,
  moduleSlug,
  calls,
  smsMessages,
  recordPhones,
}: {
  subtabId: string;
  comingSoon: boolean;
  subtabLabel: string;
  messages: Message[];
  moduleSlug: string;
  calls: PhoneCall[];
  smsMessages: PhoneMessage[];
  /** Numbers on this record a text may be sent to — see textableNumbers.ts. */
  recordPhones: TextableNumber[];
}) {
  const [now] = useState(() => Date.now());

  /*
   * The flag decides, not this file: an admin can switch a sub-tab to
   * "coming soon" and back in Presets (migration 70 cleared it for Phone).
   */
  if (comingSoon) {
    return <ComingSoon what={subtabLabel} icon={subtabId === 'teams' ? 'video' : 'phone'} />;
  }

  if (subtabId === 'phone') {
    return (
      <PhoneViews
        moduleSlug={moduleSlug}
        calls={calls}
        messages={messages}
        smsMessages={smsMessages}
        recordPhones={recordPhones}
        now={now}
      />
    );
  }

  return <ChannelMessages channel="email" messages={messages} smsMessages={smsMessages} calls={calls} recordPhones={recordPhones} moduleSlug={moduleSlug} now={now} />;
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
  recordPhones,
  now,
}: {
  moduleSlug: string;
  calls: PhoneCall[];
  messages: Message[];
  smsMessages: PhoneMessage[];
  recordPhones: TextableNumber[];
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
                on ? 'bg-white text-ink-900 shadow-[0_1px_2px_rgba(8,32,47,.10)] ring-1 ring-line' : 'text-ink-500 hover:text-ink-900'
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
          <ChannelMessages channel="text" messages={messages} smsMessages={smsMessages} calls={calls} recordPhones={recordPhones} moduleSlug={moduleSlug} now={now} />
        )}
      </div>
    </div>
  );
}

/** Email, or Texts under Phone: the last inbound, then (texts only) the
 *  composer, then the history. */
function ChannelMessages({
  channel,
  messages,
  smsMessages,
  calls,
  recordPhones,
  moduleSlug,
  now,
}: {
  channel: MessageChannel;
  messages: Message[];
  smsMessages: PhoneMessage[];
  calls: PhoneCall[];
  recordPhones: TextableNumber[];
  moduleSlug: string;
  now: number;
}) {
  const channelMessages = useMemo(
    () => messages.filter((m) => m.channel === channel),
    [messages, channel],
  );

  return (
    <div className="space-y-3">
      <LastMessageReceived channel={channel} messages={messages} smsMessages={smsMessages} now={now} />

      <SpecNote>
        Inbound messages land on a record by matching the sender against <strong>sync-enabled</strong>{' '}
        Email and Phone fields. If an identity matches several records the message deposits into{' '}
        <strong>all</strong> of them; if the sender already exists, no new record is ever created.
        Sync is forward-only — no historical backfill.
      </SpecNote>

      {/* Texts: the composer comes straight after the note, above the history —
          the client's layout. SmsThread renders newest-first beneath the box,
          so the message being answered sits right under the reply. */}
      {channel === 'text' ? (
        <SmsThread
          moduleSlug={moduleSlug}
          messages={smsMessages}
          toE164={replyTarget(smsMessages, calls)}
          recordPhones={recordPhones}
        />
      ) : null}

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

/**
 * ⚠ SMS LIVES IN A DIFFERENT TABLE, AND THIS SUMMARY HAS TO READ BOTH.
 *
 * `messages` is the `messages` table — email and the other channels. Inbound
 * texts are `phone_messages`, written by the Twilio webhook. This read only the
 * first, so a record whose only inbound contact was a text displayed
 * "Nothing inbound yet — every message on this record was sent by us" directly
 * above the text itself. Seen on a real record the first time an inbound SMS
 * arrived.
 *
 * The two are merged into one shape here rather than being joined upstream:
 * they are genuinely different tables with different lifecycles, and the only
 * place that needs them as one list is this summary.
 */
type InboundSummary = { channel: MessageChannel; body: string | null; from: string; sentAt: string };

function LastMessageReceived({
  channel,
  messages,
  smsMessages,
  now,
}: {
  /** The subtab being viewed. The summary is ABOUT this channel — see below. */
  channel: MessageChannel;
  messages: Message[];
  smsMessages: PhoneMessage[];
  now: number;
}) {
  /*
   * ⚠ SCOPED TO THE SUBTAB YOU ARE ON.
   *
   * This header sits above whichever channel subtab is open, so an unscoped
   * "last message received" put a TEXT at the top of the Email subtab —
   * an SMS pill and an Indian mobile number above an empty email thread
   * reading "No messages yet". The two statements were both true and read as a
   * contradiction.
   *
   * Texts only join in on the Text subtab, where they belong: `phone_messages`
   * IS the text channel, while `messages` carries email and the rest.
   */
  const inbound: InboundSummary[] = [
    ...messages
      .filter((m) => m.direction === 'in' && m.channel === channel)
      .map((m) => ({ channel: m.channel, body: m.body, from: m.from, sentAt: m.sentAt })),
    ...(channel === 'text'
      ? smsMessages
          .filter((m) => m.direction === 'in')
          .map((m) => ({
            channel: 'text' as MessageChannel,
            body: m.body,
            from: m.fromE164,
            sentAt: m.sentAt,
          }))
      : []),
  ].sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

  const last = inbound[0];

  if (!last) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-dashed border-line bg-white/60 px-3.5 py-2.5">
        <Icon name="reply" size={15} className="text-ink-400" />
        <span className="text-[12.5px] font-semibold uppercase tracking-[.06em] text-ink-400">
          Last message received
        </span>
        <span className="text-[13px] text-ink-400">
          Nothing inbound on this channel yet — everything here was sent by us.
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
/**
 * Who a reply goes to — the other end of the most recent exchange.
 *
 * Returns null when there has been no exchange at all, and that is NOT the
 * same as "this record cannot be texted": a merchant who never wrote first
 * still has a number on the record. `recordPhones` carries those and
 * SmsThread falls back to them. The two are kept apart deliberately — a
 * REPLY must go back to the number actually used, even where the record
 * lists three others.
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
