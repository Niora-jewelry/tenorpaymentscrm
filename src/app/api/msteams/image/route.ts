/**
 * GET /api/msteams/image?key=&m=&r=&h=: one picture from a Teams message.
 *
 * Teams keeps a pasted picture behind Microsoft sign-in, so the browser cannot load
 * it directly. This asks Microsoft as the account the conversation is on, for
 * whoever may read that conversation, and passes the bytes through. Only the ids
 * come from the browser: the address at Microsoft is built from the conversation.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { routeGate, untrustedHeaders } from '@/lib/mail/routeGate';
import { TeamsError } from '@/lib/msteams/access';
import { hostedImage } from '@/lib/msteams/chat';
import { imageTypeOf } from '@/lib/msteams/format';
import { RATE_LIMITS } from '@/lib/security/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** A message id: digits at Microsoft, never a path. */
const MessageId = z.string().min(1).max(200).regex(/^[A-Za-z0-9_\-:@=]+$/);
/** A picture's id is base64, which can hold "/" and "+"; it is encoded into the path, never followed. */
const HostedId = z.string().min(1).max(1000).regex(/^[A-Za-z0-9=_\-+:@/]+$/);
const Query = z.object({ key: z.string().min(1).max(600), m: MessageId, r: MessageId.optional(), h: HostedId });

/** What a browser may show as a picture. SVG is left out: it can carry script. */
const SHOWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);
const MAX_BYTES = 25 * 1024 * 1024;

export async function GET(req: NextRequest) {
  const gate = await routeGate('teams_image', RATE_LIMITS.teamsImagePerUser);
  if ('response' in gate) return gate.response;
  const sp = req.nextUrl.searchParams;
  const parsed = Query.safeParse({ key: sp.get('key'), m: sp.get('m'), r: sp.get('r') ?? undefined, h: sp.get('h') });
  if (!parsed.success) return new NextResponse('Not found.', { status: 404 });
  let res: Response;
  try {
    res = await hostedImage(gate.ctx, { key: parsed.data.key, messageId: parsed.data.m, replyId: parsed.data.r ?? null, hostedId: parsed.data.h });
  } catch (e) {
    if (e instanceof TeamsError) return new NextResponse(e.message, { status: 404 });
    throw e;
  }
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > MAX_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    return cannotShow();
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_BYTES) return cannotShow();
  // Microsoft does not always name the type, so the bytes decide when it does not.
  const said = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const type = SHOWABLE.has(said) ? said : (imageTypeOf(bytes) ?? (isWebp(bytes) ? 'image/webp' : null));
  if (!type) return cannotShow();
  const headers = untrustedHeaders({
    'Content-Type': type,
    'Content-Length': String(bytes.length),
    'Content-Disposition': 'inline',
    // A picture in a message never changes; only this person's browser keeps it.
    'Cache-Control': 'private, max-age=86400, immutable',
  });
  return new NextResponse(bytes, { status: 200, headers });
}

const cannotShow = () => new NextResponse('This picture cannot be shown here. Open it in Teams.', { status: 415 });

const isWebp = (b: Uint8Array) => b.length >= 12 && String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!) === 'RIFF' && String.fromCharCode(b[8]!, b[9]!, b[10]!, b[11]!) === 'WEBP';
