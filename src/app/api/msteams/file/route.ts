/**
 * GET /api/msteams/file?key=&url=: downloads a file from a conversation.
 *
 * Whoever may see the conversation may have its files. The link handed to the browser
 * is Microsoft's own short-lived one, so the file does not pass through this server,
 * and only links of the kind Teams keeps files behind are ever looked up.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { routeGate } from '@/lib/mail/routeGate';
import { TeamsError } from '@/lib/msteams/access';
import { fileDownloadUrl } from '@/lib/msteams/chat';
import { safeHttps } from '@/lib/msteams/format';
import { RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const Query = z.object({ key: z.string().min(1).max(600), url: z.string().min(1).max(2048) });

export async function GET(req: NextRequest) {
  const gate = await routeGate('teams_file', RATE_LIMITS.teamsReadPerUser);
  if ('response' in gate) return gate.response;
  const sp = req.nextUrl.searchParams;
  const parsed = Query.safeParse({ key: sp.get('key'), url: sp.get('url') });
  if (!parsed.success) return new NextResponse('Not found.', { status: 404 });
  try {
    const link = await fileDownloadUrl(gate.ctx, parsed.data);
    // The mock server is plain http on a local run; real Microsoft links are always https.
    const usable = process.env.MAIL_PROVIDER === 'mock' ? link : safeHttps(link);
    if (!usable) return new NextResponse('This file could not be found. It may have been removed in Teams.', { status: 404 });
    const res = NextResponse.redirect(usable, 303);
    res.headers.set('Cache-Control', 'no-store');
    return res;
  } catch (e) {
    if (e instanceof TeamsError) return new NextResponse(e.message, { status: 403 });
    throw e;
  }
}
