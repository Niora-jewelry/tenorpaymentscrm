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
}: {
  subtabId: string;
  comingSoon: boolean;
  subtabLabel: string;
  messages: Message[];
}) {
  const [now] = useState(() => Date.now());
  const channel: MessageChannel = subtabId === 'text' ? 'text' : subtabId === 'instantly' ? 'instantly' : 'email';

  const channelMessages = useMemo(
    () => messages.filter((m) => m.channel === channel),
    [messages, channel],
  );

  if (comingSoon) {
    const icon = subtabId === 'teams' ? 'video' : subtabId === 'recordings' ? 'mic' : 'phone';
    return <ComingSoon what={subtabLabel} icon={icon} />;
  }

  return (
    <div className="space-y-3">
      <LastMessageReceived messages={messages} now={now} />

      <SpecNote>
        Inbound messages land on a record by matching the sender against <strong>sync-enabled</strong>{' '}
        Email and Phone fields. If an identity matches several records the message deposits into{' '}
        <strong>all</strong> of them; if the sender already exists, no new record is ever created.
        Sync is forward-only — no historical backfill.
      </SpecNote>

      {channelMessages.length === 0 ? (
        <EmptyState icon={CHANNEL_ICON[channel]} title="No messages yet" body="Nothing has arrived on this channel." />
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
