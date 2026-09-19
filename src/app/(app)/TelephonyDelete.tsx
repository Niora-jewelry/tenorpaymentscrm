'use client';

/**
 * Remove one call, recording or text.
 *
 * ── ONE COMPONENT, BECAUSE THE SAME ROW APPEARS TWICE ────────────────────
 * A call is listed in the record drawer AND on the standalone Phone page. Two
 * delete buttons would be two chances for the wording, the confirmation and
 * the error handling to drift apart.
 *
 * ── IT ASKS FIRST, AND IT ASKS IN PLACE ──────────────────────────────────
 * Deleting is not undoable from the UI (the row is soft-deleted, so an admin
 * can recover it in the database, but nothing in the app offers that). A
 * `window.confirm` would do the job and reads as a browser error; this swaps
 * the button for an inline "Delete? / Cancel" pair, which keeps the question
 * next to the thing being deleted.
 *
 * ── THE SERVER'S REFUSAL IS SHOWN VERBATIM ───────────────────────────────
 * The delete actions RETURN their refusal rather than throwing, because Next
 * masks a thrown Server Action message in production and the user would get a
 * blank. Whatever the database said — "Only the person on the call…" — is what
 * appears here.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import {
  deleteCallAction,
  deleteRecordingAction,
  deleteSmsAction,
} from './phoneActions';

type Kind = 'call' | 'recording' | 'sms';

const ACTION = {
  call: deleteCallAction,
  recording: deleteRecordingAction,
  sms: deleteSmsAction,
} as const;

const NOUN: Record<Kind, string> = {
  call: 'call',
  recording: 'recording',
  sms: 'message',
};

export function TelephonyDelete({
  kind,
  id,
  moduleSlug,
  className = '',
}: {
  kind: Kind;
  id: string;
  /** Present in a record drawer, absent on the Phone page — it decides which
   *  path is revalidated besides `/phone`. */
  moduleSlug?: string;
  className?: string;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (error) {
    return (
      <span className={`inline-flex items-center gap-1.5 text-[11.5px] text-danger ${className}`}>
        <Icon name="alert-triangle" size={11} />
        {error}
        <button
          type="button"
          onClick={() => setError(null)}
          className="font-semibold underline underline-offset-2 hover:no-underline"
        >
          Dismiss
        </button>
      </span>
    );
  }

  if (asking) {
    return (
      <span className={`inline-flex items-center gap-2 text-[11.5px] ${className}`}>
        <span className="text-ink-500">Delete this {NOUN[kind]}?</span>
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await ACTION[kind](id, moduleSlug);
              if (!result.ok) {
                setError(result.message);
                setAsking(false);
              }
              // On success the row disappears with the revalidation; there is
              // nothing to reset because this component goes with it.
            })
          }
          className="font-semibold text-danger underline underline-offset-2 hover:no-underline disabled:opacity-50"
        >
          {pending ? 'Deleting…' : 'Delete'}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => setAsking(false)}
          className="text-ink-500 underline underline-offset-2 hover:no-underline"
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setAsking(true)}
      title={`Delete this ${NOUN[kind]}`}
      aria-label={`Delete this ${NOUN[kind]}`}
      className={`inline-flex size-6 items-center justify-center rounded-md text-ink-400 transition-colors hover:bg-danger-bg hover:text-danger ${className}`}
    >
      <Icon name="trash" size={12} />
    </button>
  );
}
