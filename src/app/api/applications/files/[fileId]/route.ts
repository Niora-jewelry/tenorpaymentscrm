/**
 * GET /api/applications/files/<id> — a returned application PDF, decrypted.
 *
 * These hold Social Security numbers (spec, Security): only someone with
 * "Returned application PDFs" may open one, and only on a record they can
 * open (`openReturnedPdf` checks both). Never cached, never sniffed, and
 * served as a download unless `?view` asks for the bytes the review screen
 * renders itself — they are still never rendered as a page on our origin.
 */
import { type NextRequest } from 'next/server';
import { authorize } from '@/lib/records/permissions';
import { ApplicationError, openReturnedPdf } from '@/lib/applications/service';
import { contentDisposition, notFound, untrustedHeaders, UUID } from '@/lib/mail/routeGate';
import { rateLimit, userKey } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ fileId: string }> }) {
  let ctx;
  try {
    ctx = await authorize();
  } catch {
    return new Response('Sign in to continue.', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const { fileId } = await params;
  if (!UUID.test(fileId)) return notFound();
  const limit = await rateLimit(userKey('application_pdf', ctx.userId), { limit: 120, windowSeconds: 600 });
  if (!limit.allowed) return new Response('Too many requests. Try again shortly.', { status: 429 });

  try {
    const file = await openReturnedPdf(ctx, fileId);
    const view = req.nextUrl.searchParams.has('view');
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: untrustedHeaders({
        'Content-Type': view ? 'application/pdf' : 'application/octet-stream',
        'Content-Disposition': view ? 'inline' : contentDisposition(file.name),
        'Cache-Control': 'private, no-store',
        'Content-Length': String(file.bytes.byteLength),
      }),
    });
  } catch (e) {
    if (e instanceof ApplicationError) return new Response(e.message, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    console.error('[applications] pdf open failed', e instanceof Error ? e.message.slice(0, 200) : e);
    return notFound();
  }
}
