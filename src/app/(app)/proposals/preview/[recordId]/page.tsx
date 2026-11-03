/**
 * /proposals/preview/<recordId> — "User should be able to preview prior to
 * sending it out" (client, 3 Nov 2026): the merchant's page exactly as it
 * would go now, with what is missing listed above it.
 */
import Link from 'next/link';
import { authorize } from '@/lib/records/permissions';
import { ProposalError, previewProposal, recordHrefFor } from '@/lib/proposals/service';
import { ProposalDocument } from '@/app/proposal/ProposalDocument';
import { APPROVE_BUTTON } from '@/app/proposal/approveButton';
import { ProposalToolbar } from '../../ProposalToolbar';

export const dynamic = 'force-dynamic';

export default async function ProposalPreviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ recordId: string }>;
  searchParams: Promise<{ module?: string }>;
}) {
  const { recordId } = await params;
  const { module } = await searchParams;
  const ctx = await authorize();
  const slug = typeof module === 'string' && /^[a-z0-9-]{1,64}$/.test(module) ? module : null;
  let data: Awaited<ReturnType<typeof previewProposal>> | null = null;
  if (/^[0-9a-f-]{36}$/i.test(recordId)) {
    try {
      data = await previewProposal(ctx, recordId, slug);
    } catch (e) {
      if (!(e instanceof ProposalError) && !(e instanceof Error && /No (edit )?access/.test(e.message))) throw e;
    }
  }
  if (!data) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-[420px] rounded-2xl border border-line bg-white p-8 text-center">
          <h1 className="text-[17px] font-semibold text-ink-900">This preview is not available</h1>
          <p className="mt-1.5 text-[13.5px] text-ink-500">The record may have been removed, or you cannot send proposals on it.</p>
          <Link href="/" className="mt-5 inline-block text-[13px] font-semibold text-brand-700 hover:underline">
            Back to the CRM
          </Link>
        </div>
      </main>
    );
  }
  const back = slug ? `/${slug}?record=${recordId}` : await recordHrefFor(ctx, recordId);
  return (
    <div>
      <ProposalToolbar
        title="Proposal preview"
        detail={<>What {data.content.merchantName} will see if you send it now. Nothing has been sent.</>}
        backHref={back}
        notes={data.notes}
      />
      <ProposalDocument
        content={data.content}
        label="PRO-preview"
        closingAction={
          <div>
            <span aria-disabled className={`${APPROVE_BUTTON} pointer-events-none`}>
              Click here to approve proposal
            </span>
            <p className="mt-3 text-[12.5px] text-white/60">The merchant approves here. In this preview the button does nothing.</p>
          </div>
        }
      />
    </div>
  );
}
