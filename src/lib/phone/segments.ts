/**
 * How many SMS segments a message body will actually cost.
 *
 * ── WHY THIS IS NOT `body.length / 160` ──────────────────────────────────
 * A text is billed and delivered in segments, and the size of a segment
 * depends on which characters are in it:
 *
 *   • GSM-7 (the standard alphabet): 160 characters in a single segment.
 *   • The moment ONE character falls outside that alphabet, the whole message
 *     is re-encoded as UCS-2 and the limit collapses to 70.
 *   • Once a message needs more than one segment, each one gives up space to
 *     concatenation headers: 153 for GSM-7, 67 for UCS-2.
 *   • Seven characters — ^ { } \ [ ~ ] | and the euro sign — are GSM-7 but
 *     cost TWO units each, because they are encoded as an escape plus a
 *     character.
 *
 * The practical consequence is the one users trip over: typing a curly
 * apostrophe instead of a straight one, or pasting an emoji, silently cuts
 * the limit from 160 to 70 and can turn one text into three. Showing the real
 * number is the difference between a composer that informs and one that
 * misleads, so the arithmetic lives here, in a pure function with tests,
 * rather than being approximated in the component.
 */

/** GSM 03.38 basic character set — one unit each. */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** GSM 03.38 extension table — two units each (escape + character). */
const GSM_EXTENDED = '^{}\\[~]|€';

const BASIC = new Set(GSM_BASIC);
const EXTENDED = new Set(GSM_EXTENDED);

export type SegmentInfo = {
  /** 'gsm' while every character fits GSM-7; 'ucs2' as soon as one does not. */
  encoding: 'gsm' | 'ucs2';
  /** Units consumed — NOT the same as `body.length` when escapes or
   *  surrogate pairs are involved. */
  units: number;
  /** Units one more segment would allow at this encoding and count. */
  perSegment: number;
  /** How many texts this actually sends. Zero for an empty body. */
  segments: number;
  /** Units still free inside the current segment count. */
  remaining: number;
};

/**
 * Twilio's hard ceiling for one API call. Past this the send is rejected
 * outright, which `sendSchema` also enforces server-side.
 */
export const MAX_BODY_LENGTH = 1600;

export function segmentInfo(body: string): SegmentInfo {
  if (!body) {
    return { encoding: 'gsm', units: 0, perSegment: 160, segments: 0, remaining: 160 };
  }

  let gsm = true;
  let units = 0;

  /*
   * Iterated by code POINT, not by index. A `for (i < length)` loop walks
   * UTF-16 code units, so an emoji — which is a surrogate pair — would be
   * counted as two separate unknown characters. The count would still land on
   * "2 units", but only by accident, and it would be wrong for anything that
   * pairs differently.
   */
  for (const ch of body) {
    if (BASIC.has(ch)) {
      units += 1;
    } else if (EXTENDED.has(ch)) {
      units += 2;
    } else {
      gsm = false;
      // In UCS-2 a character outside the Basic Multilingual Plane occupies two
      // 16-bit units. `ch.length` is exactly that, so it is the right measure.
      units += ch.length;
    }
  }

  if (!gsm) {
    /*
     * Re-count from scratch. The GSM escape rule does not apply in UCS-2, so a
     * body containing both `{` and an emoji must not keep charging 2 for the
     * brace — it is one UTF-16 unit there.
     */
    units = 0;
    for (const ch of body) units += ch.length;
  }

  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;

  const segments = units <= single ? 1 : Math.ceil(units / multi);
  const perSegment = segments <= 1 ? single : multi;

  return {
    encoding: gsm ? 'gsm' : 'ucs2',
    units,
    perSegment,
    segments,
    remaining: Math.max(0, segments * perSegment - units),
  };
}
