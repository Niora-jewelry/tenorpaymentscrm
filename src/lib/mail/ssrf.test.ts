import { describe, it, expect } from 'vitest';
import { checkUrl, isBlockedAddress, sniffImage, type Lookup } from './ssrf';

const resolvesTo = (...addresses: string[]): Lookup => async () =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
const fails: Lookup = async () => { throw new Error('ENOTFOUND'); };

describe('isBlockedAddress', () => {
  it.each([
    '127.0.0.1', '10.0.0.1', '172.16.5.4', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '198.18.0.1',
    '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1',
    '64:ff9b::a00:1', 'ff02::1', 'not-an-ip',
  ])('blocks %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe('checkUrl', () => {
  it('accepts a public https host and returns the vetted address', async () => {
    const r = await checkUrl('https://cdn.example.com/a.png', resolvesTo('93.184.216.34'));
    expect(r).toMatchObject({ ok: true, address: '93.184.216.34' });
  });

  it.each([
    ['file:///etc/passwd', 'scheme'],
    ['ftp://example.com/a.png', 'scheme'],
    ['javascript:alert(1)', 'scheme'],
    ['https://user:pw@example.com/a.png', 'credentials'],
    ['https://example.com:8080/a.png', 'port'],
    ['http://169.254.169.254/latest/meta-data', 'blocked_address'],
    ['http://[::1]/x', 'blocked_address'],
    ['http://[::ffff:10.0.0.1]/x', 'blocked_address'],
    ['not a url', 'malformed'],
  ])('refuses %s (%s)', async (url, reason) => {
    expect(await checkUrl(url, resolvesTo('93.184.216.34'))).toEqual({ ok: false, reason });
  });

  it('refuses a hostname that resolves to a private address', async () => {
    expect(await checkUrl('https://internal.example.com/x', resolvesTo('10.0.0.5'))).toEqual({ ok: false, reason: 'blocked_address' });
  });

  it('refuses when ANY of several answers is private (no round-robin luck)', async () => {
    expect(await checkUrl('https://mixed.example.com/x', resolvesTo('93.184.216.34', '127.0.0.1'))).toEqual({ ok: false, reason: 'blocked_address' });
  });

  it('refuses a host that does not resolve', async () => {
    expect(await checkUrl('https://nope.invalid/x', fails)).toEqual({ ok: false, reason: 'unresolvable' });
  });
});

describe('sniffImage', () => {
  it('recognises raster formats by their bytes', () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImage(new TextEncoder().encode('GIF89a'))).toBe('image/gif');
    expect(sniffImage(new TextEncoder().encode('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('refuses SVG and HTML whatever the server claims', () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="x()">'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode('<html><script>'))).toBeNull();
  });
});
