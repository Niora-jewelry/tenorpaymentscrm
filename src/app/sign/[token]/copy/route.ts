/**
 * GET /sign/<token>/copy — the signer's signed copy, for 30 days after
 * everyone signed (what SignWell's own completion email would have given).
 * The token is the access; `signedCopy` checks it and rate-limits it.
 */
import { NextResponse } from 'next/server';
import { signedCopy } from '@/lib/agreements/signerPage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const file = await signedCopy(token).catch(() => null);
  if (!file) return new NextResponse('This copy is not available.', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const ascii = file.name.replace(/[^\x20-\x7e]+/g, '_').replace(/"/g, "'");
  return new NextResponse(new Uint8Array(file.bytes), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
