/**
 * The shape both Graph webhook routes share: the validation handshake, the
 * size cap, and "answer 202 now, work in after()".
 *
 * Microsoft requires an answer within 3 seconds (10 for validation) and
 * retries anything else, so nothing slow happens before the response.
 */
import 'server-only';
import { NextResponse, after, type NextRequest } from 'next/server';
import { mailConfigured } from '@/lib/env.server';
import { mailLog } from '../log';
import { MAX_NOTIFICATION_BYTES, drainSoon, parseNotifications, type Notification } from './notify';

const accepted = () => new NextResponse(null, { status: 202, headers: { 'Cache-Control': 'no-store' } });

export function graphWebhook(accept: (items: Notification[]) => Promise<string[]>) {
  return async function POST(req: NextRequest) {
    // Subscription creation: Microsoft POSTs ?validationToken=… and expects it
    // echoed back verbatim as text/plain within 10 seconds.
    const token = req.nextUrl.searchParams.get('validationToken');
    if (token !== null) {
      return new NextResponse(token.slice(0, 2048), {
        status: 200,
        headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' },
      });
    }
    if (!mailConfigured) return accepted();

    const declared = Number(req.headers.get('content-length') ?? 0);
    if (declared > MAX_NOTIFICATION_BYTES) return accepted();
    const raw = await req.text();
    const items = parseNotifications(raw);
    if (items.length === 0) return accepted();

    let touched: string[] = [];
    try {
      touched = await accept(items);
    } catch (e) {
      // Still 202: a retry storm from Microsoft would not help, and the
      // scheduled reconciliation covers anything this missed.
      mailLog('error', 'notify', 'accept_failed', { message: e instanceof Error ? e.message.slice(0, 200) : 'unknown' });
    }
    if (touched.length) after(() => drainSoon(touched));
    return accepted();
  };
}
