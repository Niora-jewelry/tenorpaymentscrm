/**
 * /applications/preview/<recordId> — the online application as the merchant
 * would open it now, filled from the record (client, 6 Nov 2026: "When user
 * clicks to preview application, it should be the online version"). Read-only.
 */
import Link from 'next/link';
import { authorize } from '@/lib/records/permissions';
import { ApplicationError, previewApplicationOnline } from '@/lib/applications/service';
import { ApplicationPreview } from './ApplicationPreview';

export const dynamic = 'force-dynamic';

export default async function ApplicationPreviewPage({
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
  let data: Awaited<ReturnType<typeof previewApplicationOnline>> | null = null;
  if (/^[0-9a-f-]{36}$/i.test(recordId)) {
    try {
      data = await previewApplicationOnline(ctx, recordId);
    } catch (e) {
      if (!(e instanceof ApplicationError) && !(e instanceof Error && /No (edit )?access/.test(e.message))) throw e;
    }
  }
  if (!data) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-[420px] rounded-2xl border border-line bg-white p-8 text-center">
          <h1 className="text-[17px] font-semibold text-ink-900">This preview is not available</h1>
          <p className="mt-1.5 text-[13.5px] text-ink-500">The record may have been removed, or you cannot send applications on it.</p>
          <Link href="/" className="mt-5 inline-block text-[13px] font-semibold text-brand-700 hover:underline">
            Back to the CRM
          </Link>
        </div>
      </main>
    );
  }
  return <ApplicationPreview merchant={data.merchant} answers={data.answers} ssnOnFile={data.ssnOnFile} backHref={slug ? `/${slug}?record=${recordId}&tab=files` : '/'} />;
}
