/**
 * Request-scoped Supabase client for Server Components, Server Actions and
 * route handlers. Reads and writes the HTTP-only session cookies, so RLS
 * applies to everything it touches.
 *
 * Spec §3: "Sessions: Supabase SSR with HTTP-only cookies."
 */
import 'server-only';
import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { cache } from 'react';
import { env } from '@/lib/env';

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Called from a Server Component, where cookies are read-only.
            // Middleware refreshes the session on every request, so this is safe
            // to ignore here.
          }
        },
      },
    },
  );
}

/**
 * The signed-in user for this request, or null.
 *
 * Wrapped in React `cache()` so that a layout, a page and three components all
 * asking "who is this?" cost exactly one verification, not five.
 *
 * Always `getUser()`, never `getSession()` — getUser revalidates the token with
 * the auth server; getSession trusts whatever is in the cookie.
 */
export const getCurrentUser = cache(async () => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
});
