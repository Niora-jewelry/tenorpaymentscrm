/**
 * The address of this site, for every link and callback built on the server.
 *
 * `NEXT_PUBLIC_APP_URL` is the configured answer and is used whenever it is
 * sensible. The fallback exists for one specific, silent failure: that variable
 * is localhost in local development, and a deployment that inherits it sends
 * people links pointing at their OWN machine, and sends Microsoft and Twilio
 * callback addresses they will refuse. Nothing errors on our side. The link just
 * opens a browser that fails to connect, which looks like the recipient's problem.
 *
 * So a deployed site refuses a localhost value in favour of its own hostname,
 * which the platform sets and nobody has to remember to. A local production build
 * has no platform hostname, so it keeps its localhost address.
 */
type Source = {
  NEXT_PUBLIC_APP_URL?: string;
  VERCEL_PROJECT_PRODUCTION_URL?: string;
  VERCEL_URL?: string;
  NODE_ENV?: string;
};

// Named one by one: Next inlines `process.env.NEXT_PUBLIC_*` only when written out.
const fromProcess = (): Source => ({
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  VERCEL_PROJECT_PRODUCTION_URL: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  VERCEL_URL: process.env.VERCEL_URL,
  NODE_ENV: process.env.NODE_ENV,
});

const LOCAL_URL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i;

const trimSlashes = (value: string) => value.replace(/\/+$/, '');

function platformOrigin(source: Source): string | null {
  if (source.NODE_ENV !== 'production') return null;
  const host = source.VERCEL_PROJECT_PRODUCTION_URL?.trim() || source.VERCEL_URL?.trim();
  return host ? `https://${trimSlashes(host)}` : null;
}

/** This site's address, or null when nothing says what it is. */
export function publicOrigin(source: Source = fromProcess()): string | null {
  const configured = source.NEXT_PUBLIC_APP_URL?.trim();
  const platform = platformOrigin(source);
  if (platform && (!configured || LOCAL_URL.test(configured))) return platform;
  return configured ? trimSlashes(configured) : null;
}

/** This site's address, with no trailing slash. */
export const appOrigin = (source: Source = fromProcess()): string => publicOrigin(source) ?? 'http://localhost:3000';

/**
 * An address override, unless it points at this machine on a deployed site.
 * Those overrides are for local tunnels, so a live site that has one was handed
 * someone's local settings by mistake.
 */
export function usableOverride(value: string | undefined, source: Source = fromProcess()): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return platformOrigin(source) && LOCAL_URL.test(trimmed) ? undefined : trimmed;
}
