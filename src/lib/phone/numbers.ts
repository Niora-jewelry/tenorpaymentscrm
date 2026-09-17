/**
 * The ONE owner-resolution path for the phone module.
 *
 * Ported from Donny's `lib/phone/resolve-number-owner.ts`, which needed only
 * its client type repointing. His rule stands and is worth restating: every
 * write site that needs "who owns this number" or "what number does this user
 * own" comes through here. Ad-hoc `phone_numbers` lookups scattered across the
 * webhooks are how the two answers drift apart.
 *
 * Both functions take a client rather than making one, because the callers
 * differ in kind: a webhook has no `auth.uid()` and must pass the service-role
 * client, while a server action passes the request-scoped one so RLS still
 * applies. Neither ever defaults to "some user" — an unowned number returns
 * null and the caller decides what that means.
 */
import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Number → the user whose browser should ring, and who owns the resulting row.
 *
 * A `kind='campaign'` number has no owning user by construction (the
 * `phone_numbers_kind_shape` check enforces it), so inbound callbacks to one —
 * somebody ringing a campaign number back — route to `fallback_user_id`
 * instead. Returns null only when genuinely unowned, which is a real state:
 * the call still gets logged, with `owner_id` null, visible to admins.
 */
export async function resolveNumberOwnerId(
  client: SupabaseClient,
  e164: string,
): Promise<string | null> {
  const { data, error } = await client
    .from('phone_numbers')
    .select('kind, user_id, fallback_user_id')
    .eq('e164', e164)
    .eq('is_active', true)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    console.error('[phone] resolveNumberOwnerId failed', error);
    return null;
  }
  if (!data) return null;

  return data.kind === 'campaign'
    ? (data.fallback_user_id as string | null)
    : (data.user_id as string | null);
}

/**
 * User → their active number, for outbound caller id.
 *
 * Returns null when the user has no active number, and an outbound dial or SMS
 * must NOT proceed in that case — there is no shared fallback number to borrow,
 * deliberately. The `phone_numbers_one_active_per_user` partial unique index
 * guarantees at most one row, so `maybeSingle` is correct rather than lucky.
 */
export async function resolveUserActiveNumber(
  client: SupabaseClient,
  userId: string,
): Promise<{ id: string; e164: string } | null> {
  const { data, error } = await client
    .from('phone_numbers')
    .select('id, e164')
    .eq('user_id', userId)
    .eq('kind', 'user')
    .eq('is_active', true)
    .is('deleted_at', null)
    .maybeSingle();

  if (error) {
    console.error('[phone] resolveUserActiveNumber failed', error);
    return null;
  }
  return data ? { id: data.id as string, e164: data.e164 as string } : null;
}
