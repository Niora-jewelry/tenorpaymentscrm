/**
 * /phone — the softphone.
 *
 * The per-record view lives in the drawer's Communication tab; this is the
 * other half, for the calls that are not about one merchant: dialling a number
 * someone read out, calling back a missed call, working a list.
 *
 * Laid out as the client's Phone review asks (Phone and SMS tabs, Recent and
 * Contacts on the left, keypad or SMS panel on the right): see PhoneWorkspace.
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
import { messagesForThread, threadsForUser } from '@/lib/phone/messages';
import { contactsForUser } from '@/lib/phone/contacts';
import { canTextMany, broadcastsForUser } from '@/lib/phone/broadcasts';
import { groupsForUser } from '@/lib/phone/groups';
import { MarkPhoneRead } from './MarkPhoneRead';
import { PhoneWorkspace } from './PhoneWorkspace';
import { TextMany } from './TextMany';

export default async function PhonePage({ searchParams }: { searchParams: Promise<{ tab?: string | string[] }> }) {
  const ctx = await authorize();
  if (!(await canSeePhone(ctx))) redirect('/dashboard');
  const { tab } = await searchParams;

  const supabase = await createSupabaseServerClient();
  const [calls, myNumber, threads, contacts, mayTextMany, broadcasts, groups] = await Promise.all([
    callsForUser(ctx),
    resolveUserActiveNumber(supabase, ctx.userId),
    threadsForUser(ctx),
    contactsForUser(ctx),
    canTextMany(ctx),
    broadcastsForUser(ctx),
    groupsForUser(ctx),
  ]);

  // The SMS panel opens on the topmost conversation; it comes with the page so
  // the panel is never empty for a moment.
  const top = threads[0] ?? null;
  const initialThread = top
    ? { key: top.threadKey, stamp: `${top.lastAt}|${top.count}`, messages: await messagesForThread(ctx, top.threadKey) }
    : null;

  return (
    <div className="p-6">
      <MarkPhoneRead />
      <PhoneWorkspace
        calls={calls}
        threads={threads}
        contacts={contacts}
        myNumber={myNumber?.e164 ?? null}
        initialTab={tab === 'sms' ? 'sms' : 'phone'}
        initialThread={initialThread}
        smsExtra={
          /* Broadcast and group texts: texting more than one person, so under
             SMS. Somebody without the permission who can still see groups
             (Phone = All users) reads them here without controls. */
          mayTextMany || broadcasts.length > 0 || groups.length > 0 ? (
            <TextMany
              allowed={mayTextMany}
              myNumber={myNumber?.e164 ?? null}
              contacts={contacts}
              broadcasts={broadcasts}
              groups={groups}
            />
          ) : null
        }
      />
    </div>
  );
}
