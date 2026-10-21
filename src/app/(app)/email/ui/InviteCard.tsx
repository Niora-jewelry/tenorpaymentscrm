'use client';

/**
 * A meeting invitation, above the message body: when, where, who invited,
 * how you've answered — and Accept / Tentative / Decline, sent from Outlook
 * so the organiser gets the reply and the calendar updates.
 */
import { useEffect, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { inviteAction, respondInviteAction, type InviteResponse, type InviteView } from '../inviteActions';

const ANSWER: Record<InviteResponse, { label: string; tone: string } | null> = {
  accepted: { label: 'You accepted', tone: 'bg-[#e3f6e8] text-[#1a7a3c]' },
  tentativelyAccepted: { label: 'You said maybe', tone: 'bg-[#fdf6e7] text-[#8a5a00]' },
  declined: { label: 'You declined', tone: 'bg-[#fce9ea] text-[#b02a30]' },
  organizer: { label: 'You organised this', tone: 'bg-brand-50 text-brand-800' },
  none: null,
  notResponded: null,
};

function when(v: Extract<InviteView, { state: 'ok' }>): string {
  if (!v.start) return 'Time not given';
  const s = new Date(v.start);
  const e = v.end ? new Date(v.end) : null;
  const day = s.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: s.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  if (v.allDay) return `${day} · all day`;
  const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  const sameDay = e && e.toDateString() === s.toDateString();
  return e ? `${day} · ${t(s)} – ${sameDay ? t(e) : `${e.toLocaleDateString()} ${t(e)}`}` : `${day} · ${t(s)}`;
}

export function InviteCard({ messageId, kind }: { messageId: string; kind: string }) {
  const [view, setView] = useState<InviteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void inviteAction({ messageId }).then((r) => {
      if (!live) return;
      if (r.ok) setView(r.data);
      else setError(r.message);
    });
    return () => {
      live = false;
    };
  }, [messageId]);

  const isRequest = kind === 'meetingRequest';
  const shell = 'mb-4 overflow-hidden rounded-xl border border-line bg-white';

  if (!view && !error) {
    return (
      <div className={`${shell} flex items-center gap-2 px-4 py-3 text-[12.5px] text-ink-400`}>
        <Spinner /> Reading the meeting from Outlook…
      </div>
    );
  }
  if (!view || view.state === 'unavailable') {
    return (
      <div className={`${shell} flex items-center gap-2.5 px-4 py-3 text-[12.5px] text-ink-500`}>
        <Icon name="calendar" size={15} className="shrink-0 text-ink-400" />
        {error ?? `This meeting ${isRequest ? 'invitation' : 'update'} isn’t in the calendar here. Open it in Outlook to see it or respond.`}
      </div>
    );
  }

  const answered = ANSWER[view.response];
  const respond = async (r: 'accept' | 'tentative' | 'decline') => {
    setSending(r);
    setError(null);
    const res = await respondInviteAction({ messageId, response: r });
    setSending(null);
    if (res.ok) setView({ ...view, response: res.data });
    else setError(res.message);
  };

  return (
    <div className={shell}>
      <div className="flex items-start gap-3 px-4 py-3">
        <span className={`grid size-9 shrink-0 place-items-center rounded-lg ${view.cancelled ? 'bg-[#fce9ea] text-[#b02a30]' : 'bg-brand-50 text-brand-700'}`}>
          <Icon name="calendar" size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className={`text-[13.5px] font-semibold ${view.cancelled ? 'text-[#b02a30]' : 'text-ink-900'}`}>
            {view.cancelled ? 'This meeting was cancelled' : when(view)}
          </p>
          <p className="mt-0.5 truncate text-[12.5px] text-ink-500">
            {[view.cancelled ? when(view) : null, view.location, view.organizer ? `Organiser: ${view.organizer}` : null].filter(Boolean).join(' · ') || 'No location given'}
          </p>
        </div>
        {answered ? <span className={`shrink-0 rounded-md px-2 py-0.5 text-[11.5px] font-semibold ${answered.tone}`}>{answered.label}</span> : null}
      </div>
      {view.canRespond && isRequest ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-line-faint bg-canvas/60 px-4 py-2">
          {(
            [
              ['accept', 'Accept', 'check', 'accepted'],
              ['tentative', 'Tentative', 'circle-dot', 'tentativelyAccepted'],
              ['decline', 'Decline', 'x', 'declined'],
            ] as const
          ).map(([r, label, icon, state]) => (
            <button
              key={r}
              type="button"
              disabled={sending !== null}
              aria-pressed={view.response === state}
              onClick={() => void respond(r)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-semibold transition-colors disabled:opacity-60 ${
                view.response === state ? 'border-ink-900 bg-ink-900 text-white' : 'border-line bg-white text-ink-700 hover:border-ink-400'
              }`}
            >
              {sending === r ? <Spinner /> : <Icon name={icon} size={13} />}
              {label}
            </button>
          ))}
          <span className="ml-1 text-[11.5px] text-ink-400">The organiser gets your answer.</span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="border-t border-[#f7cfd1] bg-[#fce9ea] px-4 py-2 text-[12.5px] text-[#b02a30]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
