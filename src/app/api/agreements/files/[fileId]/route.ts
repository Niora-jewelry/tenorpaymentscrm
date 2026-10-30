/**
 * GET /api/agreements/files/<id> — an agreement PDF (the copy that went
 * out, or the signed one), decrypted.
 *
 * These print SSNs, bank and licence numbers: `openAgreementPdf` lets a
 * viewer open one only on a record they can see, and only when they may
 * see every field printed on it (spec §9: "the same rule as viewing the
 * Private subtab"). Never cached, never sniffed, served as a download.
 */
import { type NextRequest } from 'next/server';
import { authorize } from '@/lib/records/permissions';
import { AgreementError, openAgreementPdf } from '@/lib/agreements/service';
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
  const limit = await rateLimit(userKey('agreement_pdf', ctx.userId), { limit: 120, windowSeconds: 600 });
  if (!limit.allowed) return new Response('Too many requests. Try again shortly.', { status: 429 });

  try {
    const file = await openAgreementPdf(ctx, fileId);
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
    if (e instanceof AgreementError) return new Response(e.message, { status: 403, headers: { 'Cache-Control': 'no-store' } });
    console.error('[agreements] pdf open failed', e instanceof Error ? e.message.slice(0, 200) : e);
    return notFound();
  }
}
