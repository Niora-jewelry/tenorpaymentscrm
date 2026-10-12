/**
 * Encoding and decoding the one string a `<form>` field can carry.
 *
 * ── WHY THIS IS NOT IN `actions.ts` ──────────────────────────────────────
 * ⚠️ `actions.ts` carries `'use server'`, and a "use server" module may
 * export ONLY async functions. Exporting a plain value from it — a `Set`, a
 * constant, anything — does not fail to compile and does not fail a unit
 * test. It poisons the whole module at RUNTIME:
 *
 *     Error: A "use server" file can only export async functions,
 *            found object.
 *
 * and because the Server Actions loader imports that module as a unit, EVERY
 * action on the page then returns a 500. Saving any field in the drawer dies,
 * with the browser reporting only "Could not reach the server".
 *
 * That happened: `JSON_VALUED_FIELD_TYPES` was exported straight out of
 * `actions.ts` so a test could assert on it, and `tsc`, ESLint and the whole
 * unit suite stayed green while every write in the application was broken.
 * Nothing short of actually loading the page catches it.
 *
 * So the shared values live here, in an ordinary module, and `actions.ts`
 * imports them. The rule worth remembering: anything a test needs to import
 * from an action file is a sign it does not belong in the action file.
 */
import type { Field, FieldType } from '@/lib/records/config';

/** Field types whose value is a JSON object/array, not a scalar —
 * `RealFieldGrid.tsx`'s `handleChange` runs `JSON.stringify` on these before
 * putting them in the FormData (a plain string is all a `<form>` field can
 * carry), so this is that encoding's exact inverse. Getting this wrong
 * doesn't error — a `jsonb` column accepts a JSON STRING scalar just as
 * happily as a JSON object — so a skipped `JSON.parse` here silently stores
 * `"{\"city\":\"Austin\",...}"` (the object, once more JSON-encoded as text)
 * instead of a real nested object, and every future read sees a string where
 * it expects a record. */
export const JSON_VALUED_FIELD_TYPES = new Set<FieldType>([
  'percent_split', 'grid', 'address', 'multi_select', 'months',
  // `team_member` was missing from this set for as long as the set has
  // existed, and it was the one entry where the omission was not merely a
  // storage bug: a `["uuid","uuid"]` array arriving as a JSON STRING is what
  // `sync_record_team_members()` then tries to iterate as an array, so the
  // whole write dies inside the trigger that maintains record visibility.
  // Nothing ever hit it because nothing could edit the field.
  'team_member',
  // ⚠️ `repeat_group` was missing too, and this one reached a user.
  //
  // Its value is an array of instances — `[{name, email, phone}, …]`. Sent
  // through `JSON.stringify` by the client and then NOT parsed here, it was
  // stored as a jsonb STRING. Every later read saw a string where it expected
  // an array, and the drawer rendered the string CHARACTER BY CHARACTER: a
  // 91-character JSON string became "Contacts 91", ninety-one blank contact
  // rows, and a client who had typed one contact and could no longer see it.
  //
  // The data was never lost — it was inside the string the whole time, and
  // migration …9753 parses it back. But "silently stores the wrong shape" is
  // precisely what the comment above this list warned about, three types in a
  // row now, which is why the list is no longer the only line of defence:
  // `actions.jsonValues.test.ts` asserts that every non-scalar field type in
  // the FieldType union appears here, so a new one cannot be forgotten.
  'repeat_group',
]);

/** The single-checkbox equivalent of the same problem: `handleChange` sends
 * the boolean through `String(next)`, so `false` arrives here as the
 * non-empty string `"false"` — parsed back to a real boolean, not left as
 * text, or an unchecked box would silently read back as checked forever
 * (`Boolean("false")` is `true`). */
/**
 * Returns a RESULT rather than the value, because `JSON.parse` throws.
 *
 * An unparseable string reaching here used to take the whole Server Action
 * down with an uncaught `SyntaxError` — a 500 and Next's generic error screen,
 * for what is simply a bad argument. The happy path cannot produce one (the
 * client stringifies these types itself), which is exactly why it went
 * unnoticed: every way to hit it is a client bug, a half-sent request or a
 * hand-made call, and all three deserve a refusal sentence instead of a crash.
 */
export function decodeFieldValue(
  field: Field,
  raw: string,
): { ok: true; value: unknown } | { ok: false } {
  if (field.type === 'checkbox') return { ok: true, value: raw === 'true' };
  if (JSON_VALUED_FIELD_TYPES.has(field.type)) {
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, value: raw };
}
