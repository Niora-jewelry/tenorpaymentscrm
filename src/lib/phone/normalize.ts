/**
 * Phone numbers in, E.164 out.
 *
 * ── WHY THIS MATTERS MORE THAN IT LOOKS ──────────────────────────────────
 * Matching an inbound call to a merchant is an EXACT string comparison against
 * what is stored in the record's phone fields. Twilio always hands us E.164
 * (`+19733704989`); a human typing into a CRM writes `(973) 370-4989`. Those
 * never match, and the failure is silent — the call simply arrives attached to
 * no record, which looks like "that number isn't in the system" rather than
 * like a bug.
 *
 * Donny hit exactly this in the old CRM. Asked what he did about it, his answer
 * was that every enrichment path was updated to normalise on write, with one
 * exception, and that a backfill was never needed there only because that
 * database held nothing but freshly-created leads. This one does not have that
 * luxury — it has seeded demo data and will have client data — so normalising
 * on write is not enough on its own and `scripts/backfill-phone-e164.mjs`
 * exists for what is already stored.
 *
 * ── THE DEFAULT-REGION ASSUMPTION, STATED PLAINLY ────────────────────────
 * A bare 10-digit number is assumed to be US/Canada and gets `+1`. That is the
 * client's market and matches the instruction that came with the Twilio
 * handover ("phone numbers need to be normalized to begin with +1"). It is an
 * assumption, not a fact about the world: an 11-digit string starting with 1 is
 * treated the same way, and anything already carrying a `+` is trusted as
 * written and only stripped of formatting. A number from outside NANP must be
 * entered with its own `+` prefix to survive this.
 */

/** A number we could not make sense of. Callers must handle it — never guess. */
export type NormalizeResult =
  | { ok: true; e164: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'too_long' };

/**
 * Strict normalisation, for anything that will be stored or dialled.
 *
 * Returns a reason rather than throwing, because most callers are reacting to
 * user input and want to say what was wrong, not crash.
 */
export function normalizePhone(raw: string): NormalizeResult {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // Keep a leading + if present; drop every other non-digit. Extensions,
  // spaces, dots, brackets and dashes all disappear here.
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');

  if (!digits) return { ok: false, reason: 'empty' };

  // Already international: trust the caller's country code.
  if (hasPlus) {
    // E.164 allows at most 15 digits, and needs a country code plus something.
    if (digits.length < 8) return { ok: false, reason: 'too_short' };
    if (digits.length > 15) return { ok: false, reason: 'too_long' };
    return { ok: true, e164: `+${digits}` };
  }

  // NANP: 10 digits is a bare number, 11 starting with 1 already carries the
  // country code.
  if (digits.length === 10) return { ok: true, e164: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith('1')) return { ok: true, e164: `+${digits}` };

  if (digits.length < 10) return { ok: false, reason: 'too_short' };
  if (digits.length > 15) return { ok: false, reason: 'too_long' };

  // 12-15 digits with no `+` — almost certainly international typed without
  // its prefix. Accept it as-is rather than silently prepending +1, which
  // would produce a valid-looking number that dials the wrong country.
  return { ok: true, e164: `+${digits}` };
}

/** Normalisation for matching only — returns null instead of a reason. */
export function toE164OrNull(raw: string): string | null {
  const result = normalizePhone(raw);
  return result.ok ? result.e164 : null;
}

/**
 * E.164 → something a person reads comfortably.
 *
 * NANP numbers get the familiar grouping; everything else is returned as
 * stored, because inventing grouping rules for countries we do not know is
 * worse than showing the raw international form.
 */
export function formatPhoneDisplay(e164: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 ?? '');
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : (e164 ?? '');
}
