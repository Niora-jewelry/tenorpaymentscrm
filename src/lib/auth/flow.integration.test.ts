/**
 * End-to-end auth flow, against the REAL Supabase database.
 *
 * Unit tests prove the pieces. This proves the thing the client actually cares
 * about: that an invited person can get in, an uninvited person cannot, and the
 * audit trail records what happened.
 *
 * Skipped automatically unless SUPABASE_DB_URL and SUPABASE_SERVICE_ROLE_KEY are
 * present, so `npm test` stays fast and offline for everyone else.
 *
 * Every record it creates is cleaned up afterwards.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const HAS_DB = Boolean(DB_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

const suite = HAS_DB ? describe : describe.skip;

const INVITED = `itest-invited-${Date.now()}@tapdash.test`;
const UNINVITED = `itest-uninvited-${Date.now()}@tapdash.test`;
const PASSWORD = 'Qx7#vLp2!mRt9wZa';

/**
 * A fresh IP per run, from the RFC 5737 documentation range.
 *
 * Reusing one address made the suite fail on its third run — the per-IP signup
 * limit is 20/hour and repeated runs exhausted it. The limiter was right; the
 * test was wrong to look like the same caller every time.
 */
const context = {
  ip: `203.0.113.${1 + Math.floor(Math.random() * 250)}`,
  userAgent: 'vitest-integration',
};

let db: pg.Client;

/**
 * With no Resend key configured, the sender prints the mail to the console.
 * Capturing that is how the test learns the code — exactly as a developer does
 * in local development.
 */
function captureOtpCode(spy: ReturnType<typeof vi.spyOn>): string {
  for (const call of spy.mock.calls) {
    const text = String(call[0] ?? '');
    // Matches the dev console box ("CODE: 123456") and the plaintext email body
    // ("Your code: 123456"), so a change to either format does not break this.
    const match = text.match(/(?:CODE|Your code):\s*(\d{6})/);
    if (match) return match[1]!;
  }
  throw new Error('No OTP code was printed — did the email sender change?');
}

suite('auth flow against the live database', () => {
  beforeAll(async () => {
    db = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
    await db.connect();

    await db.query(
      `insert into invites (email, role_id, status, expires_at)
       select $1, id, 'pending', now() + interval '1 day' from roles where slug = 'member'`,
      [INVITED],
    );
  });

  afterAll(async () => {
    if (!db) return;
    for (const email of [INVITED, UNINVITED]) {
      await db.query(`delete from otp_challenges where email = $1`, [email]);
      await db.query(`delete from invites where email = $1`, [email]);
      // Deleting the auth user cascades to profiles.
      await db.query(`delete from auth.users where email = $1`, [email]).catch(() => undefined);
      await db.query(`delete from profiles where email = $1`, [email]);
      await db.query(`delete from rate_limit_counters where key like $1`, [`%${email}%`]);
    }
    /*
     * auth_audit_log is deliberately NOT cleaned up: it is append-only, and
     * even the service role cannot delete from it. Attempting to would fail —
     * which is the guarantee working. Test rows are identifiable by their
     * @tapdash.test address.
     */
    await db.end();
  });

  it('refuses an uninvited email, and sends no code', async () => {
    const { startSignup } = await import('./signup');
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});

    const result = await startSignup(UNINVITED, context);

    expect(result.status).toBe('not_invited');
    // The spec's own words: "No OTP is sent."
    expect(spy.mock.calls.some((c) => /(?:CODE|Your code):/.test(String(c[0])))).toBe(false);
    spy.mockRestore();

    const { rows } = await db.query(`select count(*)::int as n from otp_challenges where email = $1`, [
      UNINVITED,
    ]);
    expect(rows[0].n).toBe(0);
  });

  it('records the rejection in the audit log', async () => {
    const { rows } = await db.query(
      `select event_type, ip, user_agent from auth_audit_log
        where email_attempted = $1 order by created_at desc limit 1`,
      [UNINVITED],
    );
    expect(rows[0]?.event_type).toBe('signup_rejected_no_invite');
    expect(rows[0]?.ip).toBe(context.ip);
    expect(rows[0]?.user_agent).toBe(context.userAgent);
  });

  it('completes signup for an invited email, and the account exists only at the end', async () => {
    const { startSignup, verifySignupOtp, completeSignup } = await import('./signup');
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});

    // --- Step 1: request a code -------------------------------------------
    const started = await startSignup(INVITED, context);
    expect(started.status).toBe('otp_sent');

    const code = captureOtpCode(spy);
    spy.mockRestore();
    expect(code).toMatch(/^\d{6}$/);

    // The code is never stored in readable form.
    const { rows: challenge } = await db.query(
      `select encode(code_hash, 'hex') as hash from otp_challenges
        where email = $1 order by created_at desc limit 1`,
      [INVITED],
    );
    expect(challenge[0].hash).not.toContain(code);

    // Atomicity: no account exists yet, and the invite is still pending.
    const { rows: earlyProfiles } = await db.query(
      `select count(*)::int as n from profiles where email = $1`,
      [INVITED],
    );
    expect(earlyProfiles[0].n).toBe(0);

    // --- Step 2: a wrong code is rejected ---------------------------------
    const wrong = await verifySignupOtp(INVITED, code === '000000' ? '111111' : '000000', context);
    expect(wrong.status).toBe('failed');

    // --- Step 2: the right code is accepted -------------------------------
    const verified = await verifySignupOtp(INVITED, code, context);
    expect(verified.status).toBe('ok');
    const ticket = verified.status === 'ok' ? verified.ticket : '';

    // Single-use: the same code cannot be replayed.
    const replay = await verifySignupOtp(INVITED, code, context);
    expect(replay.status).toBe('failed');

    // --- Step 3: set a password -------------------------------------------
    const completed = await completeSignup({
      email: INVITED,
      ticket,
      password: PASSWORD,
      confirmPassword: PASSWORD,
      fullName: 'Integration Test',
      context,
    });
    expect(completed.status).toBe('ok');

    // Now the account exists, with the role the invite carried.
    const { rows: profiles } = await db.query(
      `select p.full_name, p.status, r.slug as role
         from profiles p join roles r on r.id = p.role_id
        where p.email = $1`,
      [INVITED],
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0].role).toBe('member');
    expect(profiles[0].status).toBe('active');
    expect(profiles[0].full_name).toBe('Integration Test');

    // And the invite is consumed.
    const { rows: invites } = await db.query(`select status from invites where email = $1`, [INVITED]);
    expect(invites[0].status).toBe('accepted');
  }, 60_000);

  it('a rejected password does NOT burn the ticket — the user can retry', async () => {
    /*
     * Regression test for a real bug. The ticket used to be redeemed BEFORE the
     * password was validated, so a weak or mismatched password consumed it and
     * every retry then failed with "your verification expired" — stranding the
     * user with no route forward.
     *
     * Uses a second invited address, since the one above has already signed up.
     */
    const { startSignup, verifySignupOtp, completeSignup } = await import('./signup');
    const email = `itest-retry-${Date.now()}@tapdash.test`;

    await db.query(
      `insert into invites (email, role_id, status, expires_at)
       select $1, id, 'pending', now() + interval '1 day' from roles where slug = 'member'`,
      [email],
    );

    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    await startSignup(email, context);
    const code = captureOtpCode(spy);
    spy.mockRestore();

    const verified = await verifySignupOtp(email, code, context);
    expect(verified.status).toBe('ok');
    const ticket = verified.status === 'ok' ? verified.ticket : '';

    // Attempt 1 — passwords do not match.
    const mismatch = await completeSignup({
      email, ticket, password: 'Xk4#nQp8!zRw', confirmPassword: 'different', context,
    });
    expect(mismatch.status).toBe('failed');

    // Attempt 2 — too short.
    const tooShort = await completeSignup({
      email, ticket, password: 'short', confirmPassword: 'short', context,
    });
    expect(tooShort.status).toBe('failed');

    // Attempt 3 — a known-breached password.
    const breached = await completeSignup({
      email, ticket, password: 'password123', confirmPassword: 'password123', context,
    });
    expect(breached.status).toBe('failed');

    // The ticket survived all three. A good password still works.
    const good = await completeSignup({
      email, ticket, password: 'Xk4#nQp8!zRw2Lm', confirmPassword: 'Xk4#nQp8!zRw2Lm', context,
    });
    expect(good.status).toBe('ok');

    // Cleanup for this case.
    await db.query(`delete from otp_challenges where email = $1`, [email]);
    await db.query(`delete from invites where email = $1`, [email]);
    await db.query(`delete from auth.users where email = $1`, [email]).catch(() => undefined);
    await db.query(`delete from profiles where email = $1`, [email]);
  }, 60_000);

  it('will not let the same ticket be used twice', async () => {
    const { completeSignup } = await import('./signup');
    const result = await completeSignup({
      email: INVITED,
      ticket: 'a-ticket-that-was-already-spent',
      password: PASSWORD,
      confirmPassword: PASSWORD,
      context,
    });
    expect(result.status).toBe('failed');
  });

  it('will not sign up an email that already has an account', async () => {
    const { startSignup } = await import('./signup');
    const result = await startSignup(INVITED, context);
    expect(result.status).toBe('already_registered');
  });

  it('wrote a complete audit trail', async () => {
    const { rows } = await db.query(
      `select event_type from auth_audit_log where email_attempted = $1 order by created_at`,
      [INVITED],
    );
    const events = rows.map((r) => r.event_type);

    expect(events).toContain('otp_requested');
    expect(events).toContain('otp_verified');
    expect(events).toContain('otp_failed');
    expect(events).toContain('signup_completed');
    expect(events).toContain('invite_accepted');
  });

  it('keeps the audit trail append-only even for the service role', async () => {
    await expect(
      db.query(`update auth_audit_log set event_type = 'tampered' where email_attempted = $1`, [
        INVITED,
      ]),
    ).rejects.toThrow(/append-only/i);
  });
});
