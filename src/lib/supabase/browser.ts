/**
 * Browser Supabase client. Holds only the anon key, which is RLS-bound and safe
 * to ship. Used for client-side session state; every privileged operation goes
 * through a Server Action.
 */
'use client';

import { createBrowserClient } from '@supabase/ssr';
import { env } from '@/lib/env';

export function createSupabaseBrowserClient() {
  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
