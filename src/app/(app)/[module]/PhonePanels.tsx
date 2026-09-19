'use client';

/**
 * The three phone surfaces inside a record's Communication tab.
 *
 * These fill the two subtabs the client's own spec reserved and the seed
 * shipped as `coming_soon` — `communication/phone` and
 * `communication/recordings` — plus a send box on `communication/text`.
 *
 * ── WHAT EACH ONE DELIBERATELY DOES NOT DO ───────────────────────────────
 * No audio is reachable from the call list. A recording is only ever fetched
 * through `getRecordingUrlAction`, which takes the RECORDING'S ID and checks
 * the gate before signing anything — and underneath that, both the row and the
 * bucket restrict audio to the call's owner and to admins (migration 68). A
 * colleague who can see the merchant sees that a call happened; they do not get
 * a play button unless it was their call.
 *
 * That asymmetry is why `recordings` arrives as an empty array rather than as a
 * list with disabled buttons: absent, never blank, per CLAUDE.md rule 3.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, EmptyState, SpecNote, Spinner, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import type { PhoneCall } from '@/lib/phone/calls';
import type { PhoneMessage } from '@/lib/phone/messages';
import { getRecordingUrlAction, sendSmsAction } from '../phoneActions';

/** Seconds → `4:07`. A null duration means the call never connected. */
function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Twilio's raw status → something a person reads.
 *
 * The column stores Twilio's vocabulary verbatim on purpose (it drifts), so the
 * translation happens here, at the edge, where an unrecognised value can fall
 * through to itself rather than being dropped at write time.
 */
function callTone(call: PhoneCall): { label: string; swatch: 'teal' | 'blue' | 'amber' | 'red' } {
  if (['no-answer', 'busy', 'failed'].includes(call.status)) {
    return { label: call.direction === 'in' ? 'Missed' : 'No answer', swatch: 'red' };
  }
  if (call.status === 'completed') {
    return { label: call.direction === 'in' ? 'Received' : 'Called', swatch: 'teal' };
  }
  if (['ringing', 'queued', 'in-progress'].includes(call.status)) {
    return { label: 'In progress', swatch: 'amber' };
  }
  return { label: call.status || 'Unknown', swatch: 'blue' };
}

/* ========================================================================
 * Phone — the call log for this record
 * ==================================================================== */

export function PhonePanel({ calls }: { calls: PhoneCall[] }) {
  if (calls.length === 0) {
    return (
      <EmptyState
        icon="phone"
        title="No calls yet"
        body="Calls to and from this merchant's numbers appear here automatically."
      />
    );
  }

  return (
    <div className="space-y-3">
      <SpecNote>
        A call is matched to this record by comparing the other party&rsquo;s number against{' '}
        <strong>sync-enabled</strong> phone fields — a contact&rsquo;s or an owner&rsquo;s number.
        A call from a number the CRM has never seen is still logged, just not attached here.
      </SpecNote>

      <ul className="space-y-2">
        {calls.map((call) => {
          const tone = callTone(call);
          const other = call.direction === 'in' ? call.fromE164 : call.toE164;
          return (
            <li key={call.id} className="rounded-xl border border-line bg-white p-3">
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label={tone.label} swatch={tone.swatch} dot={false} />
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-700">
                  <Icon name={call.direction === 'in' ? 'reply' : 'send'} size={12} className="text-ink-400" />
                  {formatPhoneDisplay(other)}
                </span>
                <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-400 tabular">
                  <Icon name="clock" size={11} />
                  {formatDuration(call.durationSeconds)}
                </span>
                <span className="ml-auto text-[11.5px] text-ink-400 tabular">
                  {formatDateTime(call.startedAt)}
                </span>
              </div>

              {call.recordings.length > 0 ? (
                <div className="mt-2.5 space-y-2 border-t border-line-faint pt-2.5">
                  {call.recordings.map((rec) => (
                    <RecordingRow key={rec.id} recording={rec} />
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ========================================================================
 * Call recordings — every recording on this record, flattened
 * ==================================================================== */

export function RecordingsPanel({ calls }: { calls: PhoneCall[] }) {
  const rows = calls.flatMap((call) =>
    call.recordings.map((rec) => ({ call, rec })),
  );

  if (rows.length === 0) {
    return (
      <EmptyState
        icon="mic"
        title="No recordings"
        body="Recordings of calls you were on appear here once Twilio finishes processing them."
      />
    );
  }

  return (
    <div className="space-y-3">
      <SpecNote>
        Only calls <strong>you</strong> were on are listed — recordings are restricted to the person
        on the call and to administrators, even for colleagues who can otherwise see this record.
      </SpecNote>

      <ul className="space-y-2">
        {rows.map(({ call, rec }) => (
          <li key={rec.id} className="rounded-xl border border-line bg-white p-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill
                label={rec.kind === 'voicemail' ? 'Voicemail' : 'Call'}
                swatch={rec.kind === 'voicemail' ? 'amber' : 'teal'}
                dot={false}
              />
              <span className="text-[12.5px] font-semibold text-ink-700">
                {formatPhoneDisplay(call.direction === 'in' ? call.fromE164 : call.toE164)}
              </span>
              <span className="ml-auto text-[11.5px] text-ink-400 tabular">
                {formatDateTime(call.startedAt)}
              </span>
            </div>
            <div className="mt-2.5">
              <RecordingRow recording={rec} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One recording.
 *
 * The audio element is created only AFTER the signed URL arrives, because a
 * signed URL lives 60 seconds — minting one for every row on render would leave
 * most of them expired before anyone pressed play, and would hand out links
 * nobody asked for.
 */
/**
 * Exported because the standalone Phone page needs it too.
 *
 * Recordings were reachable ONLY from inside a record's drawer, so a call that
 * matched no merchant produced audio that existed in storage, was listed in
 * `phone_recordings`, and had nowhere in the app it could be played. Every call
 * to or from a number that is not on a record — which is most testing, and any
 * call to a new prospect — fell into that hole.
 */
export function RecordingRow({ recording }: { recording: { id: string; kind: 'call' | 'voicemail'; durationSeconds: number | null; storagePath: string | null } }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // `storage_path` is null between Twilio finishing the call and its recording
  // callback landing. Saying so beats an audio element that will not play.
  if (!recording.storagePath) {
    return (
      <p className="inline-flex items-center gap-1.5 text-[12px] text-ink-400">
        <Spinner className="size-3" />
        Processing the recording…
      </p>
    );
  }

  if (url) {
    return <audio controls autoPlay src={url} className="h-8 w-full max-w-[420px]" />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        icon="mic"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            try {
              setUrl(await getRecordingUrlAction(recording.id));
            } catch {
              setError('Could not open that recording.');
            }
          })
        }
      >
        {pending ? 'Opening…' : `Play ${recording.kind === 'voicemail' ? 'voicemail' : 'recording'}`}
      </Button>
      <span className="text-[11.5px] text-ink-400 tabular">
        {formatDuration(recording.durationSeconds)}
      </span>
      {error ? <span className="text-[11.5px] text-red-600">{error}</span> : null}
    </div>
  );
}

/* ========================================================================
 * Text — the live SMS thread, under whatever legacy messages exist
 * ==================================================================== */

export function SmsThread({
  moduleSlug,
  messages,
  toE164,
}: {
  moduleSlug: string;
  messages: PhoneMessage[];
  /** The number to reply to — the most recent counterpart on this record. */
  toE164: string | null;
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const send = () => {
    const trimmed = body.trim();
    if (!trimmed || !toE164) return;
    startTransition(async () => {
      setError(null);
      const result = await sendSmsAction(toE164, trimmed, `/${moduleSlug}`);
      if (result.ok) setBody('');
      else setError(result.message);
    });
  };

  return (
    <div className="space-y-3">
      {messages.length > 0 ? (
        <ul className="space-y-2">
          {messages.map((m) => (
            <li
              key={m.id}
              className={`rounded-xl border p-3 ${
                m.direction === 'in' ? 'border-line bg-white' : 'border-brand-100 bg-brand-50/60'
              }`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <StatusPill label="SMS" swatch="teal" dot={false} />
                <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-ink-700">
                  <Icon name={m.direction === 'in' ? 'reply' : 'send'} size={12} className="text-ink-400" />
                  {m.direction === 'in'
                    ? formatPhoneDisplay(m.fromE164)
                    : `to ${formatPhoneDisplay(m.toE164)}`}
                </span>
                <span className="ml-auto text-[11.5px] text-ink-400 tabular">
                  {formatDateTime(m.sentAt)}
                </span>
              </div>
              <p className="mt-1 text-[13.5px] leading-relaxed text-ink-700">{m.body}</p>
              {m.direction === 'out' ? (
                // Twilio's own word for where the message got to. Shown quietly
                // because most of the time it is simply "delivered".
                <p className="mt-1.5 text-[11px] uppercase tracking-[.05em] text-ink-400">{m.status}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {toE164 ? (
        <div className="rounded-xl border border-line bg-white p-3">
          <label htmlFor="sms-body" className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
            Text {formatPhoneDisplay(toE164)}
          </label>
          <textarea
            id="sms-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={3}
            maxLength={1600}
            placeholder="Type a message…"
            className="mt-1.5 w-full resize-y rounded-lg border border-line bg-canvas/40 px-2.5 py-2 text-[13.5px] text-ink-900 focus-field"
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter makes a new line — the convention
              // every messaging box already uses.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="sm" icon="send" onClick={send} disabled={pending || !body.trim()}>
              {pending ? 'Sending…' : 'Send'}
            </Button>
            <span className="text-[11.5px] text-ink-400">{body.length}/1600</span>
            {error ? <span className="text-[11.5px] text-red-600">{error}</span> : null}
          </div>
        </div>
      ) : (
        <SpecNote>
          No phone number on this record yet. Add one to a contact or an owner — and switch{' '}
          <strong>sync</strong> on for that field — and texts will thread here.
        </SpecNote>
      )}
    </div>
  );
}
