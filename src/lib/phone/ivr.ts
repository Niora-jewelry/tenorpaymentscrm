/**
 * The inbound phone menu, as pure functions.
 *
 * ── WHY EVERY BRANCH IS A FUNCTION THAT RETURNS A STRING ─────────────────
 * An IVR is a state machine whose states are only reachable by telephoning it.
 * Testing it by ringing the number means one branch per call, a human pressing
 * keys, and no way at all to reach "it is 4:59pm on a Friday in January".
 *
 * So nothing here talks to Twilio, to the database, or to the network. Each
 * function takes a configuration object and the caller's input and returns
 * TwiML. The route handlers do the talking; these decide what is said. That
 * makes every path in both of the client's documents an ordinary unit test
 * that runs in `npm test`, including the ones that are awkward to reach by
 * hand — no extensions configured, an invalid key, the third time round the
 * hold loop.
 *
 * ── THE ONE THING THAT IS NOT OBVIOUS: DIGIT COLLECTION ──────────────────
 * The greeting promises two different things at once:
 *
 *   "If you know your party's extension, you may dial it at any time.
 *    For sales inquiries, please press 1."
 *
 * A single-digit <Gather> can never collect a three-digit extension, and a
 * fixed three-digit <Gather> would hang after "1" waiting for two more. So the
 * gather has NO `numDigits` and ends on a short pause or on #. Pressing 1 and
 * waiting collects "1"; typing 101 quickly collects "101". `interpretDigits`
 * then decides which it was, extensions first.
 *
 * This is why extensions must not be 1, 2 or 3 — a single-digit extension
 * would be unreachable behind the menu. The migration allows up to six digits;
 * `interpretDigits` treats a bare 1/2/3 as the menu, always.
 */

export type IvrPromptSlug =
  | 'greeting_open'
  | 'greeting_closed'
  | 'transfer_open'
  | 'transfer_closed'
  | 'high_volume'
  | 'voicemail_prompt'
  | 'voicemail_closed'
  | 'support_transfer'
  | 'discover'
  | 'invalid_entry'
  | 'record_notice';

export type IvrTarget = {
  label: string;
  /** Rings this user's browser softphone. */
  userId: string | null;
  /** Rings a real telephone. */
  externalE164: string | null;
  digits: string | null;
};

export type IvrConfig = {
  voice: string;
  language: string;
  holdMusicUrl: string;
  recordNotice: boolean;
  ringSeconds: number;
  voicemailMaxSeconds: number;
  prompts: Record<IvrPromptSlug, string>;
  /** Absolute origin for callback URLs, e.g. https://crm.example.com */
  origin: string;
};

/** Merchant support, from the During Hours document. */
export const SUPPORT_FORWARD_E164 = '+18004649777';

/** Queue a waiting caller sits in while we ring people. */
export const SALES_QUEUE = 'tapdash-sales';

function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function say(cfg: IvrConfig, text: string): string {
  return `<Say voice="${esc(cfg.voice)}" language="${esc(cfg.language)}">${esc(text)}</Say>`;
}

function xml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

/** Callback URL with the call's own correlation id attached. */
function url(cfg: IvrConfig, path: string, params: Record<string, string | number> = {}): string {
  const qs = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  ).toString();
  return `${cfg.origin}${path}${qs ? `?${qs}` : ''}`;
}

/* ────────────────────────────────────────────────────────────────────────
 * What the caller pressed
 * ──────────────────────────────────────────────────────────────────────── */

export type Interpretation =
  | { kind: 'menu'; digit: '1' | '2' | '3' }
  | { kind: 'extension'; digits: string }
  | { kind: 'none' }
  | { kind: 'invalid'; digits: string };

/**
 * Decide what a collected digit string meant.
 *
 * Order matters. A bare 1, 2 or 3 is ALWAYS the menu, even if someone has
 * configured an extension with those digits — otherwise the menu the greeting
 * just described would stop working, which is the worse failure.
 */
export function interpretDigits(
  digits: string | null | undefined,
  extensions: IvrTarget[],
): Interpretation {
  const d = (digits ?? '').replace(/\D/g, '');
  if (!d) return { kind: 'none' };

  if (d === '1' || d === '2' || d === '3') return { kind: 'menu', digit: d };

  if (extensions.some((e) => e.digits && e.digits === d)) {
    return { kind: 'extension', digits: d };
  }

  return { kind: 'invalid', digits: d };
}

/* ────────────────────────────────────────────────────────────────────────
 * Entry
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * The greeting, open or closed.
 *
 * `timeout` is how long the gather waits after the prompt finishes. The During
 * Hours document says an unanswered menu should "stay on the line" and reach a
 * representative, so a timeout here is not an error — it falls through to the
 * same place pressing 1 would.
 */
export function greetingTwiml(
  cfg: IvrConfig,
  opts: { open: boolean; gatherTimeoutSeconds?: number },
): string {
  const slug: IvrPromptSlug = opts.open ? 'greeting_open' : 'greeting_closed';
  const timeout = opts.gatherTimeoutSeconds ?? 4;

  const notice = cfg.recordNotice ? say(cfg, cfg.prompts.record_notice) : '';

  return xml(
    notice +
      `<Gather input="dtmf" action="${esc(url(cfg, '/api/twilio/ivr/menu'))}" method="POST"` +
      ` timeout="${timeout}" finishOnKey="#">` +
      say(cfg, cfg.prompts[slug]) +
      `</Gather>` +
      /*
       * Reached when the gather times out with nothing pressed. Open hours:
       * "please stay on the line, and one of our representatives will be with
       * you shortly" - so silence means the same as pressing 1. Closed: there
       * is nobody to stay on the line for, so the greeting repeats rather than
       * dropping the caller.
       */
      `<Redirect method="POST">${esc(
        url(cfg, '/api/twilio/ivr/menu', { Digits: opts.open ? '1' : '', timedOut: '1' }),
      )}</Redirect>`,
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Option 2 — merchant support
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Forward to merchant support and let go.
 *
 * Q12 confirmed this is intended: once the call reaches (800) 464-9777 it has
 * left TapDash entirely - not recorded, no voicemail fallback, nothing in the
 * CRM. There is deliberately no `action` on the <Dial>, because there is
 * nothing sensible to do afterwards: the caller is with another company.
 */
export function supportTransferTwiml(cfg: IvrConfig): string {
  return xml(
    say(cfg, cfg.prompts.support_transfer) +
      `<Dial timeout="30"><Number>${esc(SUPPORT_FORWARD_E164)}</Number></Dial>` +
      `<Hangup/>`,
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Option 3 — the Discover settlement
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Read the settlement message, then offer a representative.
 *
 * The document: "If the customer presses 1 or doesn't press anything for 30
 * seconds" the call transfers. Q13 settled the third case - any other key is
 * an invalid entry.
 */
export function discoverTwiml(cfg: IvrConfig): string {
  return xml(
    `<Gather input="dtmf" numDigits="1" action="${esc(
      url(cfg, '/api/twilio/ivr/discover'),
    )}" method="POST" timeout="30">` +
      say(cfg, cfg.prompts.discover) +
      `</Gather>` +
      // Thirty seconds of silence means transfer, exactly as pressing 1 does.
      `<Redirect method="POST">${esc(
        url(cfg, '/api/twilio/ivr/discover', { Digits: '1', timedOut: '1' }),
      )}</Redirect>`,
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * The hold queue
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Put the caller in a queue with music while we ring people.
 *
 * ── WHY A QUEUE AND NOT SIMPLY <Dial> ────────────────────────────────────
 * Both documents are explicit: "There should then be hold music until someone
 * answers." A <Dial> cannot do that — Twilio plays a ringback TONE to the
 * caller while it rings, and there is no way to substitute music. The caller
 * has to be somewhere that can play audio to them, which is what <Enqueue>
 * with a `waitUrl` is.
 *
 * So the caller is enqueued, and the route separately originates calls to
 * everyone who should ring. Whoever answers first dials into the queue and is
 * bridged. That is also what makes the documents' other requirement possible —
 * a message every minute offering voicemail — because the wait loop is our
 * TwiML and can count.
 */
export function enqueueTwiml(cfg: IvrConfig, opts: { closed: boolean }): string {
  const slug: IvrPromptSlug = opts.closed ? 'transfer_closed' : 'transfer_open';
  return xml(
    say(cfg, cfg.prompts[slug]) +
      `<Enqueue waitUrl="${esc(
        url(cfg, '/api/twilio/ivr/hold', { loop: 0, closed: opts.closed ? 1 : 0 }),
      )}" waitUrlMethod="POST"` +
      ` action="${esc(url(cfg, '/api/twilio/ivr/queue-done', { closed: opts.closed ? 1 : 0 }))}"` +
      ` method="POST">${esc(SALES_QUEUE)}</Enqueue>`,
  );
}

/**
 * What a waiting caller hears, one pass at a time.
 *
 * Twilio requests the `waitUrl` repeatedly for as long as the caller waits, so
 * this is a LOOP ITERATION, not the whole wait. `loop` counts how many passes
 * have happened, which is how "after one minute, and every minute after that"
 * is expressed without a timer.
 *
 * ── OPEN AND CLOSED DIVERGE HERE ─────────────────────────────────────────
 * During hours the caller may stay on hold indefinitely: "If the customer does
 * not press anything... This should continue every minute until someone
 * answers." After hours they may not — the document says that if nobody
 * answers within a minute the caller is sent to voicemail, full stop. So the
 * closed path stops looping and the open path does not.
 */
export function holdTwiml(
  cfg: IvrConfig,
  opts: { loop: number; closed: boolean; musicSecondsPerLoop?: number },
): string {
  const perLoop = opts.musicSecondsPerLoop ?? cfg.ringSeconds;
  // Roughly one <Play> per 30s of music; the file is short and loops.
  const plays = Math.max(1, Math.round(perLoop / 30));
  const music = `<Play loop="${plays}">${esc(cfg.holdMusicUrl)}</Play>`;

  // First pass: music only. Nobody is told about high call volume before the
  // minute the documents give them to answer has actually elapsed.
  if (opts.loop === 0) {
    return xml(
      music +
        `<Redirect method="POST">${esc(
          url(cfg, '/api/twilio/ivr/hold', { loop: 1, closed: opts.closed ? 1 : 0 }),
        )}</Redirect>`,
    );
  }

  if (opts.closed) {
    /*
     * After hours, one minute is the whole allowance: "If someone does not
     * answer within 1 minute: Unfortunately, we are unable to take your
     * call..." — so this leaves the queue for voicemail rather than offering a
     * choice. <Leave> hands control to the <Enqueue action>, which is the only
     * way out of a queue that does not hang up on the caller.
     */
    return xml(say(cfg, cfg.prompts.voicemail_closed) + `<Leave/>`);
  }

  return xml(
    `<Gather input="dtmf" numDigits="1" action="${esc(
      url(cfg, '/api/twilio/ivr/hold-choice'),
    )}" method="POST" timeout="5">` +
      say(cfg, cfg.prompts.high_volume) +
      `</Gather>` +
      music +
      // Nothing pressed: round again, and say it again next minute.
      `<Redirect method="POST">${esc(
        url(cfg, '/api/twilio/ivr/hold', { loop: opts.loop + 1, closed: 0 }),
      )}</Redirect>`,
  );
}

/**
 * What an agent's telephone hears when they answer.
 *
 * `<Dial><Queue>` is the other half of the queue: it connects whoever answered
 * to the longest-waiting caller. Everyone else's phone stops ringing by itself,
 * because the queue is then empty.
 */
export function agentTwiml(cfg: IvrConfig): string {
  return xml(
    `<Dial answerOnBridge="true" record="record-from-answer-dual"` +
      ` recordingStatusCallback="${esc(url(cfg, '/api/twilio/recording'))}"` +
      ` recordingStatusCallbackEvent="completed">` +
      `<Queue>${esc(SALES_QUEUE)}</Queue></Dial>`,
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Voicemail
 * ──────────────────────────────────────────────────────────────────────── */

export function voicemailTwiml(
  cfg: IvrConfig,
  opts: { callId?: string | null; closed?: boolean; announce?: boolean },
): string {
  const slug: IvrPromptSlug = opts.closed ? 'voicemail_closed' : 'voicemail_prompt';
  const params: Record<string, string> = { kind: 'voicemail' };
  if (opts.callId) params.callId = opts.callId;

  return xml(
    // Suppressed when the caller has just heard the closed-hours message,
    // which already ends with "leave a message after the beep".
    (opts.announce === false ? '' : say(cfg, cfg.prompts[slug])) +
      `<Record maxLength="${cfg.voicemailMaxSeconds}" playBeep="true" trim="trim-silence"` +
      ` recordingStatusCallback="${esc(url(cfg, '/api/twilio/recording', params))}"` +
      ` recordingStatusCallbackEvent="completed"` +
      ` action="${esc(
        url(cfg, '/api/twilio/inbound-status', {
          phase: 'voicemail-end',
          ...(opts.callId ? { callId: opts.callId } : {}),
        }),
      )}" method="POST"/>` +
      // An action-less <Record> re-requests the entry document and inserts a
      // second call row. Always terminal.
      `<Hangup/>`,
  );
}

/* ────────────────────────────────────────────────────────────────────────
 * Dead ends that must not be dead air
 * ──────────────────────────────────────────────────────────────────────── */

/** Q13: "SAY THAT IS A INVALID ENTRY", then start again. */
export function invalidTwiml(cfg: IvrConfig, opts: { open: boolean }): string {
  return xml(
    say(cfg, cfg.prompts.invalid_entry) +
      `<Redirect method="POST">${esc(url(cfg, '/api/twilio/ivr/entry'))}</Redirect>`,
  );
}

/**
 * Ring one person directly, by extension.
 *
 * Falls back to voicemail on no answer rather than hanging up: a caller who
 * dialled a specific person and got silence would assume the system is broken.
 */
export function extensionTwiml(
  cfg: IvrConfig,
  opts: { target: IvrTarget; callId?: string | null },
): string {
  const dialBody = opts.target.userId
    ? `<Client>user_${esc(opts.target.userId)}</Client>`
    : `<Number>${esc(opts.target.externalE164 ?? '')}</Number>`;

  return xml(
    `<Dial timeout="${cfg.ringSeconds}" answerOnBridge="true" record="record-from-answer-dual"` +
      ` recordingStatusCallback="${esc(url(cfg, '/api/twilio/recording'))}"` +
      ` recordingStatusCallbackEvent="completed">${dialBody}</Dial>` +
      `<Redirect method="POST">${esc(
        url(cfg, '/api/twilio/ivr/voicemail', opts.callId ? { callId: opts.callId } : {}),
      )}</Redirect>`,
  );
}

/**
 * Nobody is configured to ring.
 *
 * Today this is the normal state, not an edge case: the client's answer to
 * "what are the extension numbers" was "WE WILL ADD EXTENSIONS AFTER". A menu
 * that answers and then falls silent is worse than no menu, so this is a
 * defined path straight to voicemail.
 */
export function noTargetsTwiml(cfg: IvrConfig, opts: { closed: boolean }): string {
  return voicemailTwiml(cfg, { closed: opts.closed });
}
