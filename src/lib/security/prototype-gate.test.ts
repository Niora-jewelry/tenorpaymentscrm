/**
 * The prototype gate is a security boundary, so it gets tested like one.
 *
 * The property that matters most is not "the right code works" — it is that
 * every OTHER path fails closed: no code configured, a short code, an empty
 * cookie, a prefix of the real code.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isPrototypeUnlocked, prototypeAccessCode } from './prototype-gate';

const REAL = 'Kq7wPzN4mVx2Ld9bTr6Y';   // 20 chars
const ORIGINAL = process.env.PROTOTYPE_ACCESS_CODE;

function setCode(value: string | undefined) {
  if (value === undefined) delete process.env.PROTOTYPE_ACCESS_CODE;
  else process.env.PROTOTYPE_ACCESS_CODE = value;
}

afterEach(() => setCode(ORIGINAL));

describe('prototypeAccessCode', () => {
  it('is null when unset — the prototype is off by default', () => {
    setCode(undefined);
    expect(prototypeAccessCode()).toBeNull();
  });

  it('is null when blank or whitespace', () => {
    setCode('');
    expect(prototypeAccessCode()).toBeNull();
    setCode('        ');
    expect(prototypeAccessCode()).toBeNull();
  });

  it('REFUSES a code shorter than 16 characters', () => {
    // The failure mode this guards against is somebody setting "demo123" and
    // believing the prototype is protected. Too short is treated as absent,
    // which 404s the prototype rather than making it guessable.
    setCode('short');
    expect(prototypeAccessCode()).toBeNull();
    setCode('123456789012345'); // 15
    expect(prototypeAccessCode()).toBeNull();
    setCode('1234567890123456'); // 16 — the floor
    expect(prototypeAccessCode()).toBe('1234567890123456');
  });

  it('trims surrounding whitespace, which a copy-paste often carries', () => {
    setCode(`  ${REAL}\n`);
    expect(prototypeAccessCode()).toBe(REAL);
  });
});

describe('isPrototypeUnlocked', () => {
  it('accepts the exact code', () => {
    setCode(REAL);
    expect(isPrototypeUnlocked(REAL)).toBe(true);
  });

  it('rejects everything else', () => {
    setCode(REAL);
    expect(isPrototypeUnlocked(undefined)).toBe(false);
    expect(isPrototypeUnlocked(null)).toBe(false);
    expect(isPrototypeUnlocked('')).toBe(false);
    expect(isPrototypeUnlocked('wrong')).toBe(false);
    expect(isPrototypeUnlocked(REAL.toLowerCase())).toBe(false);
    expect(isPrototypeUnlocked(` ${REAL}`)).toBe(false);
    // A prefix must not pass — the compare runs over the whole string.
    expect(isPrototypeUnlocked(REAL.slice(0, -1))).toBe(false);
    expect(isPrototypeUnlocked(`${REAL}x`)).toBe(false);
  });

  it('rejects even a correct candidate when no code is configured', () => {
    // Otherwise removing the variable would leave anyone holding an old cookie
    // still inside, and "delete the variable to close it" would be a lie.
    setCode(undefined);
    expect(isPrototypeUnlocked(REAL)).toBe(false);
  });

  it('rejects a candidate matching a too-short configured code', () => {
    setCode('demo1234');
    expect(isPrototypeUnlocked('demo1234')).toBe(false);
  });
});
