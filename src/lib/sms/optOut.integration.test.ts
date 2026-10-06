/**
 * The opt-out gate, against the real database.
 *
 * ── THE DISTINCTION THIS EXISTS TO PROTECT ───────────────────────────────
 * Two numbers have no live consent row, and they must be treated completely
 * differently on the way out:
 *
 *   never asked   somebody who texted us first and is waiting for a reply.
 *                 Blocking this breaks the product and protects nobody.
 *   replied STOP  a revocation. Texting them is a TCPA violation and a fast
 *                 route to a suspended campaign.
 *
 * `consentStatus` deliberately collapses both into "no", because for a badge
 * they are the same. `isOptedOut` must not, and that is all these tests check.
 *
 * Rolled back. Scratch numbers in the 555-01xx range, which is reserved for
 * fiction and cannot reach a real handset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';

const DB_URL = process.env.SUPABASE_DB_URL;
const suite = DB_URL ? describe : describe.skip;

const NEVER_ASKED = '+15550100001';
const CONSENTED = '+15550100002';
const STOPPED = '+15550100003';

let db: pg.Client;

/**
 * The query `isOptedOut` runs, against the same table.
 *
 * The TypeScript cannot be imported here — it builds a Supabase client that
 * needs a request — so this asserts the RULE on the real rows. If the two ever
 * disagree, the rule is the thing that was specified and this is what says so.
 */
async function optedOut(e164: string): Promise<boolean> {
  const { rows } = await db.query(
    `select count(*) filter (where revoked_at is null)::int  as live,
            count(*) filter (where revoked_at is not null)::int as revoked
       from sms_consents where e164 = $1`,
    [e164],
  );
  /* No ordering. `created_at` is the transaction's start time, so two rows
     written together tie — which is how the first version of this got it
     wrong. See the note on `isOptedOut`. */
  return rows[0].revoked > 0 && rows[0].live === 0;
}

suite('the SMS opt-out gate', () => {
  beforeAll(async () => {
    db = new pg.Client({
      connectionString: DB_URL,
      ssl: { rejectUnauthorized: false },
      statement_timeout: 60_000,
    });
    await db.connect();
    await db.query('BEGIN');

    const consent = (e164: string) =>
      db.query(
        `select record_sms_consent($1, 'test consent wording', 'web_form'::sms_consent_source)`,
        [e164],
      );

    await consent(CONSENTED);
    await consent(STOPPED);
    await db.query(`select revoke_sms_consent($1, 'replied STOP')`, [STOPPED]);
  });

  afterAll(async () => {
    if (!db) return;
    await db.query('ROLLBACK');
    await db.end();
  });

  /*
   * The one that would break the product if it got this wrong. Most people a
   * rep texts have never filled in a form — consent for a reply is the inbound
   * message itself.
   */
  it('a number with no record is NOT opted out', async () => {
    expect(await optedOut(NEVER_ASKED)).toBe(false);
  });

  it('a number that consented is not opted out', async () => {
    expect(await optedOut(CONSENTED)).toBe(false);
  });

  it('a number that replied STOP IS opted out', async () => {
    expect(await optedOut(STOPPED)).toBe(true);
  });

  /*
   * START after STOP has to work, or a person who opts back in is permanently
   * unreachable — and the inbound webhook calls `recordConsent` for exactly
   * this. A new row is written rather than the revocation being erased, so the
   * audit trail keeps both facts.
   */
  it('a number that replied START after STOP can be texted again', async () => {
    /*
     * `verbal`, because that is what the inbound webhook writes for a START
     * reply — the enum is (web_form, verbal, paperwork, imported) and carries
     * no texting value, so the route records the source it has and explains
     * itself in the note. The test uses the real path's value rather than a
     * tidier one that does not exist.
     */
    await db.query(
      `select record_sms_consent($1, 'replied START', 'verbal'::sms_consent_source)`,
      [STOPPED],
    );

    expect(await optedOut(STOPPED)).toBe(false);

    /* And the revocation is still on file — consent history is append-only. */
    const { rows } = await db.query(
      `select count(*) filter (where revoked_at is not null)::int revoked,
              count(*)::int total
         from sms_consents where e164 = $1`,
      [STOPPED],
    );
    expect(rows[0].revoked).toBe(1);
    expect(rows[0].total).toBe(2);
  });

  /*
   * The status function used by the badge agrees on the live row, which is the
   * other half: a number that opted back in should read as consented, not as
   * "no record".
   */
  it('the badge agrees that the re-consented number is live', async () => {
    const { rows } = await db.query(`select * from sms_consent_status($1)`, [STOPPED]);
    expect(rows).toHaveLength(1);
    expect(rows[0].consented).toBe(true);
  });

  it('and reports nothing for a number that only ever revoked', async () => {
    const { rows } = await db.query(`select * from sms_consent_status($1)`, [CONSENTED]);
    expect(rows).toHaveLength(1);

    await db.query(`select revoke_sms_consent($1, 'replied STOP')`, [CONSENTED]);
    const { rows: after } = await db.query(`select * from sms_consent_status($1)`, [CONSENTED]);
    expect(after).toHaveLength(0);
    expect(await optedOut(CONSENTED)).toBe(true);
  });
});
