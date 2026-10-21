/**
 * The only way Email module code writes to the server log.
 *
 * Two rules, enforced here so no call site has to remember them:
 *   1. Secrets never reach a log line — metadata goes through the audit
 *      redactor, and any string that looks like a JWT or a long opaque token
 *      is replaced too.
 *   2. Mail CONTENT never reaches a log line. A subject, a body or an address
 *      is private correspondence; logs carry ids, codes, counts and durations.
 *      Keys that name content are dropped outright.
 *
 * `noSecretLogging.test.ts` fails the build if any file under the module
 * calls `console.*` directly.
 */
import { redactMetadata, REDACTED } from '@/lib/audit/redact';

const CONTENT_KEYS = /^(subject|body|bodyhtml|body_html|bodytext|preview|html|text|from|to|cc|bcc|address|email|recipients?|sender|displayname|name)$/i;
const JWT = /^eyJ[\w-]{10,}\.[\w-]+\.[\w-]*$/;

function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4) return REDACTED;
  if (typeof value === 'string') {
    if (JWT.test(value)) return REDACTED;
    if (value.length >= 200 && !/\s/.test(value)) return REDACTED;
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (CONTENT_KEYS.test(k)) continue;
      out[k] = scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * The shared redactor hides any key containing "code" (OTP and OAuth codes).
 * The engine's `code` is a classified error name (`send_as_denied`), which the
 * runbook needs to see — so a short snake_case value is carried as `reason`.
 * Anything else under `code` (an OAuth code, say) still meets the redactor.
 */
const ERROR_CLASS = /^[a-z][a-z0-9_]{1,40}$/;
function classifiedCodes(meta: Record<string, unknown>): Record<string, unknown> {
  if (typeof meta.code !== 'string' || !ERROR_CLASS.test(meta.code)) return meta;
  const { code, ...rest } = meta;
  return { reason: code, ...rest };
}

export function sanitizeLogMeta(meta: Record<string, unknown> = {}): Record<string, unknown> {
  return scrub(redactMetadata(classifiedCodes(meta))) as Record<string, unknown>;
}

export function mailLog(
  level: 'info' | 'warn' | 'error',
  area: string,
  event: string,
  meta: Record<string, unknown> = {},
): void {
  const line = `[mail:${area}] ${event}`;
  const safe = sanitizeLogMeta(meta);
  // The single sanctioned console sink for the module (see moduleGuards.test.ts).
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.info)(line, safe);
}
