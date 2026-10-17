/**
 * The Content-Security-Policy must name BOTH PostHog hosts, and neither when
 * recording is off.
 *
 * ── WHY THIS IS WORTH A TEST ─────────────────────────────────────────────
 * Session replay fails in a way that does not look like a header problem. The
 * main bundle comes from our own origin, so `posthog.capture` keeps working
 * and the project shows events arriving; the recorder is fetched separately
 * from the ASSETS host, and if that is missing from `script-src` the only
 * symptom is that no replays appear. Anyone debugging that starts in the
 * PostHog project settings, which is the wrong place entirely.
 *
 * The derivation is a regex (`us.i.` → `us-assets.i.`), which is exactly the
 * kind of line that survives a rename of the host and stops producing a real
 * origin without anyone noticing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { contentSecurityPolicy } from '../../next.config';

const KEY = 'NEXT_PUBLIC_POSTHOG_KEY';
const HOST = 'NEXT_PUBLIC_POSTHOG_HOST';
const before = { key: process.env[KEY], host: process.env[HOST] };

afterEach(() => {
  if (before.key === undefined) delete process.env[KEY];
  else process.env[KEY] = before.key;
  if (before.host === undefined) delete process.env[HOST];
  else process.env[HOST] = before.host;
});

/** The one directive, without the others that also mention a host. */
function directive(csp: string, name: string): string {
  return csp.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';
}

describe('CSP and PostHog', () => {
  it('names no PostHog host at all when no key is configured', () => {
    delete process.env[KEY];
    const csp = contentSecurityPolicy();
    expect(csp).not.toContain('posthog');
    // The worker is only needed by the recorder, so it stays shut too.
    expect(csp).not.toContain('worker-src');
  });

  it('allows the API host AND the assets host when a key is configured', () => {
    process.env[KEY] = 'phc_testkeytestkeytestkey';
    delete process.env[HOST];
    const csp = contentSecurityPolicy();

    // The recorder script comes from the assets host.
    expect(directive(csp, 'script-src')).toContain('https://us-assets.i.posthog.com');
    // Events and recording payloads go to the API host.
    expect(directive(csp, 'connect-src')).toContain('https://us.i.posthog.com');
    // Replay compresses in a blob worker.
    expect(csp).toContain("worker-src 'self' blob:");

    // Nothing the app already needed may be displaced by the addition.
    expect(directive(csp, 'connect-src')).toContain('wss://*.twilio.com');
    expect(directive(csp, 'script-src')).toContain("'self'");
  });

  it('derives the assets host for the EU region too', () => {
    process.env[KEY] = 'phc_testkeytestkeytestkey';
    process.env[HOST] = 'https://eu.i.posthog.com';
    expect(directive(contentSecurityPolicy(), 'script-src')).toContain(
      'https://eu-assets.i.posthog.com',
    );
  });

  it('allows same-origin frames for the email reading pane, and still allows data: images', () => {
    const csp = contentSecurityPolicy();
    expect(directive(csp, 'frame-src')).toBe("frame-src 'self'");
    expect(directive(csp, 'img-src')).toContain('data:');
    // Framing BY other sites stays forbidden — a different directive.
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('lists a self-hosted host once, not twice', () => {
    process.env[KEY] = 'phc_testkeytestkeytestkey';
    process.env[HOST] = 'https://analytics.example.com';
    const scriptSrc = directive(contentSecurityPolicy(), 'script-src');
    const occurrences = scriptSrc.split('https://analytics.example.com').length - 1;
    expect(occurrences, 'a host that does not match the pattern was listed twice').toBe(1);
  });
});
