/**
 * Twilio error translation.
 *
 * ── WHY THIS IS WORTH A TEST ─────────────────────────────────────────────
 * Every message here was written because the SDK's own text sent somebody to
 * the wrong place. Three of them are real incidents from getting this working:
 *
 *   31000 "An unknown error has occurred"  → a CSP header blocking a WebSocket
 *   31401 "The browser or end-user denied" → a Permissions-Policy header
 *   31005 "Error sent from gateway"        → a dead TwiML App URL
 *
 * If the code extraction ever breaks, every one of those silently reverts to
 * the unhelpful original — no crash, no failing build, just worse messages.
 * That is exactly the kind of regression a test has to catch.
 */
import { describe, it, expect } from 'vitest';
import { describePhoneError, phoneErrorLine } from './errors';

describe('describePhoneError', () => {
  it('reads the code off a Twilio error object', () => {
    const result = describePhoneError({ code: 31005, message: 'Error sent from gateway in HANGUP' });
    expect(result.code).toBe(31005);
    expect(result.kind).toBe('config');
    expect(result.hint).toContain('TwiML');
  });

  it('reads the code out of a formatted string when there is no object', () => {
    // Some paths only ever hand us the SDK's rendered text.
    const result = describePhoneError('ConnectionError (31005): Error sent from gateway in HANGUP');
    expect(result.code).toBe(31005);
    expect(result.hint).toContain('Voice Request URL');
  });

  it('points a microphone failure at the site setting, not at the user', () => {
    const result = describePhoneError({ code: 31401 });
    expect(result.kind).toBe('permission');
    expect(result.hint).toMatch(/address bar|Allow/);
  });

  it('points 31000 at the transport, since that is what it always was', () => {
    const result = describePhoneError({ code: 31000 });
    expect(result.kind).toBe('network');
    expect(result.hint).toContain('connect-src');
  });

  it('treats busy and declined as outcomes, not faults', () => {
    // These must not be styled or worded as errors — nothing is broken when a
    // merchant is on another call.
    expect(describePhoneError({ code: 31486 }).kind).toBe('call');
    expect(describePhoneError({ code: 31603 }).kind).toBe('call');
  });

  it('translates our own token-route codes too', () => {
    expect(describePhoneError(new Error('no_phone_number_assigned')).message).toContain('no phone number');
    expect(describePhoneError(new Error('phone_not_permitted')).hint).toContain('Phone subtab');
  });

  it('keeps an unknown code rather than inventing wording for it', () => {
    // Guessing at a message for a code nobody has seen produces confident
    // nonsense. Pass Twilio's own words through and keep the number.
    const result = describePhoneError({ code: 31999, message: 'Something new happened' });
    expect(result.message).toBe('Something new happened');
    expect(result.code).toBe(31999);
    expect(result.kind).toBe('unknown');
  });

  it('never throws, whatever it is handed', () => {
    for (const input of [null, undefined, 0, '', {}, [], new Error(''), { code: 'nope' }]) {
      expect(() => describePhoneError(input)).not.toThrow();
    }
  });

  it('phoneErrorLine keeps the code where a hint will not fit', () => {
    expect(phoneErrorLine({ code: 31486 })).toBe('That number is busy. (31486)');
  });
});
