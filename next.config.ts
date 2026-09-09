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
