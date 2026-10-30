/**
 * POST /api/agreements/send — Send Agreement, and Void & resend.
 *
 * A route rather than a Server Action because a send fills thirteen pages
 * and uploads them to the signing service, which can outlast a page
 * action's budget. Same gate as everything else: the session, Zod on the
 * body, then the service decides.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { AgreementError, TemplateMissingError, sendAgreement, voidAndResend } from '@/lib/agreements/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const Body = z.object({
  recordId: z.uuid().optional(),
  resendOf: z.uuid().optional(),
  kind: z.string().trim().min(1).max(60),
  subject: z.string().trim().min(1, 'Add a subject.').max(200),
  message: z.string().trim().min(1, 'Add a message.').max(5000),
});

export async function POST(req: NextRequest) {
  let ctx;
  try {
    ctx = await authorize();
  } catch {
    return NextResponse.json({ ok: false, message: 'Sign in to continue.' }, { status: 401 });
  }
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success || (!parsed.data.recordId && !parsed.data.resendOf)) {
    return NextResponse.json({ ok: false, message: parsed.success ? 'Nothing to send.' : (parsed.error.issues[0]?.message ?? 'Something in the message is not valid.') }, { status: 400 });
  }
  const { recordId, resendOf, kind, subject, message } = parsed.data;
  try {
    const r = resendOf ? await voidAndResend(ctx, resendOf, { kind, subject, message }) : await sendAgreement(ctx, { recordId: recordId!, kind, subject, message });
    return NextResponse.json({ ok: true, data: r }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    if (e instanceof AgreementError || e instanceof TemplateMissingError) return NextResponse.json({ ok: false, message: e.message }, { status: 409 });
    if (e instanceof Error && /No (edit )?access/.test(e.message)) return NextResponse.json({ ok: false, message: 'You do not have access to do that on this record.' }, { status: 403 });
    console.error('[agreements] send failed', e instanceof Error ? e.message.slice(0, 300) : e);
    return NextResponse.json({ ok: false, message: 'The agreement was not sent. Try again.' }, { status: 500 });
  }
}
