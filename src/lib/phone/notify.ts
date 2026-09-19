/**
 * Bell notifications for things that happen on a call.
 *
 * ── WHY THE WEBHOOKS RAISE THESE AND NOT THE BROWSER ─────────────────────
 * A call ends, is missed, or finishes recording long after whoever placed it
 * has moved on — often with the tab closed. The only party present for all
 * three is Twilio's callback, so that is where the notification is raised.
 *
 * `notify()` is SECURITY DEFINER with no grant to `authenticated` at all, and
 * these routes already hold the service-role client, so this needs no new
 * permission surface.
 *
 * ── FAILURE IS SWALLOWED, DELIBERATELY ───────────────────────────────────
 * A webhook that throws makes Twilio retry the whole delivery, and a retried
 * status callback would re-run the row update as well. A missing bell entry is
 * a far smaller problem than a duplicated call log, so every failure here is
 * logged and dropped.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { formatPhoneDisplay } from './normalize';

/** Matches `TAB_FOR_KIND` in `lib/records/notifications.ts`, which turns these
 *  into the tab the bell opens. */
export type CallNotificationKind = 'call' | 'voicemail' | 'recording';

/**
 * Raise one bell entry about a call, addressed to whoever owns it.
 *
 * Reads the call rather than taking the details as arguments: the callbacks
 * each know a different subset, and reading one row here keeps the wording
 * consistent between them.
 */
export async function notifyAboutCall(
  admin: SupabaseClient,
  callId: string,
  kind: CallNotificationKind,
  phrase: (peer: string) => string,
): Promise<void> {
  if (!callId) return;

  try {
    const { data, error } = await admin
      .from('phone_calls')
      .select('owner_id, record_id, direction, from_e164, to_e164')
      .eq('id', callId)
      .maybeSingle();
    if (error) throw error;

    const owner = data?.owner_id as string | undefined;
    // No owner means an inbound call to an unassigned number: there is nobody
    // whose bell this belongs in. The call is still logged and admin-visible.
    if (!owner) return;

    const peerRaw =
      (data?.direction as string) === 'in'
        ? (data?.from_e164 as string | null)
        : (data?.to_e164 as string | null);
    const peer = peerRaw ? formatPhoneDisplay(peerRaw) : 'an unknown number';

    const { error: notifyError } = await admin.rpc('notify', {
      p_recipient_id: owner,
      p_body: phrase(peer),
      p_record_id: (data?.record_id as string | null) ?? null,
      p_source_kind: kind,
    });
    if (notifyError) throw notifyError;
  } catch (cause) {
    console.error('[phone] notifyAboutCall failed', { callId, kind, cause });
  }
}
