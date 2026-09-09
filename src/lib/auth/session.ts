/**
 * The one place anything asks "who is signed in?".
 *
 * Two providers today:
 *   1. Supabase — the real one
 *   2. Demo mode — a development stand-in, unreachable in production
 *
 * Everything downstream reads this, so removing demo mode later touches this
 * file and nothing else.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { cache } from 'react';
import { getCurrentUser } from '@/lib/supabase/server';
import {
  isDemoAuthEnabled,
  verifyDemoSessionToken,
  createDemoSessionToken,
  DEMO_COOKIE_NAME,
} from '@/lib/auth/demo-mode';
import { isProduction } from '@/lib/env.server';

export type SessionUser = {
  id: string;
  email: string;
  name: string | null;
  /** True when this session came from demo mode rather than Supabase. */
  isDemo: boolean;
};

/**
 * Deduped per request by React `cache()`, so a layout, a page and three
 * components asking costs one verification rather than five.
 */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const supabaseUser = await getCurrentUser();
  if (supabaseUser) {
    return {
      id: supabaseUser.id,
      email: supabaseUser.email ?? '',
      name: (supabaseUser.user_metadata?.full_name as string | undefined) ?? null,
      isDemo: false,
    };
  }

  if (!isDemoAuthEnabled()) return null;

  const store = await cookies();
  const session = await verifyDemoSessionToken(store.get(DEMO_COOKIE_NAME)?.value);
  if (!session) return null;

  return {
    id: 'demo-user',
    email: session.email,
    name: session.name,
    isDemo: true,
  };
});

export async function setDemoSession(email: string, name: string): Promise<void> {
  if (!isDemoAuthEnabled()) return;

  const token = await createDemoSessionToken(email, name);
  const store = await cookies();

  store.set(DEMO_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: 24 * 60 * 60,
  });
}

export async function clearDemoSession(): Promise<void> {
  const store = await cookies();
  store.delete(DEMO_COOKIE_NAME);
}
