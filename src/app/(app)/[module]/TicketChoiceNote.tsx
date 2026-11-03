'use client';

/**
 * "Which ticket is this email about?" — the note in Vital Info (Ticket
 * Automation Flow Builder spec, "Choosing a ticket for an email").
 *
 * An Email received flow that acts on one ticket waits here when the record has
 * more than one open. Only the people the database asks see it: the users
 * assigned to the record's open tickets, or everyone who can open the record in
 * Tickets when nobody is. One click picks the ticket and the note goes; after 24
 * hours it goes by itself and the flow doesn't run for that email.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import type { TicketChoice } from '@/lib/records/cases';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { chooseTicketAction } from './actions';

function timeLeft(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((new Date(iso).getTime() - now) / 60_000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
}

export function TicketChoiceNote({ moduleSlug, choices }: { moduleSlug: string; choices: TicketChoice[] }) {
  const router = useRouter();
  const [now] = useState(() => Date.now());
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = (choiceId: string, caseId: string) => {
    setBusy(`${choiceId}:${caseId}`);
    start(async () => {
      setError(null);
      const r = await chooseTicketAction(moduleSlug, { choiceId, caseId });
      setBusy(null);
      if (!r.ok) setError(r.message ?? 'Could not choose the ticket.');
      else router.refresh();
    });
  };

  return (
    <div className="mb-3 space-y-2">
      {choices.map((ch) => (
        <div key={ch.id} role="group" aria-label="Choose the ticket for an email" className="rounded-xl border border-[#f2d49b] bg-[#fffaf0] px-3.5 py-3">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-[#fdf3dd] text-[#8a5a09]">
              <Icon name="mail" size={14} strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-ink-900">Which ticket is this email about?</p>
              <p className="mt-0.5 text-[12.5px] leading-snug text-ink-600">
                <span className="font-medium text-ink-800">{ch.sender ?? 'The client'}</span> wrote
                {ch.subject ? <> &ldquo;<span className="text-ink-800">{ch.subject}</span>&rdquo;</> : ' an email'}. &ldquo;{ch.automationName}&rdquo; waits
                for the ticket before it runs.
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {ch.tickets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    disabled={pending}
                    onClick={() => choose(ch.id, t.id)}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-lg border border-line bg-white px-2.5 py-1.5 text-left text-[12.5px] text-ink-800 shadow-[0_1px_1px_rgba(8,32,47,.04)] transition-colors hover:border-brand-400 hover:bg-brand-50 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <span className="font-mono text-[11.5px] font-semibold text-ink-500">#{t.number}</span>
                    <span className="truncate font-medium">{t.title}</span>
                    {busy === `${ch.id}:${t.id}` ? <Spinner className="text-[12px] text-ink-400" /> : null}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[11.5px] text-ink-400">If nobody chooses within {timeLeft(ch.expiresAt, now)}, the flow won&rsquo;t run for this email.</p>
            </div>
          </div>
        </div>
      ))}
      {error ? (
        <p role="alert" className="text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
