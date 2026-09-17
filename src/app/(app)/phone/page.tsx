/**
 * /phone — the softphone.
 *
 * The per-record view lives in the drawer's Communication tab; this is the
 * other half, for the calls that are not about one merchant: dialling a number
 * someone read out, calling back a missed call, working a list.
 *
 * Gated by the `communication/phone` subtab grant rather than by a role, so who
 * gets a phone is configuration — the same grant that governs the drawer's
 * Phone subtab, which means one setting controls both and they cannot disagree.
 */
import { redirect } from 'next/navigation';
import { authorize } from '@/lib/records/permissions';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { canSeePhone } from '@/lib/phone/access';
import { callsForUser } from '@/lib/phone/calls';
import { resolveUserActiveNumber } from '@/lib/phone/numbers';
import { Dialer } from './Dialer';

export default async function PhonePage() {
  const ctx = await authorize();
  if (!(await canSeePhone(ctx))) redirect('/dashboard');

  const supabase = await createSupabaseServerClient();
  const [calls, myNumber] = await Promise.all([
    callsForUser(ctx),
    resolveUserActiveNumber(supabase, ctx.userId),
  ]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Phone</h1>
        <p className="text-[13px] text-ink-500">
          Calls are recorded and attached to a merchant automatically when the number matches one.
        </p>
      </div>

      <Dialer calls={calls} myNumber={myNumber?.e164 ?? null} />
    </div>
  );
}
