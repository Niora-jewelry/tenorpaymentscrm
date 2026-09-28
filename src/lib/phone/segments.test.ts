import { describe, expect, it } from 'vitest';
import { segmentInfo } from './segments';

describe('segmentInfo', () => {
  it('an empty body costs nothing', () => {
    const s = segmentInfo('');
    expect(s.segments).toBe(0);
    expect(s.units).toBe(0);
  });

  it('plain text stays GSM-7 and fits 160 in one segment', () => {
    const s = segmentInfo('a'.repeat(160));
    expect(s.encoding).toBe('gsm');
    expect(s.units).toBe(160);
    expect(s.segments).toBe(1);
    expect(s.remaining).toBe(0);
  });

  it('the 161st GSM character costs a second segment, and the limit drops to 153', () => {
    const s = segmentInfo('a'.repeat(161));
    expect(s.segments).toBe(2);
    expect(s.perSegment).toBe(153);
    // Two concatenated segments carry 306, so 145 remain.
    expect(s.remaining).toBe(306 - 161);
  });

  /*
   * The case this function exists for. A curly apostrophe is invisible to the
   * writer and to `length`, but it forces UCS-2 and cuts the single-segment
   * limit from 160 to 70 — turning one text into three.
   */
  it('one non-GSM character re-encodes the whole message', () => {
    const straight = segmentInfo("It's here");
    expect(straight.encoding).toBe('gsm');

    const curly = segmentInfo('It’s here');
    expect(curly.encoding).toBe('ucs2');
    expect(curly.units).toBe(9);
    expect(curly.segments).toBe(1);
  });

  it('a curly apostrophe turns a one-segment text into three', () => {
    const body = 'a'.repeat(159);
    expect(segmentInfo(body).segments).toBe(1);
    expect(segmentInfo(body + '’').segments).toBe(3);
  });

  it('GSM extended characters cost two units each', () => {
    // 80 braces = 160 units = still one segment, though length is only 80.
    const s = segmentInfo('{'.repeat(80));
    expect(s.encoding).toBe('gsm');
    expect(s.units).toBe(160);
    expect(s.segments).toBe(1);

    const over = segmentInfo('{'.repeat(81));
    expect(over.units).toBe(162);
    expect(over.segments).toBe(2);
  });

  it('the euro sign is GSM extended, not a UCS-2 trigger', () => {
    const s = segmentInfo('€100');
    expect(s.encoding).toBe('gsm');
    expect(s.units).toBe(5); // 2 for the euro, 3 digits
  });

  it('an emoji is two UCS-2 units, counted by code point', () => {
    const s = segmentInfo('\u{1F600}');
    expect(s.encoding).toBe('ucs2');
    expect(s.units).toBe(2);
    expect(s.segments).toBe(1);
  });

  /*
   * Mixed content must not keep charging the GSM escape price for a brace once
   * the message has already fallen back to UCS-2, where a brace is one unit.
   */
  it('an escaped GSM character stops costing two once UCS-2 takes over', () => {
    const s = segmentInfo('{\u{1F600}');
    expect(s.encoding).toBe('ucs2');
    expect(s.units).toBe(3); // brace 1 + emoji 2, NOT 2 + 2
  });

  it('UCS-2 gives 70 in one segment and 67 per segment after that', () => {
    expect(segmentInfo('中'.repeat(70)).segments).toBe(1);
    const s = segmentInfo('中'.repeat(71));
    expect(s.segments).toBe(2);
    expect(s.perSegment).toBe(67);
  });

  it('newlines and carriage returns are ordinary GSM characters', () => {
    const s = segmentInfo('line one\nline two');
    expect(s.encoding).toBe('gsm');
    expect(s.units).toBe(17);
  });
});
