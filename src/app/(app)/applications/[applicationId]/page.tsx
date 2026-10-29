/**
 * /applications/<id> — one application: the review screen (spec, Review and
 * overwrite rules), what was filled automatically, and — when a returned PDF
 * had no readable fields — the answers entered by hand next to the PDF.
 */
import Link from 'next/link';
import { authorize } from '@/lib/records/permissions';
import { ApplicationError, applicationPage } from '@/lib/applications/service';
import { Icon } from '@/proto/ui/icons';
import { ReviewScreen } from './ReviewScreen';

export const dynamic = 'force-dynamic';

export default async function ApplicationPage({ params }: { params: Promise<{ applicationId: string }> }) {
  const { applicationId } = await params;
  const ctx = await authorize();
  const ok = /^[0-9a-f-]{36}$/i.test(applicationId);
  let data;
  try {
    data = ok ? await applicationPage(ctx, applicationId) : null;
  } catch (e) {
    if (!(e instanceof ApplicationError)) throw e;
    data = null;
  }
  if (!data || !data.application) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-[420px] rounded-2xl border border-line bg-white p-8 text-center">
          <Icon name="file-text" size={22} className="mx-auto text-ink-300" />
          <h1 className="mt-4 text-[17px] font-semibold text-ink-900">This application is not available</h1>
          <p className="mt-1.5 text-[13.5px] text-ink-500">It may have been removed, or it belongs to a record you cannot open.</p>
          <Link href="/" className="mt-5 inline-block text-[13px] font-semibold text-brand-700 hover:underline">
            Back to the CRM
          </Link>
        </div>
      </main>
    );
  }
  return <ReviewScreen data={data} />;
}
