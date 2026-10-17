/**
 * What a Microsoft failure MEANS, decided in one place.
 *
 * The engine, the send pipeline and every action route ask
 * `classifyGraphError` and act on its answer, so "is this a broken
 * connection or a busy server?" is never decided twice, differently. The
 * user-facing sentences live in `messages.ts`; this file only names the case
 * and the right reaction.
 *
 * Pure, so every mapping is unit-tested against real Graph error bodies.
 */

export type MailErrorCode =
  | 'token_expired'          // 401 on a Graph call: refresh once, retry once
  | 'reconnect_required'     // refresh token dead (invalid_grant / AADSTS…)
  | 'consent_required'       // AADSTS65001: the app is not consented
  | 'app_secret_invalid'     // AADSTS7000215/7000222: our client secret
  | 'scope_missing'          // 403 for a feature whose scope was not granted
  | 'mailbox_access_removed' // 403 on a shared mailbox the scope covers
  | 'mailbox_not_found'      // the mailbox itself is gone / not REST-enabled
  | 'not_found'              // one item is gone
  | 'conflict'               // 409/412: Outlook changed it first
  | 'throttled'              // 429, or 503 with Retry-After
  | 'provider_down'          // 5xx, network, timeout
  | 'too_large'
  | 'send_as_denied'
  | 'send_quota'
  | 'bad_recipient'
  | 'rule_rejected'
  | 'unknown';

export type Reaction = 'refresh' | 'backoff' | 'reschedule' | 'refetch' | 'tombstone' | 'none';

export type Classified = {
  code: MailErrorCode;
  reaction: Reaction;
  /** What happens to the connection that made the call. */
  connection?: 'broken' | 'degraded';
  /** Seconds to wait, when the error says so. */
  retryAfterSeconds?: number;
  /** Graph's own error code, kept for the details toggle — never shown raw. */
  detail?: string;
};

export type GraphErrorInput = {
  /** HTTP status, or 0 for a network failure / timeout. */
  status: number;
  /** `error.code` from a Graph body, or the OAuth `error` field. */
  code?: string | null;
  /** `error_description` / `error.message`, scanned for AADSTS numbers. */
  message?: string | null;
  retryAfter?: string | null;
};

const RECONNECT_AADSTS = ['70000', '70008', '50076', '50079', '50173', '53000', '700082', '700084', '50078'];
const SECRET_AADSTS = ['7000215', '7000222'];

export function retryAfterSeconds(header: string | null | undefined, fallback = 10, cap = 300): number {
  if (!header) return fallback;
  const n = Number(header);
  if (Number.isFinite(n) && n >= 0) return Math.min(Math.ceil(n), cap);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(0, Math.ceil((date - Date.now()) / 1000)), cap);
  return fallback;
}

function aadsts(message: string | null | undefined): string | null {
  return message?.match(/AADSTS(\d+)/)?.[1] ?? null;
}

export function classifyGraphError(e: GraphErrorInput): Classified {
  const code = e.code ?? '';
  const ad = aadsts(e.message);
  const detail = [code, ad ? `AADSTS${ad}` : null].filter(Boolean).join(' ') || undefined;

  // ── token endpoint ────────────────────────────────────────────────────
  if (ad && SECRET_AADSTS.includes(ad)) return { code: 'app_secret_invalid', reaction: 'none', detail };
  if (ad === '65001' || code === 'consent_required') {
    return { code: 'consent_required', reaction: 'none', connection: 'broken', detail };
  }
  if (code === 'invalid_grant' || code === 'interaction_required' || (ad && RECONNECT_AADSTS.includes(ad))) {
    return { code: 'reconnect_required', reaction: 'none', connection: 'broken', detail };
  }

  // ── send-specific Exchange codes (checked before the generic statuses) ─
  if (code === 'ErrorMessageSizeExceeded' || code === 'ErrorAttachmentSizeLimitExceeded' || e.status === 413) {
    return { code: 'too_large', reaction: 'none', detail };
  }
  if (code === 'ErrorSendAsDenied') return { code: 'send_as_denied', reaction: 'none', detail };
  if (code === 'ErrorSubmissionQuotaExceeded' || code === 'ErrorMessageSubmissionBlocked' || code === 'ErrorQuotaExceeded') {
    return { code: 'send_quota', reaction: 'none', detail };
  }
  if (code === 'ErrorInvalidRecipients' || code === 'ErrorInvalidRecipient') {
    return { code: 'bad_recipient', reaction: 'none', detail };
  }
  if (code === 'ErrorInvalidRule' || code === 'ErrorRulesOverQuota') return { code: 'rule_rejected', reaction: 'none', detail };

  // ── statuses ──────────────────────────────────────────────────────────
  if (e.status === 401) return { code: 'token_expired', reaction: 'refresh', detail };
  if (e.status === 429 || (e.status === 503 && e.retryAfter)) {
    return { code: 'throttled', reaction: 'backoff', retryAfterSeconds: retryAfterSeconds(e.retryAfter), detail };
  }
  if (e.status === 403) {
    if (code === 'ErrorAccessDenied' || code === 'Authorization_RequestDenied' || code === 'AccessDenied') {
      return { code: 'mailbox_access_removed', reaction: 'none', connection: 'broken', detail };
    }
    return { code: 'scope_missing', reaction: 'none', connection: 'degraded', detail };
  }
  if (e.status === 404) {
    if (code === 'MailboxNotEnabledForRESTAPI' || code === 'MailboxNotFound' || code === 'ErrorNonExistentMailbox') {
      return { code: 'mailbox_not_found', reaction: 'none', connection: 'broken', detail };
    }
    return { code: 'not_found', reaction: 'tombstone', detail };
  }
  if (e.status === 409 || e.status === 412 || code === 'ErrorIrresolvableConflict' || code === 'ErrorFolderExists') {
    return { code: 'conflict', reaction: 'refetch', detail };
  }
  if (e.status === 0 || e.status >= 500) return { code: 'provider_down', reaction: 'reschedule', detail };

  return { code: 'unknown', reaction: 'none', detail };
}

/** Errors worth retrying the same request for, inside one run. */
export function isTransient(c: Classified): boolean {
  return c.code === 'provider_down' || c.code === 'throttled';
}
