/**
 * Logins. Envelope-encrypted passwords — `password_enc`/`password_key` are
 * never selected by this file (migration 12's column-restricted grant means
 * the request-scoped client physically cannot select them; there is no
 * "forget to exclude" failure mode here, it is enforced at the grant).
 *
 * The encryption key itself is never stored in Postgres — `LOGIN_ENC_KEY`
 * lives in the server environment, the same posture `OTP_PEPPER` already has
 * (SCHEMA-DECISIONS §15's "KMS-backed key rotation is explicitly deferred").
 */
import 'server-only';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { serverEnv } from '@/lib/env.server';
import type { AuthContext } from './permissions';
import { requireTabEdit, requireTabEditVia, requireTabView, recordIdOf } from './tabAccess';

export type LoginRow = {
  id: string;
  recordId: string;
  loginType: string;
  link: string | null;
  username: string | null;
  note: string | null;
  position: number;
};

function mapLogin(r: Record<string, unknown>): LoginRow {
  return {
    id: r.id as string, recordId: r.record_id as string, loginType: r.login_type as string,
    link: (r.link as string | null) ?? null, username: (r.username as string | null) ?? null,
    note: (r.note as string | null) ?? null, position: r.position as number,
  };
}

/** Metadata only — never selects password_enc/password_key (see file header). */
export async function loginsFor(_ctx: AuthContext, recordId: string): Promise<LoginRow[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('logins')
    .select('id, record_id, login_type, link, username, note, position')
    .eq('record_id', recordId)
    .is('deleted_at', null)
    .order('position');
  if (error) throw error;
  return (data ?? []).map(mapLogin);
}

export async function addLogin(
  ctx: AuthContext,
  recordId: string,
  loginType: string,
  link: string | null,
  username: string | null,
  note: string | null = null,
): Promise<LoginRow> {
  await requireTabEdit(ctx, recordId, 'logins');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from('logins')
    .insert({ record_id: recordId, login_type: loginType, link, username, note })
    .select('id, record_id, login_type, link, username, note, position')
    .single();
  if (error) throw error;
  return mapLogin(data);
}

/** Encrypts server-side and stores the ciphertext — the plaintext password
 * never appears in a Postgres statement the client could have crafted. */
export async function setPassword(ctx: AuthContext, loginId: string, plaintext: string): Promise<void> {
  await requireTabEditVia(ctx, 'logins', loginId, 'logins');
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc('store_login_password', {
    p_login_id: loginId,
    p_plaintext: plaintext,
    p_key: serverEnv.LOGIN_ENC_KEY,
  });
  if (error) throw error;
}

/** "Every reveal is written to the audit log" — reveal_password() does that
 * itself, before returning the plaintext, so a successful decrypt is always
 * logged. Excluded from every export by construction: nothing in
 * `lib/records/*` ever writes a plaintext password anywhere but the return
 * value of this one call. */
export async function revealPassword(ctx: AuthContext, loginId: string, kind: 'view' | 'copy' = 'view'): Promise<string> {
  // A reveal is a READ, so View is enough — but a Hidden Logins tab must not
  // stay reachable by id as a decryption oracle.
  await requireTabView(ctx, await recordIdOf('logins', loginId), 'logins');
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc('reveal_password', {
    p_login_id: loginId,
    p_key: serverEnv.LOGIN_ENC_KEY,
    // Logged as what it was: Logins "View / copy" (Permissions spec).
    p_kind: kind,
  });
  if (error) throw error;
  return data as string;
}
