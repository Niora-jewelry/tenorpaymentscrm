/**
 * GET /api/agreements/preview/<recordId>?kind=<key> — the agreement PDF as Send would build it, built from the record as it is now and stamped
 * "PREVIEW" (client, 4 Nov 2026: every Send button offers a preview). Our own
 * generated PDF, shown inline; never cached.
 */
import { type NextRequest } from 'next/server';
import { authorize } from '@/lib/records/permissions';
import { AgreementError, previewAgreementPdf } from '@/lib/agreements/service';
import { notFound, UUID } from '@/lib/mail/routeGate';
import { rateLimit, userKey } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: NextRequest, { params }: { params: Promise<{ recordId: string }> }) {
  let ctx;
  try {
    ctx = await authorize();
  } catch {
    return new Response('Sign in to continue.', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const { recordId } = await params;
  if (!UUID.test(recordId)) return notFound();
  const kind = req.nextUrl.searchParams.get('kind') ?? '';
  if (!/^[a-z0-9_]{1,40}$/.test(kind)) return notFound();
  const limit = await rateLimit(userKey('agreement_preview', ctx.userId), { limit: 60, windowSeconds: 600 });
  if (!limit.allowed) return new Response('Too many previews. Try again shortly.', { status: 429 });
  try {
    const file = await previewAgreementPdf(ctx, recordId, kind);
    const ascii = file.name.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, "'");
    return new Response(new Uint8Array(file.bytes), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      },
    });
  } catch (e) {
    if (e instanceof AgreementError) return new Response(e.message, { status: 403, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
    console.error('[agreement_preview] failed', e instanceof Error ? e.message.slice(0, 200) : e);
    return new Response('The preview could not be built. Try again.', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
