/**
 * Re-encrypts every stored Microsoft token under a new MAIL_TOKEN_ENC_KEY.
 *
 *   MAIL_TOKEN_ENC_KEY_NEW=<32 random bytes, base64> \
 *     node --env-file=.env scripts/mail-rotate-token-key.mjs            # dry run: proves every token opens
 *   … scripts/mail-rotate-token-key.mjs --apply                          # rewrites them, one transaction
 *
 * Then set MAIL_TOKEN_ENC_KEY to the new value in Vercel and redeploy at once:
 * between --apply and the redeploy the running app holds the old key and its
 * token refreshes fail (mail keeps showing; syncing pauses for that minute).
 * Do it at a quiet time. See docs/mail/RUNBOOK.md.
 *
 * All or nothing: if any token fails to open with the current key, nothing
 * is written and the script says which identity. Same cipher and AAD as
 * src/lib/mail/crypto.ts (AES-256-GCM, tag appended, AAD = "<user id>:<microsoft user id>").
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import pg from 'pg';

const apply = process.argv.includes('--apply');
const key = (name) => {
  const raw = process.env[name];
  const k = raw ? Buffer.from(raw, 'base64') : Buffer.alloc(0);
  if (k.length !== 32) {
    console.error(`${name} must be 32 random bytes, base64-encoded.`);
    process.exit(2);
  }
  return k;
};
const oldKey = key('MAIL_TOKEN_ENC_KEY');
const newKey = key('MAIL_TOKEN_ENC_KEY_NEW');
if (oldKey.equals(newKey)) {
  console.error('The new key is the same as the current one.');
  process.exit(2);
}

function open(ciphertext, iv, k, aad) {
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  const d = createDecipheriv('aes-256-gcm', k, iv);
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}
function seal(plaintext, k, aad) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return { ciphertext: Buffer.concat([body, c.getAuthTag()]), iv };
}

const db = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  await db.query('begin');
  const { rows } = await db.query(`
    select s.identity_id, s.refresh_token_enc, s.refresh_token_iv, s.access_token_enc, s.access_token_iv, s.key_version,
           i.user_id, i.microsoft_user_id
      from mail_identity_secrets s join mail_identities i on i.id = s.identity_id
     for update of s`);
  const versions = new Set(rows.map((r) => r.key_version));
  const next = `v${Math.max(1, ...[...versions].map((v) => Number(String(v).replace(/^v/, '')) || 1)) + 1}`;
  let done = 0;
  for (const r of rows) {
    const aad = `${r.user_id}:${r.microsoft_user_id}`;
    let refresh;
    let access = null;
    try {
      refresh = open(r.refresh_token_enc, r.refresh_token_iv, oldKey, aad);
      if (r.access_token_enc && r.access_token_iv) access = open(r.access_token_enc, r.access_token_iv, oldKey, aad);
    } catch {
      throw new Error(`identity ${r.identity_id}: does not open with the current MAIL_TOKEN_ENC_KEY — nothing was changed.`);
    }
    if (!apply) {
      done += 1;
      continue;
    }
    const rt = seal(refresh, newKey, aad);
    const at = access ? seal(access, newKey, aad) : null;
    await db.query(
      `update mail_identity_secrets
          set refresh_token_enc = $2, refresh_token_iv = $3, access_token_enc = $4, access_token_iv = $5, key_version = $6, updated_at = now()
        where identity_id = $1`,
      [r.identity_id, rt.ciphertext, rt.iv, at?.ciphertext ?? null, at?.iv ?? null, next],
    );
    done += 1;
  }
  if (apply) {
    await db.query('commit');
    console.log(`Re-encrypted ${done} identit${done === 1 ? 'y' : 'ies'} (key_version ${next}). Now set MAIL_TOKEN_ENC_KEY to the new key and redeploy.`);
  } else {
    await db.query('rollback');
    console.log(`Dry run: all ${done} stored token${done === 1 ? '' : 's'} open with the current key. Run again with --apply to rotate.`);
  }
} catch (e) {
  await db.query('rollback').catch(() => {});
  console.error(String(e instanceof Error ? e.message : e));
  process.exitCode = 1;
} finally {
  await db.end();
}
