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
import type { TextableNumber } from '@/lib/phone/textableNumbers';
import { ConsentBadge } from '../phone/ConsentBadge';
import type { PhoneCall } from '@/lib/phone/calls';
import { TelephonyDelete } from '../TelephonyDelete';
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

export function PhonePanel({ calls, moduleSlug }: { calls: PhoneCall[]; moduleSlug?: string }) {
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
                <TelephonyDelete kind="call" id={call.id} moduleSlug={moduleSlug} />
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

export function RecordingsPanel({ calls, moduleSlug }: { calls: PhoneCall[]; moduleSlug?: string }) {
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
              <TelephonyDelete kind="recording" id={rec.id} moduleSlug={moduleSlug} />
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
  recordPhones,
}: {
  moduleSlug: string;
  messages: PhoneMessage[];
  /** The number to reply to — the most recent counterpart on this record. */
  toE164: string | null;
  /** Numbers on the record itself, for a merchant who has never written. */
  recordPhones: TextableNumber[];
}) {
  const [body, setBody] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  /*
   * ── A REPLY DECIDES ITS OWN DESTINATION; A FIRST MESSAGE DOES NOT ───────
   * A reply goes back to the number that was actually used, even where the
   * record lists three others. Only when there is no thread at all does the
   * record's own number come into it — the merchant who has never texted or
   * called, and who could not be reached from this box before.
   */
  const [chosen, setChosen] = useState<string | null>(null);
  const target = toE164 ?? chosen ?? recordPhones[0]?.e164 ?? null;

  const send = () => {
    const trimmed = body.trim();
    if (!trimmed || !target) return;
    startTransition(async () => {
      setError(null);
      const result = await sendSmsAction(target, trimmed, `/${moduleSlug}`);
      if (result.ok) setBody('');
      else setError(result.message);
    });
  };

  /*
   * ── COMPOSER ON TOP, SO THE THREAD READS NEWEST-FIRST ──────────────────
   * The send box sits directly under the tab's info note, where a rep looks
   * first — asked for by the client. With the composer above, an oldest-first
   * thread would put the message being answered at the very bottom, as far
   * from the reply box as it can get; an earlier version did exactly that and
   * read backwards. So the newest message is the one right under the box,
   * like an inbox. `messages` itself stays oldest-first: `replyTarget()`
   * reads its last element.
   */
  const newestFirst = [...messages].reverse();
  const history =
    messages.length > 0 ? (
        <ul className="space-y-2">
          {newestFirst.map((m) => (
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
                <TelephonyDelete kind="sms" id={m.id} moduleSlug={moduleSlug} />
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
    ) : null;

  return (
    <div className="space-y-3">

      {target ? (
        <div className="rounded-xl border border-line bg-white p-3">
          <label htmlFor="sms-body" className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
            Text {formatPhoneDisplay(target)}
          </label>

          {/*
            Which person, when the record names more than one. Picking the
            first silently would trade "cannot text this merchant" for
            "texted their business to the wrong contact", which is worse.
          */}
          {!toE164 && recordPhones.length > 1 ? (
            <select
              aria-label="Who to text"
              value={target}
              onChange={(e) => setChosen(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[13px] text-ink-900 focus-field"
            >
              {recordPhones.map((n) => (
                <option key={n.e164} value={n.e164}>
                  {n.who} · {formatPhoneDisplay(n.e164)} ({n.source})
                </option>
              ))}
            </select>
          ) : null}

          {/*
            ── CONSENT, WHERE THE TEXT IS ACTUALLY WRITTEN ──────────────────
            This badge already existed, but only on the standalone /phone
            page. Almost nobody composes a text there: a text is written from
            the record, which is this box — so the one warning that matters
            was shown in the one place it was least likely to be read, and
            `sms_consents` has stood at zero rows since the table was created.
            Carrier approval rests on being able to show WHEN each person
            agreed, so a prompt nobody passes is the same as no prompt.

            It warns and does not block, deliberately: a rep looking at signed
            paperwork the CRM has not caught up with should not be stopped,
            because the fastest way past a block is to record a consent that
            never happened — fiction in the one record that exists to be
            evidence. See ConsentBadge for the full reasoning.
          */}
          <div className="mt-2">
            {/* `target`, not `toE164`: on a record with no thread yet the
                reply target is null, and passing it here would hide the
                consent warning at exactly the moment it matters most — the
                first message sent to someone who never wrote first. */}
            <ConsentBadge e164={target} />
          </div>
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
          {/*
            ⚠ THIS USED TO OPEN "No phone number on this record yet".
            On a record carrying an Affiliate main phone and a Fax number —
            both visible two tabs away — that is untrue, and it sent people
            looking for a number they had already entered. The reason those
            two cannot be texted is that neither is sync-enabled, so a reply
            would arrive attached to no record at all. Worth saying, and a
            different sentence from "there is no number".
          */}
          No number on this record can be texted. A text can only go to a phone field with{' '}
          <strong>sync</strong> switched on — a contact&rsquo;s or an owner&rsquo;s — because that
          is what an incoming reply is matched against. Fax and Affiliate main phone are not
          sync-enabled, so a reply to either would arrive attached to nothing.
        </SpecNote>
      )}

      {history}
    </div>
  );
}
