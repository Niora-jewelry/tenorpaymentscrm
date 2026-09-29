import { describe, expect, it } from 'vitest';
import {
  CONSENT_TEXT_BY_SOURCE,
  SMS_CONSENT_TEXT,
  isStartKeyword,
  isStopKeyword,
} from './consentText';

describe('opt-out keywords', () => {
  it('recognises every keyword carriers require', () => {
    for (const w of ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']) {
      expect(isStopKeyword(w)).toBe(true);
    }
  });

  it('is case-insensitive and tolerates surrounding space', () => {
    expect(isStopKeyword('stop')).toBe(true);
    expect(isStopKeyword('  Stop  ')).toBe(true);
    expect(isStopKeyword('STOP.')).toBe(true);
  });

  /*
   * The case that matters. Matching a message that CONTAINS "stop" would
   * unsubscribe a customer who wrote a normal sentence, and they would never
   * know — their messages would simply stop arriving. Carriers match the whole
   * message, and so does this.
   */
  it('does not treat an ordinary sentence containing the word as an opt-out', () => {
    for (const s of [
      'Please stop by at 3pm',
      'Can you stop the recurring charge?',
      'I want to stop using the old terminal',
      'Do not stop the service',
    ]) {
      expect(isStopKeyword(s)).toBe(false);
    }
  });

  it('an empty message is not an opt-out', () => {
    expect(isStopKeyword('')).toBe(false);
    expect(isStopKeyword('   ')).toBe(false);
  });
});

describe('opt-in keywords', () => {
  it('recognises START and its variants', () => {
    for (const w of ['START', 'start', ' Start ', 'YES', 'UNSTOP']) {
      expect(isStartKeyword(w)).toBe(true);
    }
  });

  it('does not treat a sentence containing "yes" as an opt-in', () => {
    expect(isStartKeyword('yes please call me')).toBe(false);
    expect(isStartKeyword('Can we start on Monday?')).toBe(false);
  });

  it('STOP and START cannot both match the same message', () => {
    for (const w of ['STOP', 'START', 'CANCEL', 'YES', 'Please stop by']) {
      expect(isStopKeyword(w) && isStartKeyword(w)).toBe(false);
    }
  });
});

describe('the consent wording', () => {
  /*
   * These are the exact phrases carriers check for on the live page, and the
   * campaign filing quotes the same sentence. A well-meaning edit that drops
   * one is a rejection, so each is asserted individually rather than by
   * comparing the whole string — a single failing line names what went.
   */
  it('carries every disclosure the carriers require', () => {
    expect(SMS_CONSENT_TEXT).toContain('TapDash Payments');
    expect(SMS_CONSENT_TEXT).toContain('Msg & data rates may apply');
    expect(SMS_CONSENT_TEXT).toContain('Message frequency varies');
    expect(SMS_CONSENT_TEXT).toContain('Reply STOP to unsubscribe');
    expect(SMS_CONSENT_TEXT).toContain('Consent is not a condition of purchase');
  });

  it('every consent route has wording of its own', () => {
    for (const source of ['web_form', 'verbal', 'paperwork'] as const) {
      expect(CONSENT_TEXT_BY_SOURCE[source].length).toBeGreaterThan(80);
      expect(CONSENT_TEXT_BY_SOURCE[source]).toMatch(/STOP/);
    }
  });

  /* The routes are genuinely different texts. A copy-paste that made the
     verbal script identical to the form's would store, against a phone call,
     words describing a checkbox nobody saw. */
  it('the three routes are not the same words', () => {
    const texts = [
      CONSENT_TEXT_BY_SOURCE.web_form,
      CONSENT_TEXT_BY_SOURCE.verbal,
      CONSENT_TEXT_BY_SOURCE.paperwork,
    ];
    expect(new Set(texts).size).toBe(3);
  });
});
