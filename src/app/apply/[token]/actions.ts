'use server';

/**
 * The merchant's link page — its only actions. No session: the token is the
 * whole credential, and `merchant.ts` checks it (and its rate limits) on
 * every call. Inputs are parsed here; answers are whitelisted there.
 */
import { z } from 'zod';
import {
  prepareMerchantUpload,
  saveForMerchant,
  submitForMerchant,
  uploadForMerchant,
} from '@/lib/applications/merchant';
import { dropIncoming, readIncoming } from '@/lib/applications/service';

const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export async function saveAnswersAction(token: string, answers: unknown) {
  const t = Token.safeParse(token);
  if (!t.success) return { ok: false as const, state: 'not_found' as const };
  return saveForMerchant(t.data, answers);
}

export async function submitAnswersAction(token: string, answers: unknown) {
  const t = Token.safeParse(token);
  if (!t.success) return { ok: false as const, state: 'not_found' as const };
  try {
    return await submitForMerchant(t.data, answers);
  } catch (e) {
    console.error('[apply] submit failed', e instanceof Error ? e.message.slice(0, 200) : e);
    return { ok: false as const, message: 'Something went wrong while saving your application. Your answers are kept — please try again.' };
  }
}

export async function prepareMerchantUploadAction(token: string) {
  const t = Token.safeParse(token);
  if (!t.success) return { ok: false as const, state: 'not_found' as const };
  return prepareMerchantUpload(t.data);
}

export async function finishMerchantUploadAction(token: string, path: string, name: string) {
  const t = Token.safeParse(token);
  const p = z.string().regex(/^incoming\/[0-9a-f-]{36}\.pdf$/).safeParse(path);
  const n = z.string().trim().min(1).max(255).safeParse(name);
  if (!t.success || !p.success || !n.success) return { ok: false as const, message: 'That upload is not valid.' };
  try {
    const bytes = await readIncoming(p.data);
    try {
      return await uploadForMerchant(t.data, n.data, bytes);
    } finally {
      await dropIncoming(p.data);
    }
  } catch (e) {
    console.error('[apply] upload failed', e instanceof Error ? e.message.slice(0, 200) : e);
    return { ok: false as const, message: 'The PDF could not be uploaded. Please try again.' };
  }
}
