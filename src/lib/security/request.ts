/**
 * Request metadata for the audit log.
 *
 * Spec §7: every audit entry carries "timestamp, IP, and user agent".
 */

/**
 * Client IP.
 *
 * On Vercel, `x-forwarded-for` is set by the platform and the LEFTMOST entry is
 * the real client. Never trust this header on an origin that is not behind a
 * trusted proxy — anyone can send it.
 */
export function getClientIp(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return headers.get('x-real-ip')?.trim() ?? null;
}

/** User agent, truncated to the audit column width. */
export function getUserAgent(headers: Headers): string | null {
  const ua = headers.get('user-agent');
  return ua ? ua.slice(0, 512) : null;
}

export type RequestContext = {
  ip: string | null;
  userAgent: string | null;
};

export function requestContext(headers: Headers): RequestContext {
  return { ip: getClientIp(headers), userAgent: getUserAgent(headers) };
}
