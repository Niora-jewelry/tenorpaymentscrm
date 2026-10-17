/**
 * Session enforcement on every request.
 *
 * Spec §3: "All authenticated routes protected by Next.js middleware validating
 * the session server-side on every request."
 * Spec §6: "Suspended users are rejected by middleware on existing sessions,
 * not merely blocked at login."
 *
 * Design decisions, each deliberate:
 *
 *   DENY BY DEFAULT — the matcher covers everything; a short allowlist names the
 *   public routes. A new page is protected because it exists, not because
 *   somebody remembered to add it.
 *
 *   FAIL CLOSED — any error redirects to /login. A middleware that falls through
 *   on error is worse than no middleware, because it looks like protection.
 *
 *   NO SERVICE-ROLE KEY — this runs on the Edge runtime. It uses the anon key
 *   and the user's own session; the privileged functions it calls derive the
 *   caller from auth.uid() and cannot be pointed at anyone else.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { loginUrlPreserving, safeRedirectPath, DEFAULT_REDIRECT } from '@/lib/security/redirect';
import {
  isDemoAuthEnabled,
  verifyDemoSessionToken,
  DEMO_COOKIE_NAME,
} from '@/lib/auth/demo-mode';
import {
  isPrototypeUnlocked,
  prototypeAccessCode,
  PROTOTYPE_COOKIE,
  PROTOTYPE_COOKIE_MAX_AGE,
  PROTOTYPE_KEY_PARAM,
} from '@/lib/security/prototype-gate';

/** Routes reachable without a session. Everything else requires one. */
/*
 * The two legal pages are public because a CARRIER REVIEWER opens them from
 * outside, with no account. Two of the three grounds TapDash's A2P
 * registration was rejected on were precisely that the terms and privacy URLs
 * could not be verified, and a login redirect is indistinguishable from the
 * page not existing.
 *
 * They are under `/legal/` and named for SMS deliberately. TapDash already
 * publishes a privacy policy at tapdash.co/privacy-policy; a second page at
 * the same path would be a competing document about the same company, and a
 * reviewer finding two would not know which governs. These supplement that
 * policy rather than replacing it.
 *
 * Both are static, hold no customer data, and make no authenticated read —
 * there is nothing here to protect, only something to publish.
 */
const PUBLIC_PATHS = new Set([
  '/login',
  '/signup',
  '/reset-password',
  '/legal/sms-terms',
  '/legal/sms-privacy',
]);

/**
 * Public API endpoints.
 *
 * The signup endpoint MUST be reachable without a session — spec §2: "the
 * signup endpoint is publicly reachable and must reject uninvited emails
 * regardless of what the UI shows." Redirecting it to /login would make that
 * guarantee untestable and would break any non-browser client.
 *
 * These carry their own protection: the invite check, Zod validation, and
 * per-email/per-IP rate limiting. Listed explicitly rather than as an `/api/*`
 * wildcard, so any future endpoint is private by default.
 */
const PUBLIC_API_PATHS = new Set([
  '/api/auth/signup',

  /*
   * ── Email sync heartbeat ─────────────────────────────────────────────
   * Vercel Cron calls this every minute with no user session. The route's
   * constant-time `Authorization: Bearer $CRON_SECRET` check is the
   * authentication, and it refuses when the secret is unset. Listed alone:
   * every other /api/mail path stays session-gated.
   */
  '/api/mail/tick',

  /*
   * ── Twilio webhooks ───────────────────────────────────────────────────
   * Twilio POSTs these server-to-server with NO user session. Without an
   * entry here the proxy redirects the request to /login, Twilio receives
   * login HTML instead of TwiML, reports "Document parse failure", and the
   * feature fails with nothing wrong on our side. Donny's handoff notes say
   * this bit them twice; it is listed as a required checklist item there for
   * that reason.
   *
   * The `X-Twilio-Signature` check inside each route IS the authentication
   * for these paths — HMAC-SHA1 against the account auth token, failing
   * closed when the token is unset.
   *
   * ⚠ LISTED INDIVIDUALLY, NEVER AS AN `/api/twilio` PREFIX. A prefix would
   * also expose /api/twilio/token, which mints call-billing credentials and
   * must stay session-gated. That endpoint is called by our own browser, not
   * by Twilio, and is deliberately absent from this list.
   */
  '/api/twilio/voice',
  '/api/twilio/status',
  '/api/twilio/inbound-status',
  '/api/twilio/recording',
  '/api/twilio/message',
  '/api/twilio/message-status',

  /*
   * The phone menu. Twilio fetches every one of these while a caller is on the
   * line, so each has to be reachable without a session for exactly the reason
   * above — a login redirect here does not fail loudly, it returns HTML where
   * TwiML was expected and the caller hears Twilio's own error message.
   *
   * Listed one by one rather than as `/api/twilio/ivr` for the same reason the
   * block above is: a prefix is a rule that keeps matching things nobody has
   * thought about yet. Each of these is authenticated by the
   * `X-Twilio-Signature` check in `withIvr`, which fails closed.
   */
  '/api/twilio/ivr/entry',
  '/api/twilio/ivr/menu',
  '/api/twilio/ivr/discover',
  '/api/twilio/ivr/hold',
  '/api/twilio/ivr/hold-choice',
  '/api/twilio/ivr/queue-done',
  '/api/twilio/ivr/agent',
  '/api/twilio/ivr/voicemail',
]);

/** Signed-in users are bounced off these to the dashboard. */
const AUTH_ONLY_PATHS = new Set(['/login', '/signup', '/reset-password']);

/**
 * The clickable prototype under /prototype.
 *
 * It holds no real data — every record, message and credential in it is invented
 * in `src/proto/data.ts`, and it never touches Supabase. It is open without a
 * session so the design can be walked through before any account exists.
 *
 * In development it is simply open. In production it is 404 unless
 * PROTOTYPE_ACCESS_CODE is set, and then only to someone holding that code —
 * see `lib/security/prototype-gate.ts` for why it is a 404 rather than a
 * challenge, and why the default is closed.
 */
const PROTOTYPE_PREFIX = '/prototype';

function isPrototypePath(pathname: string): boolean {
  return pathname === PROTOTYPE_PREFIX || pathname.startsWith(`${PROTOTYPE_PREFIX}/`);
}

/**
 * 24 hours, sliding (Decision C). Primary enforcement is the Supabase Auth
 * inactivity timeout; this is the defence-in-depth fallback in case that
 * setting is unavailable on the project's plan.
 */
const IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Slide `last_seen_at` at most once a minute rather than on every request. */
const LAST_SEEN_REFRESH_MS = 60 * 1000;

type SessionState = {
  status: 'active' | 'suspended';
  is_admin: boolean;
  sessions_valid_from: string;
  last_seen_at: string | null;
  deleted_at: string | null;
};

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname) || PUBLIC_API_PATHS.has(pathname) || isPrototypePath(pathname);
}

/**
 * API routes must never be answered with a redirect to an HTML login page — a
 * non-browser client would receive a 200 and a page of markup instead of the
 * error it needs to handle.
 */
function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

/**
 * Reads the `iat` claim from a Supabase access token.
 *
 * Decoding without verifying is safe here: `getUser()` has already validated
 * this token against the auth server on the line above. We only need the
 * issued-at timestamp to compare against the revocation epoch.
 */
function accessTokenIssuedAtMs(accessToken: string | undefined): number | null {
  if (!accessToken) return null;
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json) as { iat?: number };
    return typeof claims.iat === 'number' ? claims.iat * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Decides whether this prototype request gets through.
 *
 * Development: always. Production: only with the access code, supplied once as
 * `?key=` and carried by a cookie afterwards. Everything else is a bare 404 —
 * no "wrong code" message, because that confirms the page exists.
 */
function gatePrototype(request: NextRequest, response: NextResponse): NextResponse {
  if (process.env.NODE_ENV !== 'production') return response;

  // No code configured means the prototype is switched off. Default-closed.
  if (!prototypeAccessCode()) return new NextResponse(null, { status: 404 });

  const fromQuery = request.nextUrl.searchParams.get(PROTOTYPE_KEY_PARAM);

  if (isPrototypeUnlocked(fromQuery)) {
    /*
     * Redirect to the same URL without the key. The code should not sit in the
     * address bar, in browser history, or in the Referer header of every
     * outbound request the page makes.
     */
    const clean = new URL(request.nextUrl);
    clean.searchParams.delete(PROTOTYPE_KEY_PARAM);
    const redirect = NextResponse.redirect(clean);
    redirect.cookies.set(PROTOTYPE_COOKIE, fromQuery!, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: PROTOTYPE_PREFIX,
      maxAge: PROTOTYPE_COOKIE_MAX_AGE,
    });
    return redirect;
  }

  if (isPrototypeUnlocked(request.cookies.get(PROTOTYPE_COOKIE)?.value)) return response;

  return new NextResponse(null, { status: 404 });
}

export async function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const origin = request.nextUrl.origin;

  // The response carries any refreshed session cookies back to the browser.
  let response = NextResponse.next({ request });

  /*
   * The prototype short-circuits before any session work. It reads no user
   * data, so revalidating a Supabase session for it would only add a round trip
   * to Oregon for a page built entirely from a local file.
   */
  if (isPrototypePath(pathname)) return gatePrototype(request, response);

  /**
   * Unauthenticated rejection. Pages get a redirect that preserves where they
   * were going; API routes get a 401 in JSON, because redirecting a programmatic
   * caller to an HTML page hands it a 200 and markup instead of an error.
   */
  const rejectUnauthenticated = () => {
    if (isApiPath(pathname)) {
      return NextResponse.json(
        { status: 'unauthenticated', message: 'Sign in to continue.' },
        { status: 401 },
      );
    }
    return NextResponse.redirect(loginUrlPreserving(`${pathname}${search}`, origin));
  };

  try {
    /*
     * Demo mode — development only. The signed cookie stands in for a Supabase
     * session so the product is clickable before the database exists. Everything
     * below (deny-by-default, fail-closed, API 401s) still applies.
     */
    if (isDemoAuthEnabled()) {
      const demoSession = await verifyDemoSessionToken(
        request.cookies.get(DEMO_COOKIE_NAME)?.value,
      );

      if (!demoSession) {
        if (isPublic(pathname)) return response;
        return rejectUnauthenticated();
      }

      if (AUTH_ONLY_PATHS.has(pathname)) {
        const target = safeRedirectPath(request.nextUrl.searchParams.get('next'), origin);
        return NextResponse.redirect(new URL(target || DEFAULT_REDIRECT, origin));
      }
      return response;
    }

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookiesToSet) {
            for (const { name, value } of cookiesToSet) {
              request.cookies.set(name, value);
            }
            response = NextResponse.next({ request });
            for (const { name, value, options } of cookiesToSet) {
              response.cookies.set(name, value, options);
            }
          },
        },
      },
    );

    // getUser() revalidates against the auth server. getSession() would merely
    // trust the cookie, which is not a check.
    //
    // getUser() and the session_state() RPC are independent round trips —
    // session_state() reads auth.uid() from the request's own JWT server-side
    // (same as every other privileged RPC in this app), it doesn't need the
    // client-decoded `user` object getUser() produces. Running them one after
    // another means EVERY single request in the app — this middleware's
    // matcher covers essentially everything — paid two sequential Supabase
    // round trips before the page even started rendering. Measured directly
    // (temporary timing, removed after use): ~680-950ms sequential, ~270-
    // 300ms once parallelized, against a real production build — the single
    // highest-leverage latency fix in the app, since it applies to literally
    // every request. If there's no valid session, session_state()'s result is
    // simply never looked at — a discarded RPC on the unauthenticated path is
    // a far smaller cost than serializing this pair on every authenticated
    // one; if session_state() itself throws for a sessionless request, the
    // function's own try/catch below fails closed exactly as it already does
    // today.
    const [{ data: userData }, { data: stateRows, error: stateError }] = await Promise.all([
      supabase.auth.getUser(),
      supabase.rpc('session_state'),
    ]);
    const user = userData.user;

    if (!user) {
      if (isPublic(pathname)) return response;
      return rejectUnauthenticated();
    }

    // --- Signed in. Confirm the account is still allowed to hold a session. ---
    if (stateError) {
      // Cannot confirm the account is in good standing -> do not let it through.
      await supabase.auth.signOut();
      return rejectUnauthenticated();
    }

    const state = (stateRows as SessionState[] | null)?.[0];

    // No profile, suspended, or soft-deleted: kill the session immediately.
    if (!state || state.status !== 'active' || state.deleted_at !== null) {
      await supabase.auth.signOut();
      const url = new URL('/login', origin);
      url.searchParams.set('reason', 'suspended');
      return NextResponse.redirect(url);
    }

    // Revocation epoch: reject any access token ISSUED BEFORE the last password
    // change. Refresh-token revocation alone would leave an already-issued
    // access token working until it expired — up to an hour after the password
    // changed. Reading `iat` closes that window to seconds.
    const { data: sessionData } = await supabase.auth.getSession();
    const issuedAtMs = accessTokenIssuedAtMs(sessionData.session?.access_token);

    if (issuedAtMs !== null && issuedAtMs < new Date(state.sessions_valid_from).getTime()) {
      await supabase.auth.signOut();
      const url = new URL('/login', origin);
      url.searchParams.set('reason', 'session_revoked');
      return NextResponse.redirect(url);
    }

    // 24h sliding-session fallback.
    const lastSeenMs = state.last_seen_at ? new Date(state.last_seen_at).getTime() : null;
    const now = Date.now();

    if (lastSeenMs !== null && now - lastSeenMs > IDLE_TIMEOUT_MS) {
      await supabase.auth.signOut();
      const url = new URL('/login', origin);
      url.searchParams.set('reason', 'idle');
      return NextResponse.redirect(url);
    }

    if (lastSeenMs === null || now - lastSeenMs > LAST_SEEN_REFRESH_MS) {
      await supabase.rpc('touch_last_seen');
    }

    // An authenticated user has no business on the login or signup screens.
    if (AUTH_ONLY_PATHS.has(pathname)) {
      const next = request.nextUrl.searchParams.get('next');
      const target = safeRedirectPath(next, origin);
      return NextResponse.redirect(new URL(target || DEFAULT_REDIRECT, origin));
    }

    return response;
  } catch {
    // Fail closed. Never fall through to the page on error.
    if (isPublic(pathname)) return response;
    return rejectUnauthenticated();
  }
}

export const config = {
  matcher: [
    /*
     * Everything except Next.js internals and static files. Note that /login,
     * /signup and /reset-password ARE matched — middleware still runs on them,
     * to redirect an already-authenticated visitor away.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)',
  ],
};
