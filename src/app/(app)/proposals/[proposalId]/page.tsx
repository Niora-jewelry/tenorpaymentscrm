/**
 * /proposals/<id> — one sent proposal, exactly as the merchant has it (the
 * content frozen at send), with its status.
 */
import Link from 'next/link';
import { authorize } from '@/lib/records/permissions';
import { recordHrefFor, sentProposal } from '@/lib/proposals/service';
import { ProposalDocument } from '@/app/proposal/ProposalDocument';
import { APPROVE_BUTTON } from '@/app/proposal/approveButton';
import { Approved } from '@/app/proposal/[token]/ApproveButton';
import { StatusPill } from '@/proto/ui/kit';
import { PROPOSAL_STATUS } from '../status';
import { ProposalToolbar } from '../ProposalToolbar';

export const dynamic = 'force-dynamic';

const date = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

export default async function SentProposalPage({ params }: { params: Promise<{ proposalId: string }> }) {
  const { proposalId } = await params;
  const ctx = await authorize();
  const data = /^[0-9a-f-]{36}$/i.test(proposalId) ? await sentProposal(ctx, proposalId) : null;
  if (!data) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-[420px] rounded-2xl border border-line bg-white p-8 text-center">
          <h1 className="text-[17px] font-semibold text-ink-900">This proposal is not available</h1>
          <p className="mt-1.5 text-[13.5px] text-ink-500">It may have been removed, or it belongs to a record you cannot open.</p>
          <Link href="/" className="mt-5 inline-block text-[13px] font-semibold text-brand-700 hover:underline">
            Back to the CRM
          </Link>
        </div>
      </main>
    );
  }
  const { view } = data;
  const s = PROPOSAL_STATUS[view.status];
  return (
    <div>
      <ProposalToolbar
        title={view.label}
        detail={
          <>
            Sent to {view.recipient} on {date(view.sentAt)}
            {view.sentByName ? ` by ${view.sentByName}` : ''} · the merchant sees exactly this page.
          </>
        }
        backHref={await recordHrefFor(ctx, data.recordId)}
        right={<StatusPill label={s.label} swatch={s.swatch} />}
      />
      <ProposalDocument
        content={data.content}
        label={view.label}
        closingAction={
          view.status === 'approved' && view.approvedAt ? (
            <Approved at={view.approvedAt} />
          ) : (
            <div>
              <span aria-disabled className={`${APPROVE_BUTTON} pointer-events-none opacity-60`}>
                Click here to approve proposal
              </span>
              <p className="mt-3 text-[12.5px] text-white/60">
                {view.status === 'voided'
                  ? 'Voided — the merchant’s link no longer works.'
                  : view.status === 'expired'
                    ? 'Expired — the merchant can no longer approve it.'
                    : 'Waiting for the merchant’s approval.'}
              </p>
            </div>
          )
        }
      />
    </div>
  );
}
