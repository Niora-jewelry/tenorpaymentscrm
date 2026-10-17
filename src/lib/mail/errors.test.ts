import { describe, it, expect } from 'vitest';
import { classifyGraphError, retryAfterSeconds } from './errors';

describe('classifyGraphError', () => {
  it('a 401 means refresh the access token once — not a broken connection', () => {
    expect(classifyGraphError({ status: 401, code: 'InvalidAuthenticationToken' })).toMatchObject({
      code: 'token_expired', reaction: 'refresh',
    });
  });

  it.each(['AADSTS70008', 'AADSTS70000', 'AADSTS50173', 'AADSTS700082', 'AADSTS50076'])(
    'invalid_grant %s breaks the connection', (ad) => {
      expect(classifyGraphError({ status: 400, code: 'invalid_grant', message: `${ad}: The refresh token has expired` }))
        .toMatchObject({ code: 'reconnect_required', connection: 'broken' });
    });

  it('an expired client secret is OUR configuration, not the user\'s connection', () => {
    const c = classifyGraphError({ status: 401, code: 'invalid_client', message: 'AADSTS7000222: The provided client secret keys are expired.' });
    expect(c.code).toBe('app_secret_invalid');
    expect(c.connection).toBeUndefined();
  });

  it('missing consent', () => {
    expect(classifyGraphError({ status: 400, code: 'invalid_grant', message: 'AADSTS65001: The user or administrator has not consented' }).code)
      .toBe('consent_required');
  });

  it('429 honours Retry-After, capped at 300 s', () => {
    expect(classifyGraphError({ status: 429, code: 'ApplicationThrottled', retryAfter: '7' })).toMatchObject({
      code: 'throttled', reaction: 'backoff', retryAfterSeconds: 7,
    });
    expect(classifyGraphError({ status: 429, retryAfter: '9999' }).retryAfterSeconds).toBe(300);
    expect(classifyGraphError({ status: 429 }).retryAfterSeconds).toBe(10);
  });

  it('503 with Retry-After is throttling; without it is an outage', () => {
    expect(classifyGraphError({ status: 503, retryAfter: '5' }).code).toBe('throttled');
    expect(classifyGraphError({ status: 503 }).code).toBe('provider_down');
    expect(classifyGraphError({ status: 0 }).code).toBe('provider_down');
  });

  it('403 access denied on a mailbox breaks that connection; other 403s mean a missing scope', () => {
    expect(classifyGraphError({ status: 403, code: 'ErrorAccessDenied' })).toMatchObject({ code: 'mailbox_access_removed', connection: 'broken' });
    expect(classifyGraphError({ status: 403, code: 'Forbidden' })).toMatchObject({ code: 'scope_missing', connection: 'degraded' });
  });

  it('404 on an item tombstones it; 404 on the mailbox breaks the connection', () => {
    expect(classifyGraphError({ status: 404, code: 'ErrorItemNotFound' })).toMatchObject({ code: 'not_found', reaction: 'tombstone' });
    expect(classifyGraphError({ status: 404, code: 'MailboxNotEnabledForRESTAPI' })).toMatchObject({ code: 'mailbox_not_found', connection: 'broken' });
  });

  it('409/412 means Outlook changed it first: refetch, Outlook wins', () => {
    expect(classifyGraphError({ status: 412, code: 'ErrorIrresolvableConflict' })).toMatchObject({ code: 'conflict', reaction: 'refetch' });
    expect(classifyGraphError({ status: 409, code: 'ErrorFolderExists' }).code).toBe('conflict');
  });

  it.each([
    ['ErrorMessageSizeExceeded', 'too_large'],
    ['ErrorSendAsDenied', 'send_as_denied'],
    ['ErrorSubmissionQuotaExceeded', 'send_quota'],
    ['ErrorInvalidRecipients', 'bad_recipient'],
    ['ErrorInvalidRule', 'rule_rejected'],
  ])('send/rule code %s → %s', (code, expected) => {
    expect(classifyGraphError({ status: 400, code }).code).toBe(expected);
  });

  it('keeps Graph\'s code as detail for the details toggle', () => {
    expect(classifyGraphError({ status: 418, code: 'SomethingNew' })).toEqual({ code: 'unknown', reaction: 'none', detail: 'SomethingNew' });
  });
});

describe('retryAfterSeconds', () => {
  it('reads seconds and HTTP dates', () => {
    expect(retryAfterSeconds('12')).toBe(12);
    expect(retryAfterSeconds(new Date(Date.now() + 30_000).toUTCString())).toBeGreaterThanOrEqual(28);
    expect(retryAfterSeconds('garbage')).toBe(10);
  });
});
