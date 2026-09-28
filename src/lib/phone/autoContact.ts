/**
 * File a contact automatically when a number already belongs to the CRM.
 *
 * The client's rule, in his own words:
 *
 *   "IF THE NUMBER EXISTS IN THE CRM THEN THE CONTACT IS AUTOMATICALLY
 *    CREATED. BUT CREATING A NEW NUMBER FOR A CONTACT SHOULD NOT
 *    AUTOMATICALLY CREATE A CRM RECORD"
 *
 * ── WHY THERE IS ONE FUNCTION AND FOUR CALLERS ───────────────────────────
 * A number can reach the CRM four ways: an inbound call, an inbound text, a
 * call someone places, a text someone sends. The rule has to hold for all
 * four, and the surest way for it not to is four copies of it. This is the
 * only thing that calls `ensure_auto_contact`.
 *
 * ── IT NEVER THROWS ──────────────────────────────────────────────────────
 * Every caller is either a Twilio webhook or the moment a call or text is
 * being placed. Filing an address-book entry is the least important thing
 * happening in any of them: a failure here must never cost a conversation, or
 * make Twilio retry a webhook it already handled. So this reports and returns.
 *
 * ── AND IT DECIDES NOTHING ───────────────────────────────────────────────
 * Whether the number matched, and therefore whether a contact appears at all,
 * is decided in SQL by `ensure_auto_contact` — passing a null record id means
 * "no match" and files nothing. Keeping that judgement in one place means the
 * "unmatched numbers do not fill the address book with strangers" half of the
 * rule cannot be forgotten by a caller.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

export async function fileAutoContact(
  client: SupabaseClient,
  ownerId: string | null | undefined,
  e164: string | null | undefined,
  recordId: string | null,
): Promise<void> {
  // No owner means an inbound call to a number nobody owns — there is no
  // address book to file it in. Not an error.
  if (!ownerId || !e164) return;

  const { error } = await client.rpc('ensure_auto_contact', {
    p_owner_id: ownerId,
    p_e164: e164,
    p_record_id: recordId,
  });

  if (error) console.error('[contacts] auto-file failed', { e164, error: error.message });
}
