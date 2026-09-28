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
import { threadsForUser } from '@/lib/phone/messages';
import { contactsForUser } from '@/lib/phone/contacts';
import { DialPad, CallHistory } from './Dialer';
import { Threads } from './Threads';
import { Contacts } from './Contacts';

export default async function PhonePage() {
  const ctx = await authorize();
  if (!(await canSeePhone(ctx))) redirect('/dashboard');

  const supabase = await createSupabaseServerClient();
  const [calls, myNumber, threads, contacts] = await Promise.all([
    callsForUser(ctx),
    resolveUserActiveNumber(supabase, ctx.userId),
    threadsForUser(ctx),
    contactsForUser(ctx),
  ]);

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold text-ink-900">Phone</h1>
        <p className="text-[13px] text-ink-500">
          Calls are recorded and attached to a merchant automatically when the number matches one.
        </p>
      </div>

      {/*
        ── TWO COLUMNS, EACH STACKED ─────────────────────────────────────
        The grid lives here rather than inside `Dialer`, because the page has
        four panels in two columns and a component cannot lay out its own
        siblings.

        The pairing is by WIDTH, not by subject. The dial pad and the message
        composer are both narrow, single-purpose controls; the call list and
        the address book are both wide lists of records. Putting Messages
        beside the pad and Contacts beneath the calls means neither column
        changes width halfway down, which is what made the previous
        full-width strips look stacked rather than designed.

        `items-start` stops a short column stretching to match a tall one -
        without it an empty Contacts panel would grow to the height of a long
        call list and sit mostly blank.
      */}
      <div className="grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
        <div className="space-y-5">
          <DialPad myNumber={myNumber?.e164 ?? null} />
          <Threads threads={threads} />
        </div>

        <div className="space-y-5">
          <CallHistory calls={calls} />
          <Contacts contacts={contacts} />
        </div>
      </div>
    </div>
  );
}
