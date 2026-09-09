/**
 * POST /api/auth/signup — request a signup code.
 *
 * Exists as a route handler specifically because the spec says:
 *
 *   "Enforced at the API layer — the signup endpoint is publicly reachable and
 *    must reject uninvited emails regardless of what the UI shows."
 *
 * Having it here means the guarantee can be PROVEN with a direct call, no
 * browser and no UI involved:
 *
 *   curl -X POST http://localhost:3000/api/auth/signup \
 *        -H 'content-type: application/json' \
 *        -d '{"email":"never-invited@example.com"}'
 *
 * That request must come back rejected. There is an end-to-end test asserting
 * exactly this.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { startSignup } from '@/lib/auth/signup';
import { startSignupSchema, fieldErrors } from '@/lib/auth/schemas';
import { requestContext } from '@/lib/security/request';
import { AUTH_MESSAGES } from '@/lib/auth/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { status: 'error', message: 'Expected a JSON body.' },
      { status: 400 },
    );
  }

  const parsed = startSignupSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { status: 'error', errors: fieldErrors(parsed.error) },
      { status: 400 },
    );
  }

  const context = requestContext(request.headers);
  const result = await startSignup(parsed.data.email, context);

  switch (result.status) {
    case 'otp_sent':
      return NextResponse.json({ status: 'otp_sent', message: AUTH_MESSAGES.otpSent });

    case 'not_invited':
      // 403, and no code was sent. This is the spec's explicit message
      // (Decision A) — signup discloses invite status on purpose.
      return NextResponse.json(
        { status: 'not_invited', message: result.message },
        { status: 403 },
      );

    case 'already_registered':
      return NextResponse.json(
        { status: 'already_registered', message: result.message, redirect: '/login' },
        { status: 409 },
      );

    case 'cooldown':
      return NextResponse.json(
        { status: 'cooldown', message: result.message },
        { status: 429 },
      );

    case 'rate_limited':
      return NextResponse.json(
        { status: 'rate_limited', message: result.message },
        { status: 429 },
      );

    default:
      return NextResponse.json(
        { status: 'error', message: result.message },
        { status: 500 },
      );
  }
}

/** Only POST is meaningful here. */
export function GET() {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
