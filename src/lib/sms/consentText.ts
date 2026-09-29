/**
 * The exact words people agree to.
 *
 * ── WHY THIS IS ONE CONSTANT AND NOT THREE STRINGS ───────────────────────
 * The same sentence has to appear in three places that must never disagree:
 *
 *   1. beside the checkbox on the public consent form
 *   2. in the row written to `sms_consents.consent_text`
 *   3. in what was filed with the carriers
 *
 * If (1) and (2) drift, the stored evidence describes something the person did
 * not see. If either drifts from (3), the carrier reviewer compares the live
 * page against the filing, finds them different, and rejects the campaign —
 * which is one of the three reasons TapDash's registration was rejected on
 * 18 September.
 *
 * So it lives here, once, and every caller imports it. Changing it is
 * deliberate and visible, and old records keep the wording they were agreed
 * under because the database stores the text rather than a pointer to it.
 *
 * ⚠ CHANGING THIS AFTER FILING MEANS RE-FILING. The words below are what was
 * submitted to the carriers. Edit them and the live page no longer matches the
 * campaign, which is a rejection waiting to happen.
 */

/** The checkbox label on the public form, and what gets stored verbatim. */
export const SMS_CONSENT_TEXT =
  'I agree to receive text messages from TapDash Payments regarding my inquiry, ' +
  'account, or customer support requests. Msg & data rates may apply. Message ' +
  'frequency varies. Reply STOP to unsubscribe at any time. Consent is not a ' +
  'condition of purchase.';

/**
 * What a representative reads aloud before recording a verbal consent.
 *
 * Carriers accept verbal opt-in for this kind of business — numbers are
 * collected on calls, not web forms — but only against a written script. This
 * is that script, and it is stored on the record as the wording agreed to,
 * exactly as the form's text is.
 */
export const SMS_VERBAL_CONSENT_SCRIPT =
  'Before we continue — is it alright if we text you about your inquiry, account ' +
  'or support requests? Message and data rates may apply, message frequency ' +
  'varies, and you can reply STOP at any time to opt out. This is not a ' +
  'condition of doing business with us.';

/** The clause that appears on signed paperwork. */
export const SMS_PAPERWORK_CONSENT_TEXT =
  'By providing a mobile number, the merchant agrees to receive text messages ' +
  'from TapDash Payments regarding their inquiry, account, or customer support ' +
  'requests. Message and data rates may apply. Message frequency varies. Reply ' +
  'STOP to unsubscribe at any time. Consent is not a condition of purchase.';

/** Which wording belongs to which route, so a caller cannot pair them wrongly. */
export const CONSENT_TEXT_BY_SOURCE = {
  web_form: SMS_CONSENT_TEXT,
  verbal: SMS_VERBAL_CONSENT_SCRIPT,
  paperwork: SMS_PAPERWORK_CONSENT_TEXT,
} as const;

export type ConsentSource = keyof typeof CONSENT_TEXT_BY_SOURCE | 'imported';

/**
 * Keywords that end consent.
 *
 * Twilio also acts on these at its own layer, which is why a merchant who
 * replies STOP stops receiving messages whether or not this code runs. That is
 * not a reason to skip recording it: Twilio's copy of the fact is not ours, it
 * is not in our audit trail, and the CRM would go on showing the person as
 * consented while the carrier refused every message. Both must agree.
 */
export const STOP_KEYWORDS = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
  'OPTOUT',
  'REVOKE',
] as const;

/** Keywords that restore it. */
export const START_KEYWORDS = ['START', 'YES', 'UNSTOP'] as const;

/** Does this inbound message body end consent? */
export function isStopKeyword(body: string): boolean {
  // Carriers match on the whole message, trimmed and case-insensitive — not on
  // a message that merely CONTAINS the word. "Please stop by at 3" is not an
  // opt-out, and treating it as one silently loses a customer's messages.
  const word = body.trim().toUpperCase().replace(/[.!]+$/, '');
  return (STOP_KEYWORDS as readonly string[]).includes(word);
}

/** Does this inbound message restore consent? */
export function isStartKeyword(body: string): boolean {
  const word = body.trim().toUpperCase().replace(/[.!]+$/, '');
  return (START_KEYWORDS as readonly string[]).includes(word);
}
