/**
 * The merchant's side: everything reachable with the link alone.
 *
 * Spec, Online path + Security:
 *  · unique, hard-to-guess link (a token, not the merchant ID); no login;
 *    expires (30 days unless changed) or when voided;
 *  · prefilled from the CRM, editable; never an SSN or a Private value —
 *    "On file (•••-••-1234)" with an option to replace it;
 *  · save as you type; come back through the same link;
 *  · submit → thank-you, read-only, status Submitted;
 *  · "Upload your completed PDF" as the safer return route;
 *  · repeated attempts are limited.
 *
 * The token is the only key. Nothing here trusts anything else the browser
 * sends: answers are whitelisted (`sanitizeAnswers`) and checked again on
 * submit (`problemsWith`).
 */
import 'server-only';
import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getClientIp } from '@/lib/security/request';
import { rateLimit } from '@/lib/security/rate-limit';
import { toPostgresBytea } from '@/lib/security/otp';
import { fromBytea } from '@/lib/mail/crypto';
import { openText, sealText } from './crypto';
import { MAX_OWNERS, ownerField, type Answers } from './catalog';
import { prefillAnswers, ssnOnFile } from './mapping';
import { readApplicationPdf } from './pdf';
import { problemsWith, sanitizeAnswers, type Problems } from './validate';
import { signedPdfUpload, storeReturnedPdf } from './service';
import {
  appLabel,
  applicationByToken,
  choiceLabels,
  effectiveStatus,
  ingest,
  linkIsLive,
  merchantName,
  recordForApplication,
  type ApplicationRow,
} from './store';

export type MerchantState = 'open' | 'submitted' | 'expired' | 'voided' | 'not_found' | 'busy';

export type MerchantForm = {
  state: 'open';
  label: string;
  merchant: string;
  expiresAt: string;
  answers: Answers;
  /** Owner number → "•••-••-1234": already on file in the CRM. */
  ssnOnFile: Record<number, string>;
  /** Owner number → "•••-••-1234": typed here earlier and saved, not yet submitted. */
  ssnEntered: Record<number, string>;
  savedAt: string | null;
};

const LIMITS = {
  // Guessing tokens: a handful of misses per address, then a pause.
  missPerIp: { limit: 20, windowSeconds: 900 },
  openPerIp: { limit: 300, windowSeconds: 600 },
  savePerLink: { limit: 600, windowSeconds: 600 },
  submitPerLink: { limit: 20, windowSeconds: 3600 },
  uploadPerLink: { limit: 10, windowSeconds: 3600 },
};

async function ip(): Promise<string> {
  return getClientIp(await headers()) ?? 'unknown';
}

/** Rate-limited token lookup. Unknown tokens count against the address. */
async function resolve(token: string, rule: { limit: number; windowSeconds: number }, scope: string): Promise<ApplicationRow | MerchantState> {
  const addr = await ip();
  const hit = await rateLimit(`app-${scope}:${addr}:${token.slice(0, 12)}`, rule);
  if (!hit.allowed) return 'busy';
  const app = await applicationByToken(token);
  if (!app) {
    // Only a miss spends the guessing budget; past it, the address waits.
    const miss = await rateLimit(`app-miss:${addr}`, LIMITS.missPerIp);
    return miss.allowed ? 'not_found' : 'busy';
  }
  return app;
}

function sealedSsns(row: { id: string; draft_sealed: unknown; draft_iv: unknown }): Record<number, string> {
  if (!row.draft_sealed || !row.draft_iv) return {};
  try {
    return JSON.parse(openText({ data: fromBytea(row.draft_sealed), iv: fromBytea(row.draft_iv) }, `application-draft:${row.id}`)) as Record<number, string>;
  } catch {
    return {};
  }
}
const mask = (ssn: string) => `•••-••-${ssn.replace(/\D/g, '').slice(-4)}`;

/** Opens the link: the form, or why there is none. Marks the application Opened. */
export async function openForMerchant(token: string): Promise<MerchantForm | { state: Exclude<MerchantState, 'open'>; label?: string; merchant?: string }> {
  const app = await resolve(token, LIMITS.openPerIp, 'open');
  if (typeof app === 'string') return { state: app as Exclude<MerchantState, 'open'> };
  const rec = await recordForApplication(app.record_id);
  if (!rec) return { state: 'not_found' };
  const merchant = merchantName(rec.values, rec.dealName);
  const status = effectiveStatus(app);
  if (status === 'voided') return { state: 'voided', label: appLabel(app.number), merchant };
  if (status === 'expired') return { state: 'expired', label: appLabel(app.number), merchant };
  if (!linkIsLive(app)) return { state: 'submitted', label: appLabel(app.number), merchant };

  if (app.status === 'sent') {
    const { data } = await supabaseAdmin()
      .from('applications')
      .update({ status: 'opened', opened_at: new Date().toISOString() })
      .eq('id', app.id)
      .eq('status', 'sent')
      .select('id');
    if (data?.length) {
      await supabaseAdmin().rpc('application_log', { p_application: app.id, p_actor: null, p_summary: `${appLabel(app.number)} opened by the merchant` });
    }
  }

  const { data: row } = await supabaseAdmin().from('applications').select('id, draft, draft_sealed, draft_iv, draft_saved_at').eq('id', app.id).single();
  const draft = (row?.draft ?? {}) as Answers;
  const hasDraft = Object.keys(draft).length > 0;
  const answers = hasDraft ? sanitizeAnswers(draft) : prefillAnswers(rec.values, await choiceLabels());
  const entered = row ? sealedSsns(row) : {};
  return {
    state: 'open',
    label: appLabel(app.number),
    merchant,
    expiresAt: app.expires_at,
    answers,
    ssnOnFile: ssnOnFile(rec.values),
    ssnEntered: Object.fromEntries(Object.entries(entered).map(([n, s]) => [n, mask(s)])),
    savedAt: (row?.draft_saved_at as string | null) ?? null,
  };
}

/** Splits typed SSNs out of the answers (they are sealed, never stored plain). */
function splitSsns(a: Answers): { rest: Answers; ssns: Record<number, string> } {
  const rest: Answers = { ...a };
  const ssns: Record<number, string> = {};
  for (let n = 1; n <= MAX_OWNERS; n++) {
    const k = ownerField(n, 'ssn');
    const v = rest[k];
    delete rest[k];
    if (typeof v === 'string' && v.replace(/\D/g, '').length === 9) ssns[n] = v.replace(/\D/g, '');
  }
  return { rest, ssns };
}

/** Save and finish later. Typed SSNs are merged into the sealed set. */
export async function saveForMerchant(token: string, raw: unknown): Promise<{ ok: true; savedAt: string } | { ok: false; state: MerchantState }> {
  const app = await resolve(token, LIMITS.savePerLink, 'save');
  if (typeof app === 'string') return { ok: false, state: app };
  if (!linkIsLive(app)) return { ok: false, state: effectiveStatus(app) === 'voided' ? 'voided' : effectiveStatus(app) === 'expired' ? 'expired' : 'submitted' };
  const { rest, ssns } = splitSsns(sanitizeAnswers(raw));
  const { data: row } = await supabaseAdmin().from('applications').select('id, draft_sealed, draft_iv').eq('id', app.id).single();
  const merged = { ...(row ? sealedSsns(row) : {}), ...ssns };
  const sealed = Object.keys(merged).length ? sealText(JSON.stringify(merged), `application-draft:${app.id}`) : null;
  const savedAt = new Date().toISOString();
  const { error } = await supabaseAdmin()
    .from('applications')
    .update({
      draft: rest,
      draft_sealed: sealed ? toPostgresBytea(sealed.data) : null,
      draft_iv: sealed ? toPostgresBytea(sealed.iv) : null,
      draft_saved_at: savedAt,
    })
    .eq('id', app.id);
  if (error) throw error;
  return { ok: true, savedAt };
}

/** Submit: checked on the server, then into the CRM (empty fields fill, differences wait). */
export async function submitForMerchant(token: string, raw: unknown): Promise<{ ok: true } | { ok: false; state?: MerchantState; problems?: Problems }> {
  const app = await resolve(token, LIMITS.submitPerLink, 'submit');
  if (typeof app === 'string') return { ok: false, state: app };
  if (!linkIsLive(app)) return { ok: false, state: effectiveStatus(app) === 'voided' ? 'voided' : effectiveStatus(app) === 'expired' ? 'expired' : 'submitted' };
  const rec = await recordForApplication(app.record_id);
  if (!rec) return { ok: false, state: 'not_found' };

  const { rest, ssns: typed } = splitSsns(sanitizeAnswers(raw));
  const { data: row } = await supabaseAdmin().from('applications').select('id, draft_sealed, draft_iv').eq('id', app.id).single();
  const ssns = { ...(row ? sealedSsns(row) : {}), ...typed };
  const answers: Answers = { ...rest };
  for (const [n, s] of Object.entries(ssns)) answers[ownerField(Number(n), 'ssn')] = s;

  const problems = problemsWith(answers, ssnOnFile(rec.values));
  if (Object.keys(problems).length) return { ok: false, problems };

  await ingest(app, answers, 'online', null);
  // The answers now live in the CRM; the copy on the link is not kept.
  await supabaseAdmin().from('applications').update({ draft: {}, draft_sealed: null, draft_iv: null }).eq('id', app.id);
  return { ok: true };
}

/** "Upload your completed PDF" on the link page — the same flow as a CRM upload. */
export async function uploadForMerchant(token: string, name: string, bytes: Uint8Array): Promise<{ ok: true; readable: boolean } | { ok: false; state?: MerchantState; message?: string }> {
  const app = await resolve(token, LIMITS.uploadPerLink, 'upload');
  if (typeof app === 'string') return { ok: false, state: app };
  if (!linkIsLive(app)) return { ok: false, state: effectiveStatus(app) === 'voided' ? 'voided' : effectiveStatus(app) === 'expired' ? 'expired' : 'submitted' };
  if (bytes.byteLength === 0 || bytes.byteLength > 25 * 1024 * 1024) return { ok: false, message: 'The PDF must be under 25 MB.' };
  if (Buffer.from(bytes.subarray(0, 5)).toString('latin1') !== '%PDF-') return { ok: false, message: 'That file is not a PDF.' };

  const read = await readApplicationPdf(bytes);
  await storeReturnedPdf({
    recordId: app.record_id,
    applicationId: app.id,
    name,
    bytes,
    readable: read.readable,
    fieldsFound: read.fieldsFound,
    uploadedBy: null,
    via: 'merchant',
  });
  if (read.readable) {
    await ingest(app, read.answers, 'pdf', null);
  } else {
    await supabaseAdmin()
      .from('applications')
      .update({ status: 'pdf_uploaded', submitted_at: new Date().toISOString(), returned_via: 'pdf' })
      .eq('id', app.id);
    await supabaseAdmin().rpc('application_log', {
      p_application: app.id,
      p_actor: null,
      p_summary: `${appLabel(app.number)} PDF uploaded by the merchant — no readable fields, enter the answers by hand`,
    });
  }
  await supabaseAdmin().from('applications').update({ draft: {}, draft_sealed: null, draft_iv: null }).eq('id', app.id);
  return { ok: true, readable: read.readable };
}

/** A one-time upload slot for "Upload your completed PDF", for a live link only. */
export async function prepareMerchantUpload(token: string): Promise<{ ok: true; path: string; token: string } | { ok: false; state: MerchantState }> {
  const app = await resolve(token, LIMITS.uploadPerLink, 'prepare');
  if (typeof app === 'string') return { ok: false, state: app };
  if (!linkIsLive(app)) return { ok: false, state: effectiveStatus(app) === 'voided' ? 'voided' : effectiveStatus(app) === 'expired' ? 'expired' : 'submitted' };
  const slot = await signedPdfUpload();
  return { ok: true, ...slot };
}
