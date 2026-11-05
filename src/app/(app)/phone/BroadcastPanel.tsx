'use client';

/**
 * Sending a broadcast takes two steps on purpose. A text cannot be taken back, and
 * who actually receives it depends on consent the sender cannot see while choosing,
 * so they read the real numbers before anything goes out.
 */
import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, StatusPill } from '@/proto/ui/kit';
import { formatDateTime } from '@/proto/ui/tokens';
import type { BroadcastLine, BroadcastPreview, BroadcastView } from '@/lib/phone/broadcasts';
import type { Contact } from '@/lib/phone/contacts';
import { MAX_BROADCAST_RECIPIENTS, splitNumbers, STOP_LINE } from '@/lib/phone/bulkRules';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import { MAX_BODY_LENGTH, segmentInfo } from '@/lib/phone/segments';
import { broadcastProblemsAction, previewBroadcastAction, sendBroadcastAction, stopBroadcastAction } from './bulkActions';
import { contactRows, RecipientPicker } from './RecipientPicker';

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function BroadcastPanel({
  allowed,
  myNumber,
  contacts,
  broadcasts,
}: {
  allowed: boolean;
  myNumber: string | null;
  contacts: Contact[];
  broadcasts: BroadcastView[];
}) {
  const rows = useMemo(() => contactRows(contacts), [contacts]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [pasted, setPasted] = useState('');
  const [message, setMessage] = useState('');
  const [addStop, setAddStop] = useState(true);
  const [preview, setPreview] = useState<BroadcastPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();

  const typed = useMemo(() => splitNumbers(pasted), [pasted]);
  const numbers = useMemo(() => [...picked, ...typed], [picked, typed]);
  const text = useMemo(() => {
    const clean = message.trim();
    if (!clean) return '';
    return addStop && !/\bstop\b/i.test(clean) ? `${clean} ${STOP_LINE}` : clean;
  }, [message, addStop]);
  const seg = useMemo(() => segmentInfo(text), [text]);

  // Any change makes the counts on screen wrong, so they go until asked for again.
  const edited = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPreview(null);
    setError(null);
    setDone(null);
  };

  const review = () =>
    start(async () => {
      setError(null);
      const result = await previewBroadcastAction({ numbers });
      if (result.ok) setPreview(result.preview);
      else setError(result.message);
    });

  const send = () =>
    start(async () => {
      setError(null);
      const result = await sendBroadcastAction({ numbers, body: text });
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setDone(`Sending to ${plural(result.willReceive, 'person', 'people')}. Texts go out one at a time, so a long list takes a few minutes. Press Refresh to follow it.`);
      setPicked(new Set());
      setPasted('');
      setMessage('');
      setPreview(null);
      router.refresh();
    });

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
      {allowed ? (
        <div className="min-w-0 space-y-3">
          {!myNumber ? <Note>You have no phone number assigned, so you cannot send yet. Ask an administrator.</Note> : null}

          <RecipientPicker
            rows={rows}
            picked={picked}
            onChange={edited(setPicked)}
            disabled={pending}
            pasted={pasted}
            onPaste={edited(setPasted)}
            pasteLabel="Or paste numbers"
            pastePlaceholder="One per line, or separated by commas"
          />

          <div>
            <div className="flex items-baseline justify-between gap-2">
              <label htmlFor="broadcast-body" className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
                Message
              </label>
              <span className={`text-[11.5px] tabular ${seg.segments > 1 ? 'font-medium text-[#8a5a09]' : 'text-ink-400'}`}>
                {seg.units}/{seg.perSegment}
                {seg.segments > 1 ? ` · ${seg.segments} texts each` : ''}
                {seg.encoding === 'ucs2' && seg.units > 0 ? ' · unicode' : ''}
              </span>
            </div>
            <textarea
              id="broadcast-body"
              value={message}
              onChange={(e) => edited(setMessage)(e.target.value)}
              rows={3}
              maxLength={MAX_BODY_LENGTH - STOP_LINE.length - 1}
              disabled={pending}
              placeholder="Type your message. Say who it is from."
              className="mt-1 w-full resize-y rounded-lg border border-line bg-white px-2.5 py-2 text-[13px] text-ink-900 outline-none focus-field"
            />
            <label className="mt-1 flex items-center gap-2 text-[12px] text-ink-500">
              <input
                type="checkbox"
                checked={addStop}
                disabled={pending}
                onChange={(e) => edited(setAddStop)(e.target.checked)}
                className="size-3.5 accent-brand-600"
              />
              End with “{STOP_LINE}”
            </label>
          </div>

          {preview ? <Review preview={preview} /> : null}
          {error ? <Problem>{error}</Problem> : null}
          {done ? (
            <p role="status" className="flex items-start gap-1.5 text-[12px] text-ok">
              <Icon name="check" size={12} strokeWidth={2.5} className="mt-[2px] shrink-0" />
              {done}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] text-ink-500">
              {numbers.length > 0 ? plural(numbers.length, 'number') : `Up to ${MAX_BROADCAST_RECIPIENTS} numbers`}
            </span>
            {preview ? (
              <div className="flex gap-2">
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setPreview(null)}>
                  Back
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  icon="send"
                  disabled={pending || preview.willReceive === 0 || preview.overLimit || !myNumber}
                  onClick={send}
                >
                  {pending ? 'Sending…' : `Send to ${plural(preview.willReceive, 'person', 'people')}`}
                </Button>
              </div>
            ) : (
              <Button size="sm" disabled={pending || numbers.length === 0 || !text} onClick={review}>
                {pending ? 'Checking…' : 'Review recipients'}
              </Button>
            )}
          </div>
        </div>
      ) : null}

      <div className={`min-w-0 ${allowed ? '' : 'lg:col-span-2'}`}>
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">Recent broadcasts</h3>
          <Button size="sm" variant="ghost" icon="refresh-cw" onClick={() => router.refresh()}>
            Refresh
          </Button>
        </div>
        {broadcasts.length === 0 ? (
          <p className="mt-2 rounded-lg border border-dashed border-line px-3 py-4 text-center text-[12.5px] text-ink-500">Nothing sent yet.</p>
        ) : (
          <ul className="mt-2 max-h-[460px] space-y-2 overflow-y-auto pr-1">
            {broadcasts.map((b) => (
              <BroadcastRow key={b.id} broadcast={b} canStop={allowed} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-line bg-canvas/40 px-3 py-2 text-[12.5px] text-ink-600">{children}</p>;
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="flex items-start gap-1.5 text-[12px] text-danger">
      <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
      <span>{children}</span>
    </p>
  );
}

function Review({ preview }: { preview: BroadcastPreview }) {
  const skipped = preview.optedOut + preview.noConsent;
  return (
    <div data-broadcast-review className="rounded-lg border border-line bg-canvas/40 px-3 py-2.5 text-[12.5px] text-ink-700">
      <p className="font-semibold text-ink-900">{plural(preview.willReceive, 'person', 'people')} will receive this.</p>
      {skipped > 0 || preview.duplicates > 0 || preview.invalid.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4">
          {preview.noConsent > 0 ? <li>{plural(preview.noConsent, 'number')} skipped: no texting consent on file.</li> : null}
          {preview.optedOut > 0 ? <li>{plural(preview.optedOut, 'number')} skipped: replied STOP.</li> : null}
          {preview.duplicates > 0 ? <li>{plural(preview.duplicates, 'duplicate')} removed.</li> : null}
          {preview.invalid.length > 0 ? <li>Not phone numbers, ignored: {preview.invalid.join(', ')}</li> : null}
        </ul>
      ) : null}
      {preview.overLimit ? <p className="mt-1 font-medium text-danger">That is over the limit of {MAX_BROADCAST_RECIPIENTS} numbers. Remove some first.</p> : null}
      {preview.willReceive === 0 && !preview.overLimit ? <p className="mt-1 font-medium text-danger">Nobody on this list can receive a broadcast.</p> : null}
    </div>
  );
}

const STATUS_PILL: Record<BroadcastView['status'], { label: string; swatch: 'blue' | 'teal' | 'amber' }> = {
  sending: { label: 'Sending', swatch: 'blue' },
  finished: { label: 'Finished', swatch: 'teal' },
  stopped: { label: 'Stopped', swatch: 'amber' },
};

const LINE_STATUS: Record<string, string> = {
  failed: 'Failed',
  skipped_opted_out: 'Replied STOP',
  skipped_no_consent: 'No consent on file',
  cancelled: 'Stopped before sending',
};

function BroadcastRow({ broadcast: b, canStop }: { broadcast: BroadcastView; canStop: boolean }) {
  const [lines, setLines] = useState<BroadcastLine[] | null>(null);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const c = b.counts;
  const notReached = c.failed + c.skipped + c.cancelled;

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || lines) return;
    start(async () => {
      const result = await broadcastProblemsAction({ broadcastId: b.id });
      if (result.ok) setLines(result.lines);
      else setError(result.message);
    });
  };

  const stop = () =>
    start(async () => {
      const result = await stopBroadcastAction({ broadcastId: b.id });
      setConfirming(false);
      if (!result.ok) setError(result.message);
      else router.refresh();
    });

  return (
    <li className="rounded-xl border border-line-soft px-3 py-2.5" data-broadcast-row>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusPill label={STATUS_PILL[b.status].label} swatch={STATUS_PILL[b.status].swatch} dot={false} />
        <span className="text-[11px] tabular text-ink-400">{formatDateTime(b.createdAt)}</span>
        {!b.mine ? <span className="text-[11px] text-ink-400">from {formatPhoneDisplay(b.fromE164)}</span> : null}
      </div>
      <p className="mt-1.5 line-clamp-2 whitespace-pre-wrap text-[12.5px] text-ink-800">{b.body}</p>
      <p className="mt-1.5 text-[12px] tabular text-ink-500">
        {c.sent.toLocaleString()} sent
        {c.waiting > 0 ? ` · ${c.waiting.toLocaleString()} waiting` : ''}
        {c.failed > 0 ? ` · ${c.failed.toLocaleString()} failed` : ''}
        {c.skipped > 0 ? ` · ${c.skipped.toLocaleString()} skipped` : ''}
        {c.cancelled > 0 ? ` · ${c.cancelled.toLocaleString()} stopped` : ''}
      </p>

      {notReached > 0 || (canStop && b.mine && b.status === 'sending') ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-3">
          {notReached > 0 ? (
            <button type="button" onClick={toggle} aria-expanded={open} className="text-[12px] font-medium text-brand-700 hover:underline">
              {open ? 'Hide' : 'Show'} who did not get it
            </button>
          ) : null}
          {canStop && b.mine && b.status === 'sending' ? (
            confirming ? (
              <span className="flex items-center gap-2 text-[12px] text-ink-600">
                Stop the texts not sent yet?
                <Button size="sm" variant="danger" disabled={pending} onClick={stop}>
                  Stop
                </Button>
                <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirming(false)}>
                  Keep sending
                </Button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className="text-[12px] font-medium text-danger hover:underline">
                Stop sending
              </button>
            )
          ) : null}
        </div>
      ) : null}

      {error ? <div className="mt-1.5"><Problem>{error}</Problem></div> : null}

      {open && lines ? (
        <ul className="mt-2 max-h-[160px] space-y-1 overflow-y-auto border-t border-line-faint pt-2 text-[12px]">
          {lines.map((l) => (
            <li key={l.e164} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
              <span className="tabular text-ink-800">{formatPhoneDisplay(l.e164)}</span>
              <span className="text-ink-500">{l.error ?? LINE_STATUS[l.status] ?? l.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
