/**
 * Phone normalisation.
 *
 * ── WHY THIS IS TESTED AND MOST HELPERS ARE NOT ──────────────────────────
 * Matching an inbound call to a merchant is an exact string comparison. Twilio
 * hands us `+19733704989`; a human types `(973) 370-4989`. If this function is
 * wrong by one character, every inbound call attaches to no record and the
 * failure is SILENT — it reads as "that number isn't in the CRM", not as a bug.
 * There is no error, no log line and nothing on screen to notice.
 *
 * The `+1` default is an assumption about the client's market, not a fact about
 * the world, so the cases below pin it explicitly rather than leaving it to be
 * inferred from the implementation.
 */
import { describe, it, expect } from 'vitest';
import { normalizePhone, toE164OrNull, formatPhoneDisplay } from './normalize';

describe('normalizePhone', () => {
  it('accepts the formats a person actually types', () => {
    for (const input of [
      '(973) 370-4989',
      '973-370-4989',
      '973.370.4989',
      '973 370 4989',
      '9733704989',
      '  9733704989  ',
    ]) {
      expect(normalizePhone(input), input).toEqual({ ok: true, e164: '+19733704989' });
    }
  });

  it('treats a leading 1 as the country code, not an extra digit', () => {
    expect(normalizePhone('1 973 370 4989')).toEqual({ ok: true, e164: '+19733704989' });
    expect(normalizePhone('+1 (973) 370-4989')).toEqual({ ok: true, e164: '+19733704989' });
  });

  it('leaves an already-normalised number untouched', () => {
    // The backfill runs repeatedly; a second pass must be a no-op.
    expect(normalizePhone('+19733704989')).toEqual({ ok: true, e164: '+19733704989' });
  });

  it('trusts an explicit country code rather than forcing +1', () => {
    // A UK number must not become +1 44…, which would be a valid-looking
    // number that dials the wrong country.
    expect(normalizePhone('+44 20 7946 0958')).toEqual({ ok: true, e164: '+442079460958' });
  });

  it('refuses what it cannot make sense of, with a reason', () => {
    expect(normalizePhone('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizePhone('   ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizePhone('abc')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizePhone('555-1234')).toEqual({ ok: false, reason: 'too_short' });
    expect(normalizePhone('+1234567890123456789')).toEqual({ ok: false, reason: 'too_long' });
  });

  it('never throws — every caller is reacting to typed input', () => {
    for (const input of ['', '+', '++', '()', '-', '+++1']) {
      expect(() => normalizePhone(input)).not.toThrow();
    }
  });

  it('toE164OrNull collapses the reason away for match sites', () => {
    expect(toE164OrNull('(973) 370-4989')).toBe('+19733704989');
    expect(toE164OrNull('nonsense')).toBeNull();
  });
});

describe('formatPhoneDisplay', () => {
  it('renders NANP numbers the familiar way', () => {
    // Storing E.164 must not mean SHOWING it — the screens looked the same
    // before the backfill and have to look the same after.
    expect(formatPhoneDisplay('+19733704989')).toBe('(973) 370-4989');
  });

  it('returns anything else unchanged rather than inventing grouping', () => {
    expect(formatPhoneDisplay('+442079460958')).toBe('+442079460958');
    expect(formatPhoneDisplay('')).toBe('');
  });

  it('round-trips with normalizePhone', () => {
    const normalized = normalizePhone('973-370-4989');
    expect(normalized.ok).toBe(true);
    if (normalized.ok) {
      expect(toE164OrNull(formatPhoneDisplay(normalized.e164))).toBe(normalized.e164);
    }
  });
});
