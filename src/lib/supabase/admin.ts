/**
 * Service-role Supabase client. Bypasses RLS completely.
 *
 * Use ONLY for:
 *   - calling the SECURITY DEFINER functions that anon/authenticated cannot reach
 *     (invites, OTP challenges, rate limits, audit writes)
 *   - creating the auth user at the end of signup
 *
 * Everything a signed-in user does on their own behalf must go through the
 * request-scoped client in `server.ts`, so RLS still applies.
 */
import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from '@/lib/env';
import { serverEnv } from '@/lib/env.server';

let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  cached = createClient(env.NEXT_PUBLIC_SUPABASE_URL, serverEnv.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  return cached;
}
