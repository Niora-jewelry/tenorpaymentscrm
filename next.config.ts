import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * The spec makes server-side enforcement the boundary; these headers close the
 * browser-side attack surface around it.
 */
const securityHeaders = [
  // Force HTTPS for two years, subdomains included.
  {
    key: 'Strict-Transport-Security',
    value: 'max-age=63072000; includeSubDomains; preload',
  },
  // The login form must never be embeddable — that is how a fake wrapper page
  // harvests credentials.
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  /*
   * ⚠ `microphone=(self)`, NOT `microphone=()`.
   *
   * An empty allowlist disables the feature for EVERY origin, our own
   * included — so the browser refuses getUserMedia outright, often without
   * even showing the permission prompt, and the Voice SDK reports:
   *
   *   PermissionDeniedError (31401): The browser or end-user denied
   *   permissions to user media.
   *
   * That message blames the browser or the user, which sends you into Chrome's
   * site settings looking for a block that is not there. The block is this
   * header. `(self)` permits our own origin and still denies every embedded
   * third party — which was the point of the directive.
   *
   * Everything else stays fully disabled: the CRM has no use for a camera,
   * location, payment handler or USB device, and an unused capability is one
   * more thing a compromised script could reach for.
   */
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()',
  },
  // Do not leak session identifiers to any cross-origin resource.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
];

/**
 * Content-Security-Policy.
 *
 * `frame-ancestors 'none'` is the header-level clickjacking block.
 * `connect-src` must include the Supabase origin, since the browser client
 * talks to it directly.
 *
 * Ships REPORT-ONLY first. Flip `CSP_ENFORCE=true` once a deploy has run clean,
 * so a missed directive breaks a report rather than the app.
 *
 * Exported only so `next.config.test.ts` can assert the PostHog hosts — Next
 * itself reads nothing but the default export below.
 */
export function contentSecurityPolicy(): string {
  const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseWs = supabaseOrigin.replace(/^https:/, 'wss:');

  /*
   * PostHog needs TWO origins, and missing the second is the trap.
   *
   *   * the API host, for `/e/` and the session-recording payloads
   *     (connect-src), and
   *   * the ASSETS host, because `posthog.init` fetches the recorder itself as
   *     a separate script at runtime (script-src). The main bundle loads fine
   *     without it, `posthog.capture` works, and only replay is missing — so
   *     the symptom is "analytics work but there are no recordings", which
   *     reads like a PostHog project setting rather than our own header.
   *
   * us.i.posthog.com → us-assets.i.posthog.com, eu.i.posthog.com likewise.
   * Both are empty strings when no key is configured, and `.trim()` plus the
   * filter below keeps the directive clean in that case.
   */
  const posthogOrigin = process.env.NEXT_PUBLIC_POSTHOG_KEY
    ? (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? 'https://us.i.posthog.com')
    : '';
  const posthogAssets = posthogOrigin.replace(/^https:\/\/(\w+)\.i\./, 'https://$1-assets.i.');
  // A Set, because a self-hosted or reverse-proxied host does not match the
  // pattern above and would otherwise be listed twice.
  const posthog = [...new Set([posthogOrigin, posthogAssets].filter(Boolean))].join(' ');

  return [
    "default-src 'self'",
    // Next.js requires 'unsafe-inline' for its bootstrap in dev; tighten to a
    // nonce once the app shell settles.
    `script-src 'self' 'unsafe-inline' ${posthog}${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    /*
     * ⚠ TWILIO'S SIGNALLING WEBSOCKET MUST BE HERE OR THE PHONE CANNOT REGISTER.
     *
     * The Voice SDK opens a WebSocket to `chunderw-vpc-gll[-region].twilio.com`
     * and posts telemetry to `eventgw.twilio.com`. With CSP enforced and these
     * missing, `device.register()` fails and the SDK reports
     * `UnknownError (31000): An unknown error has occurred` — which names
     * nothing, points nowhere, and looks like a Twilio fault rather than our
     * own header. It happened exactly once, the day CSP_ENFORCE was turned on,
     * and it cost an afternoon to recognise.
     *
     * The token request still succeeds when this is wrong, which is what makes
     * it so confusing: the dialer shows the user's own number quite happily and
     * then refuses to connect.
     *
     * Wildcarded on purpose — Twilio picks an edge by region
     * (chunderw-vpc-gll-us1, -ie1, -au1 …) and pinning one would break the
     * moment the account's edge changed.
     */
    `connect-src 'self' ${supabaseOrigin} ${supabaseWs} https://*.twilio.com wss://*.twilio.com ${posthog}`.trim(),
    /*
     * Call recordings are played from short-lived Supabase Storage URLs. Without
     * an explicit media-src this falls back to default-src 'self' and every
     * <audio> silently refuses to play — the same class of bug as the line
     * above, just quieter, because it only shows up once a recording exists.
     */
    `media-src 'self' blob: ${supabaseOrigin}`.trim(),
    /*
     * Session replay compresses its payloads in a Web Worker it creates from a
     * blob. Without this it falls back to default-src 'self', the worker is
     * blocked, and recordings stop uploading while everything else keeps
     * working — so only add it when recording is actually on.
     */
    ...(posthog ? ["worker-src 'self' blob:"] : []),
    /*
     * The Email module renders each message body in a sandboxed `srcdoc`
     * iframe — no scripts, no forms — so a mail's HTML can never run in or
     * restyle the CRM. Browsers do not source-match `about:srcdoc` against
     * frame-src, so this changes nothing today; it is here to make the intent
     * explicit and to stop a future tightening of default-src from silently
     * blanking every email. The `sandbox` attribute is the real control.
     */
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  /*
   * The merchant application template is read from disk when an application
   * is sent (`lib/applications/pdf.ts`). It is a runtime read, not an import,
   * so the bundler cannot see it: without this, the deployed function would
   * not carry the file and every Send would fail with "template not installed".
   * Sending happens from a record (`/[module]`'s Server Actions).
   */
  outputFileTracingIncludes: {
    '/[module]': ['./src/lib/applications/template/*.pdf'],
  },

  experimental: {
    /*
     * How many workers `next build` forks to collect page data and prerender.
     * Default: one per CPU, each a full Node process — on a 16 GB laptop with
     * a browser open that is where a local build dies (worker exit 134, after
     * "Compiled successfully"). `NEXT_BUILD_CPUS=1 npm run build` makes it
     * finish; unset (Vercel, CI) keeps Next's default.
     */
    ...(process.env.NEXT_BUILD_CPUS ? { cpus: Number(process.env.NEXT_BUILD_CPUS) } : {}),

    // Server Actions are only accepted from these origins — the Origin/Host
    // check that closes CSRF alongside SameSite=Lax cookies.
    serverActions: {
      /**
       * Server Actions are accepted only from these origins — the Origin/Host
       * check that closes CSRF alongside SameSite=Lax cookies.
       *
       * ⚠ FIRST-DEPLOY TRAP THIS AVOIDS. This list is baked in at BUILD time.
       * On a first Vercel deploy nobody knows the URL yet, so
       * NEXT_PUBLIC_APP_URL is still localhost — and every Server Action on the
       * deployed site is then rejected. The symptom is brutal to diagnose:
       * pages render perfectly, and every button silently does nothing.
       *
       * Vercel injects the deployment's own host as VERCEL_URL and the stable
       * production host as VERCEL_PROJECT_PRODUCTION_URL, both at build time.
       * Including them means the first deploy works before anyone has
       * configured anything, and preview deployments work permanently.
       *
       * NEXT_PUBLIC_APP_URL is still worth setting — Twilio's callbacks are
       * built from it (see lib/twilio/webhook-request.ts) and there is no
       * fallback for that.
       */
      allowedOrigins: [
        new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').host,
        process.env.VERCEL_URL,
        process.env.VERCEL_PROJECT_PRODUCTION_URL,
      ].filter((host): host is string => Boolean(host)),

      /**
       * Uploads travel through a Server Action, so THIS is the real ceiling on
       * file size — not `MAX_FILE_BYTES` in `lib/records/files.ts`.
       *
       * Next's default is 1MB. With it, the 25MB limit the UI promises was
       * unreachable: anything larger was rejected by the framework with a bare
       * 413 ("Body exceeded 1mb limit") before `uploadFileAction` ran at all,
       * so the friendly "over the 25MB limit" message could never be the one a
       * user saw and an ordinary 2MB statement PDF simply failed. The app's own
       * check never got to run.
       *
       * Set above 25MB on purpose, not exactly at it: the request also carries
       * multipart framing and the action's other arguments, and the limit is on
       * the whole body. Leaving headroom keeps `files.ts` the thing that
       * refuses an oversized file, with a sentence that explains itself.
       *
       * ⚠️ A PLATFORM LIMIT SITS UNDER THIS ONE. Vercel caps a serverless
       * function's request body at 4.5MB and that cannot be raised from here —
       * on Vercel, uploads above ~4.5MB will still fail no matter what this
       * says. The fix for that is a different shape: hand the browser a signed
       * upload URL and let it PUT straight to Supabase Storage, so the bytes
       * never cross the Next server. Documented rather than done here because
       * it changes the upload path in three places; this setting is what makes
       * the current path behave correctly everywhere else.
       */
      bodySizeLimit: '32mb',
    },
  },

  async headers() {
    const cspKey =
      process.env.CSP_ENFORCE === 'true'
        ? 'Content-Security-Policy'
        : 'Content-Security-Policy-Report-Only';

    return [
      {
        source: '/:path*',
        headers: [...securityHeaders, { key: cspKey, value: contentSecurityPolicy() }],
      },
    ];
  },
};

export default nextConfig;
