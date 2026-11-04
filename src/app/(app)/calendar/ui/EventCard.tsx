'use client';

/** The detail card: title, time, organizer, attendees, description, Join and what this person may do. */
import { useEffect, useState } from 'react';
import { Button, Dialog, Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import type { CalEvent, CalendarEntry, EventDetail, SeriesScope } from '@/lib/msteams/types';
import { answerEventAction, cancelEventAction, eventDetailAction } from '../actions';
import { formatWhen } from './dates';
import type { FormSeed } from './EventForm';
import { ScopeDialog } from './ScopeDialog';

const RESPONSE_LABEL: Record<string, string> = { accepted: 'Accepted', tentativelyAccepted: 'Tentative', declined: 'Declined', notResponded: 'Not answered', none: 'Not answered', organizer: 'Organizer' };
const timeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

type Answer = 'accepted' | 'tentativelyAccepted' | 'declined';

export function EventCard({ event, calendars, canChange, onClose, onEdit, onChanged }: { event: CalEvent; calendars: CalendarEntry[]; canChange: boolean; onClose: () => void; onEdit: (seed: FormSeed) => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [response, setResponse] = useState(event.response);
  const [asking, setAsking] = useState(false);

  const calendar = calendars.find((c) => c.key === event.calendarKey);
  const recurring = event.type !== 'singleInstance';

  useEffect(() => {
    if (event.isPrivate) return;
    let live = true;
    void eventDetailAction({ identityId: event.identityId, eventId: event.id, address: calendar?.address ?? null }).then((r) => {
      if (live) setDetail(r.ok ? r.data : { bodyHtml: '', recurrence: null });
    });
    return () => {
      live = false;
    };
  }, [calendar?.address, event.id, event.identityId, event.isPrivate]);

  const answer = async (a: Answer) => {
    setBusy(a);
    setError(null);
    const r = await answerEventAction({ identityId: event.identityId, eventId: event.id, answer: a });
    setBusy(null);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    setResponse(a);
    onChanged();
  };

  const cancel = async (scope: SeriesScope) => {
    setAsking(false);
    setBusy('cancel');
    setError(null);
    const r = await cancelEventAction({ identityId: event.identityId, eventId: event.id, scope, timeZone: timeZone() });
    setBusy(null);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    onChanged();
    onClose();
  };

  const edit = () =>
    onEdit({
      mode: 'edit',
      eventId: event.id,
      identityId: event.identityId,
      calendarKey: event.calendarKey,
      recurring,
      subject: event.subject,
      start: event.start,
      end: event.end,
      allDay: event.allDay,
      teamsLink: Boolean(event.joinUrl),
      location: event.location,
      attendees: event.attendees.filter((a) => a.email).map((a) => ({ email: a.email, name: a.name })),
      bodyHtml: detail?.bodyHtml ?? '',
      recurrence: detail?.recurrence ?? { kind: 'none' },
    });

  const canEdit = canChange && event.isOrganizer && !event.readOnly;
  const canAnswer = canChange && !event.isOrganizer && !event.readOnly && !event.isPrivate;

  return (
    <>
      <Dialog title={event.subject} onClose={onClose} width={520}>
        <div className="space-y-3 text-[13px] text-ink-700">
          <p className="flex items-start gap-2">
            <Icon name="clock" size={14} className="mt-0.5 shrink-0 text-ink-400" />
            <span>{formatWhen(event)}</span>
          </p>
          {calendar ? (
            <p className="flex items-center gap-2">
              <span aria-hidden className="ml-[3px] size-2 shrink-0 rounded-full" style={{ background: calendar.color }} />
              <span className="pl-[3px]">
                {calendar.name}
                {calendars.some((c) => c.identityId !== calendar.identityId) ? <span className="text-ink-400"> · {calendar.accountEmail}</span> : null}
              </span>
            </p>
          ) : null}

          {event.isPrivate ? (
            <p className="flex items-center gap-2 text-ink-500">
              <Icon name="lock" size={14} className="text-ink-400" /> This event is private.
            </p>
          ) : (
            <>
              {event.location ? (
                <p className="flex items-start gap-2">
                  <Icon name="flag" size={14} className="mt-0.5 shrink-0 text-ink-400" />
                  <span>{event.location}</span>
                </p>
              ) : null}
              {event.organizer ? (
                <p className="flex items-start gap-2">
                  <Icon name="user" size={14} className="mt-0.5 shrink-0 text-ink-400" />
                  <span>
                    <span className="font-medium text-ink-800">{event.organizer}</span> <span className="text-ink-400">Organizer</span>
                  </span>
                </p>
              ) : null}
              {event.attendees.length ? (
                <div className="flex items-start gap-2">
                  <Icon name="users" size={14} className="mt-0.5 shrink-0 text-ink-400" />
                  <ul className="min-w-0 flex-1 space-y-0.5">
                    {event.attendees.map((a) => (
                      <li key={a.email || a.name} className="flex gap-2">
                        <span className="min-w-0 flex-1 truncate">{a.name || a.email}</span>
                        <span className="shrink-0 text-[11.5px] text-ink-400">{RESPONSE_LABEL[a.response] ?? ''}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {event.joinUrl ? (
                <a href={event.joinUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-md bg-brand-900 px-3 py-1.5 text-[13px] font-semibold text-white hover:bg-brand-800">
                  <Icon name="video" size={14} /> Join
                </a>
              ) : null}
              {detail === null ? (
                <p className="flex items-center gap-2 text-[12px] text-ink-400">
                  <Spinner className="size-3" /> Loading the description…
                </p>
              ) : detail.bodyHtml ? (
                // The email sanitizer's output, framed: an invitation's body is someone else's HTML.
                <iframe title="Description" sandbox="" srcDoc={detail.bodyHtml} className="h-[200px] w-full rounded-md border border-line-faint bg-white" />
              ) : null}
            </>
          )}

          {error ? <p className="text-[12.5px] font-medium text-[#b02a30]">{error}</p> : null}

          {canAnswer ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line-faint pt-3">
              <span className="mr-1 text-[12px] font-semibold text-ink-500">{RESPONSE_LABEL[response] ?? 'Your answer'}</span>
              <Button size="sm" variant={response === 'accepted' ? 'primary' : 'secondary'} icon="check" loading={busy === 'accepted'} onClick={() => void answer('accepted')}>
                Accept
              </Button>
              <Button size="sm" variant={response === 'tentativelyAccepted' ? 'primary' : 'secondary'} loading={busy === 'tentativelyAccepted'} onClick={() => void answer('tentativelyAccepted')}>
                Tentative
              </Button>
              <Button size="sm" variant={response === 'declined' ? 'primary' : 'secondary'} icon="x" loading={busy === 'declined'} onClick={() => void answer('declined')}>
                Decline
              </Button>
            </div>
          ) : null}

          {canEdit ? (
            <div className="flex flex-wrap items-center gap-2 border-t border-line-faint pt-3">
              <Button size="sm" variant="secondary" icon="pencil" disabled={detail === null} onClick={edit}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="danger"
                loading={busy === 'cancel'}
                onClick={() => {
                  if (recurring) setAsking(true);
                  else void cancel('this');
                }}
              >
                Cancel event
              </Button>
            </div>
          ) : null}
        </div>
      </Dialog>
      {asking ? <ScopeDialog verb="Cancel" tone="danger" onPick={(s) => void cancel(s)} onCancel={() => setAsking(false)} /> : null}
    </>
  );
}
