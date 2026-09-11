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
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
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
 */
function contentSecurityPolicy(): string {
  const supabaseOrigin = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseWs = supabaseOrigin.replace(/^https:/, 'wss:');

  return [
    "default-src 'self'",
    // Next.js requires 'unsafe-inline' for its bootstrap in dev; tighten to a
    // nonce once the app shell settles.
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    `connect-src 'self' ${supabaseOrigin} ${supabaseWs}`.trim(),
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

  experimental: {
    // Server Actions are only accepted from these origins — the Origin/Host
    // check that closes CSRF alongside SameSite=Lax cookies.
    serverActions: {
      allowedOrigins: [
        new URL(process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').host,
      ],

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
