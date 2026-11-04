'use server';

/**
 * The signer's link — its only action: go to their SignWell signing page. No
 * session: the token is the whole credential, and `signerPage.ts` checks it
 * (and its rate limits).
 */
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { startSigning } from '@/lib/agreements/signerPage';

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export async function startSigningAction(token: string): Promise<void> {
  const t = Token.safeParse(token);
  if (!t.success) redirect('/sign/invalid');
  let url: string | null = null;
  try {
    const r = await startSigning(t.data);
    if ('url' in r) url = r.url;
  } catch (e) {
    console.error('[sign] start failed', e instanceof Error ? e.message.slice(0, 200) : e);
    redirect(`/sign/${t.data}?e=1`);
  }
  // Not a signing address: the page itself says why (signed, withdrawn, expired…).
  redirect(url ?? `/sign/${t.data}`);
}
