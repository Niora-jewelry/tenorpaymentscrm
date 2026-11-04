/**
 * The signer's side of an agreement sent through Outlook: everything reachable
 * with their link alone (/sign/<token>).
 *
 * The token is the only key, looked up by hash; misses spend a per-address
 * guessing budget, as the application and proposal links do. The record is
 * never read here. "Review and sign" asks SignWell for this signer's signing
 * address at the moment of the click — a voided agreement or a corrected email
 * takes effect at once, and an email scanner opening the link records nothing.
 */
import 'server-only';
import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getClientIp } from '@/lib/security/request';
import { rateLimit } from '@/lib/security/rate-limit';
import { hashTicket, toPostgresBytea } from '@/lib/security/otp';
import { fromBytea } from '@/lib/mail/crypto';
import { openBytes } from './crypto';
import { kindFor } from './kinds';
import { agrLabel, type AgreementStatus, type SignerStatus } from './store';
import { COPY_DAYS } from './outlook';
import { vendor } from './vendor';

const LIMITS = {
  missPerIp: { limit: 20, windowSeconds: 900 },
  openPerIp: { limit: 300, windowSeconds: 600 },
  signPerLink: { limit: 30, windowSeconds: 3600 },
  copyPerLink: { limit: 10, windowSeconds: 3600 },
};

type Row = {
  id: string;
  name: string;
  email: string;
  status: SignerStatus;
  signed_at: string | null;
  vendor_recipient_id: string | null;
  agreement: {
    id: string;
    number: number;
    kind: string;
    status: AgreementStatus;
    expires_at: string;
    completed_at: string | null;
    vendor_document_id: string | null;
    merchant_name: string | null;
    delivery_address: string | null;
    download_status: string;
  };
};

export type SignerPage =
  | {
      state: 'open' | 'signed' | 'completed' | 'declined' | 'expired' | 'voided';
      label: string;
      what: string;
      merchant: string;
      signer: string;
      expiresAt: string;
      contact: string | null;
      /** The signed copy can be downloaded from this link (completed, stored, within COPY_DAYS). */
      copy: boolean;
    }
  | { state: 'not_found' | 'busy' };

export const plausibleLink = (t: string) => /^[A-Za-z0-9_-]{43}$/.test(t);

async function ip(): Promise<string> {
  return getClientIp(await headers()) ?? 'unknown';
}

async function resolve(token: string, scope: string, rule: { limit: number; windowSeconds: number }): Promise<Row | 'not_found' | 'busy'> {
  const addr = await ip();
  if (!(await rateLimit(`sign-${scope}:${addr}:${token.slice(0, 12)}`, rule)).allowed) return 'busy';
  if (plausibleLink(token)) {
    const { data, error } = await supabaseAdmin()
      .from('agreement_signers')
      .select(
        'id, name, email, status, signed_at, vendor_recipient_id, agreement:agreements!inner (id, number, kind, status, expires_at, completed_at, vendor_document_id, merchant_name, delivery_address, download_status)',
      )
      .eq('link_hash', toPostgresBytea(hashTicket(token)))
      .maybeSingle();
    if (error) throw error;
    if (data) return data as unknown as Row;
  }
  // Only a miss spends the guessing budget; past it, the address waits.
  return (await rateLimit(`sign-miss:${addr}`, LIMITS.missPerIp)).allowed ? 'not_found' : 'busy';
}

const copyOpen = (r: Row) =>
  r.agreement.status === 'completed' &&
  r.agreement.download_status === 'stored' &&
  !!r.agreement.completed_at &&
  Date.now() < new Date(r.agreement.completed_at).getTime() + COPY_DAYS * 86400_000;

function pageOf(r: Row): SignerPage {
  const a = r.agreement;
  const expired = a.status === 'expired' || (['sent', 'viewed', 'partially_signed'].includes(a.status) && new Date(a.expires_at).getTime() < Date.now());
  const state: Exclude<SignerPage['state'], 'not_found' | 'busy'> =
    a.status === 'completed'
      ? 'completed'
      : a.status === 'voided'
        ? 'voided'
        : a.status === 'declined'
          ? 'declined'
          : expired
            ? 'expired'
            : r.status === 'signed'
              ? 'signed'
              : 'open';
  return {
    state,
    label: agrLabel(a.number),
    what: kindFor(a.kind)?.label ?? 'Agreement',
    merchant: a.merchant_name ?? '',
    signer: r.name,
    expiresAt: a.expires_at,
    contact: a.delivery_address,
    copy: copyOpen(r),
  };
}

export async function openSignerPage(token: string): Promise<SignerPage> {
  const r = await resolve(token, 'open', LIMITS.openPerIp);
  return typeof r === 'string' ? { state: r } : pageOf(r);
}

/** "Review and sign": this signer's SignWell page, asked for now. */
export async function startSigning(token: string): Promise<{ url: string } | { page: SignerPage }> {
  const r = await resolve(token, 'go', LIMITS.signPerLink);
  if (typeof r === 'string') return { page: { state: r } };
  const page = pageOf(r);
  if (page.state !== 'open' || !r.agreement.vendor_document_id || !r.vendor_recipient_id) return { page };
  const doc = await vendor().get(r.agreement.vendor_document_id);
  const me = doc.recipients.find((x) => x.vendorId === r.vendor_recipient_id);
  // Signed already, though our webhook has not landed yet: say so rather than reopen the page.
  if (me?.status === 'completed' || me?.status === 'signed') return { page: { ...page, state: 'signed' } };
  // No open signing page for them: the document closed meanwhile. The page re-reads and says why.
  if (!me?.signingUrl) return { page };
  return { url: me.signingUrl };
}

/** The signed copy, for COPY_DAYS after completion — what SignWell's own completion email would have given them. */
export async function signedCopy(token: string): Promise<{ name: string; bytes: Buffer } | null> {
  const r = await resolve(token, 'copy', LIMITS.copyPerLink);
  if (typeof r === 'string' || !copyOpen(r)) return null;
  const { data: f } = await supabaseAdmin()
    .from('agreement_files')
    .select('id, name, storage_path, iv')
    .eq('agreement_id', r.agreement.id)
    .eq('kind', 'completed')
    .maybeSingle();
  if (!f) return null;
  const { data: blob, error } = await supabaseAdmin().storage.from('agreement-pdfs').download(f.storage_path as string);
  if (error || !blob) return null;
  const bytes = openBytes({ data: Buffer.from(await blob.arrayBuffer()), iv: fromBytea(f.iv) }, `agreement-file:${f.id as string}`);
  return { name: f.name as string, bytes };
}
