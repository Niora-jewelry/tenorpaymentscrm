'use client';

/**
 * "Click here to approve proposal" (client, 3 Nov 2026). One click, then a
 * confirmation in place; the CRM records the approval and tells the team.
 */
import { useState, useTransition } from 'react';
import { APPROVE_BUTTON } from '../approveButton';
import { approveProposalAction } from './actions';

const when = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

export function ApproveButton({ token, approvedAt }: { token: string; approvedAt: string | null }) {
  const [done, setDone] = useState<string | null>(approvedAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (done) return <Approved at={done} />;
  return (
    <div>
      <button
        type="button"
        className={APPROVE_BUTTON}
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await approveProposalAction(token);
            if (r.ok) setDone(r.approvedAt);
            else setError(r.message);
          })
        }
      >
        {pending ? 'Recording your approval…' : 'Click here to approve proposal'}
      </button>
      {error ? (
        <p role="alert" className="mt-3 text-[13px] font-bold text-[#ffb4a8]">
          {error}
        </p>
      ) : (
        <p className="mt-3 text-[12.5px] text-white/60">Your approval is sent to your Tenor relationship manager straight away.</p>
      )}
    </div>
  );
}

export function Approved({ at }: { at: string }) {
  return (
    <div role="status" className="inline-flex items-start gap-3 rounded-xl bg-white/[.08] px-4 py-3.5 ring-1 ring-[#c8f169]/50">
      <svg viewBox="0 0 20 20" aria-hidden className="mt-[1px] size-5 shrink-0 text-[#c8f169]">
        <circle cx="10" cy="10" r="9" fill="currentColor" />
        <path d="M6 10.4l2.6 2.6L14 7.6" fill="none" stroke="#102347" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <div>
        <p className="text-[14.5px] font-black text-white">Proposal approved</p>
        <p className="mt-0.5 text-[13px] text-white/75">Approved on {when(at)}. Thank you — we will be in touch shortly with the next steps.</p>
      </div>
    </div>
  );
}
