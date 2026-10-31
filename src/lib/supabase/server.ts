/**
 * Request-scoped Supabase client for Server Components, Server Actions and
 * route handlers. Reads and writes the HTTP-only session cookies, so RLS
 * applies to everything it touches.
 *
 * Spec §3: "Sessions: Supabase SSR with HTTP-only cookies."
 */
import 'server-only';
import { cookies, headers } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { cache } from 'react';
import { env } from '@/lib/env';

/** The page a request came from, as a path. Tells an automation which module a
 *  change happened in (`automation_page_module`), without every write function
 *  having to carry it. It decides nothing about access. */
async function requestPage(): Promise<string | null> {
  try {
    const referer = (await headers()).get('referer');
    return referer ? new URL(referer).pathname : null;
  } catch {
    return null;
  }
}

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const page = await requestPage();

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      global: page ? { headers: { 'x-tapdash-page': page } } : undefined,
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
