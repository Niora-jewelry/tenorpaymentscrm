/**
 * Twilio Voice SDK errors, translated into something a person can act on.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────
 * The SDK's own messages name the symptom and hide the cause. Three real
 * examples from getting this working, in order:
 *
 *   UnknownError (31000): An unknown error has occurred.
 *     → actually a Content-Security-Policy header blocking Twilio's WebSocket.
 *
 *   PermissionDeniedError (31401): The browser or end-user denied permissions
 *   to user media.
 *     → actually a Permissions-Policy header disabling the microphone for our
 *       own origin. It blames the browser and the user, neither of which did
 *       anything.
 *
 *   ConnectionError (31005): Error sent from gateway in HANGUP.
 *     → actually Twilio failing to fetch TwiML, because the TwiML App's Voice
 *       URL still pointed at a tunnel that no longer existed.
 *
 * In every case someone went looking in the wrong place. A message that says
 * what to check is worth more than one that is technically accurate.
 *
 * ── THE CODE IS ALWAYS KEPT ──────────────────────────────────────────────
 * Every message ends with the raw code. Twilio's documentation is searchable by
 * number, and a support conversation needs it. Explaining the error is not a
 * reason to hide what it was.
 */

export type PhoneErrorKind = 'config' | 'permission' | 'network' | 'call' | 'unknown';

export type PhoneError = {
  /** One sentence, plain, for the person looking at the screen. */
  message: string;
  /** What to do next, when there is something to do. */
  hint?: string;
  kind: PhoneErrorKind;
  code: number | null;
};

/**
 * Codes we have either hit or can confidently name.
 *
 * Deliberately not exhaustive — Twilio publishes hundreds, and guessing at
 * wording for one nobody has seen produces confident nonsense. Anything absent
 * falls through to the raw message plus its code, which is honest.
 */
const KNOWN: Record<number, Omit<PhoneError, 'code'>> = {
  // ── Configuration ──────────────────────────────────────────────────────
  31005: {
    message: 'Twilio could not reach this app to get call instructions.',
    hint:
      "Check the TwiML App's Voice Request URL in the Twilio console — it must point at this deployment's /api/twilio/voice.",
    kind: 'config',
  },
  31008: {
    message: 'The call was rejected by Twilio.',
    hint: 'Usually the caller ID is not a number this account owns, or the destination is blocked.',
    kind: 'config',
  },
  21215: {
    message: 'This Twilio account is not permitted to call that country.',
    hint: 'Geographic permissions are set per region in the Twilio console under Voice → Geo permissions.',
    kind: 'config',
  },

  // ── Microphone ─────────────────────────────────────────────────────────
  31401: {
    message: 'The browser would not give the page access to your microphone.',
    hint:
      'Allow the microphone for this site, then reload. If no prompt appeared, the site may be remembered as blocked — check the icon to the left of the address bar.',
    kind: 'permission',
  },
  31208: {
    message: 'Microphone access was declined.',
    hint: 'Allow the microphone for this site and try again.',
    kind: 'permission',
  },
  31402: {
    message: 'Your microphone could not be opened.',
    hint: 'Another application may be using it. Close anything else that records audio, then reload.',
    kind: 'permission',
  },

  // ── Token / session ────────────────────────────────────────────────────
  20101: {
    message: 'The phone session is not valid.',
    hint: 'Reload the page to get a fresh one.',
    kind: 'config',
  },
  31204: {
    message: 'The phone session is not valid.',
    hint: 'Reload the page to get a fresh one.',
    kind: 'config',
  },
  31205: {
    message: 'The phone session expired.',
    hint: 'Reload the page to reconnect.',
    kind: 'config',
  },

  // ── Transport ──────────────────────────────────────────────────────────
  31000: {
    message: 'The phone could not connect to Twilio.',
    hint:
      "Usually a network or firewall block on Twilio's WebSocket. If it started after a deploy, check the Content-Security-Policy connect-src header.",
    kind: 'network',
  },
  31009: {
    message: 'The connection to Twilio dropped.',
    hint: 'Check your internet connection and reload.',
    kind: 'network',
  },
  31003: {
    message: 'The call could not establish an audio path.',
    hint: 'A restrictive firewall or VPN is the usual cause — it blocks the media ports WebRTC needs.',
    kind: 'network',
  },
  53000: {
    message: 'The connection to Twilio was lost.',
    hint: 'Reload the page to reconnect.',
    kind: 'network',
  },

  // ── The call itself — not faults ───────────────────────────────────────
  31486: { message: 'That number is busy.', kind: 'call' },
  31480: { message: 'That number is temporarily unavailable.', kind: 'call' },
  31603: { message: 'The call was declined.', kind: 'call' },
  31404: { message: 'That number could not be reached.', hint: 'Check the number and try again.', kind: 'call' },
};

/** Pull a Twilio numeric code out of whatever the SDK threw. */
function codeOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null) {
    const candidate = (error as { code?: unknown }).code;
    if (typeof candidate === 'number') return candidate;
    if (typeof candidate === 'string' && /^\d+$/.test(candidate)) return Number(candidate);
  }
  // Some paths only ever hand us a formatted string: "ConnectionError (31005): …"
  const text = messageOf(error);
  const match = /\((\d{4,5})\)/.exec(text);
  return match ? Number(match[1]) : null;
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/**
 * Translate anything the phone throws.
 *
 * Also accepts our OWN string codes from `/api/twilio/token`, so one function
 * covers every error the phone surfaces and the UI has a single thing to call.
 */
export function describePhoneError(error: unknown): PhoneError {
  const raw = messageOf(error);

  // Our own token-route codes, which are not Twilio's.
  if (raw === 'no_phone_number_assigned') {
    return {
      message: 'You have no phone number assigned.',
      hint: 'An administrator can assign one under Admin → Phone numbers.',
      kind: 'config',
      code: null,
    };
  }
  if (raw === 'phone_not_permitted') {
    return {
      message: 'Your permissions do not include the phone.',
      hint: 'Ask an administrator about the Communication → Phone subtab.',
      kind: 'config',
      code: null,
    };
  }
  if (raw === 'twilio_not_configured') {
    return {
      message: 'Telephony is not configured on this deployment.',
      hint: 'The Twilio environment variables are missing.',
      kind: 'config',
      code: null,
    };
  }
  if (raw === 'unauthenticated') {
    return { message: 'Your session has expired.', hint: 'Reload the page to sign in again.', kind: 'config', code: null };
  }

  const code = codeOf(error);
  const known = code != null ? KNOWN[code] : undefined;

  if (known) return { ...known, code };

  // Unknown: keep Twilio's own words rather than inventing better ones, and
  // keep the code so it can be looked up.
  return {
    message: raw || 'The phone ran into a problem.',
    kind: 'unknown',
    code,
  };
}

/** One line, for somewhere too small to show a hint. */
export function phoneErrorLine(error: unknown): string {
  const described = describePhoneError(error);
  return described.code ? `${described.message} (${described.code})` : described.message;
}
