'use server';

/**
 * The merchant's proposal link — its only action. No session: the token is
 * the whole credential, and `merchant.ts` checks it (and its rate limits).
 */
import { z } from 'zod';
import { approveProposal } from '@/lib/proposals/merchant';

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export async function approveProposalAction(token: string) {
  const t = Token.safeParse(token);
  if (!t.success) return { ok: false as const, message: 'This proposal link is not valid.' };
  try {
    return await approveProposal(t.data);
  } catch (e) {
    console.error('[proposal] approve failed', e instanceof Error ? e.message.slice(0, 200) : e);
    return { ok: false as const, message: 'Something went wrong while recording your approval. Please try again.' };
  }
}
