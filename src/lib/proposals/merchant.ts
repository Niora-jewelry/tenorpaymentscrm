/**
 * The merchant's side of a proposal: everything reachable with the link alone.
 *
 * Client, "Proposal template Instructions" (3 Nov 2026): an online page only
 * for now, mobile friendly; "Click here to approve proposal – When this is
 * done the CRM registers an approval".
 *
 * The token is the only key. It is looked up by hash; misses spend a per-address
 * guessing budget, as the application link does. The record is never read
 * here: the page shows the content frozen at send.
 */
import 'server-only';
import { headers } from 'next/headers';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getClientIp } from '@/lib/security/request';
import { rateLimit } from '@/lib/security/rate-limit';
import { hashTicket, toPostgresBytea } from '@/lib/security/otp';
import { plausibleToken } from '@/lib/applications/store';
import type { ProposalContent } from './content';
import { effectiveProposalStatus, proposalLabel, type ProposalStatus } from './service';

const LIMITS = {
  missPerIp: { limit: 20, windowSeconds: 900 },
  openPerIp: { limit: 300, windowSeconds: 600 },
  approvePerLink: { limit: 10, windowSeconds: 3600 },
};

export type MerchantProposal =
  | { state: 'open' | 'approved'; label: string; content: ProposalContent; approvedAt: string | null; expiresAt: string }
  | { state: 'expired' | 'voided'; label: string; merchant: string }
  | { state: 'not_found' | 'busy' };

type Row = { id: string; number: number; status: string; expires_at: string; approved_at: string | null; content: ProposalContent };

async function ip(): Promise<string> {
  return getClientIp(await headers()) ?? 'unknown';
}

async function resolve(token: string, scope: string, rule: { limit: number; windowSeconds: number }): Promise<Row | 'not_found' | 'busy'> {
  const addr = await ip();
  if (!(await rateLimit(`proposal-${scope}:${addr}:${token.slice(0, 12)}`, rule)).allowed) return 'busy';
  if (plausibleToken(token)) {
    const { data, error } = await supabaseAdmin()
      .from('proposals')
      .select('id, number, status, expires_at, approved_at, content')
      .eq('token_hash', toPostgresBytea(hashTicket(token)))
      .maybeSingle();
    if (error) throw error;
    if (data) return data as Row;
  }
  // Only a miss spends the guessing budget; past it, the address waits.
  return (await rateLimit(`proposal-miss:${addr}`, LIMITS.missPerIp)).allowed ? 'not_found' : 'busy';
}

function stateOf(row: Row): MerchantProposal {
  const status: ProposalStatus = effectiveProposalStatus(row);
  const label = proposalLabel(row.number);
  if (status === 'voided' || status === 'expired') return { state: status, label, merchant: row.content.merchantName };
  return { state: status === 'approved' ? 'approved' : 'open', label, content: row.content, approvedAt: row.approved_at, expiresAt: row.expires_at };
}

/** Opens the link. The first open is recorded on the record. */
export async function openProposal(token: string): Promise<MerchantProposal> {
  const row = await resolve(token, 'open', LIMITS.openPerIp);
  if (typeof row === 'string') return { state: row };
  if (row.status === 'sent' && effectiveProposalStatus(row) === 'sent') {
    await supabaseAdmin().rpc('proposal_viewed', { p_proposal: row.id });
  }
  return stateOf(row);
}

/** "Click here to approve proposal". Once only; the database decides. */
export async function approveProposal(token: string): Promise<{ ok: true; approvedAt: string } | { ok: false; state: MerchantProposal['state']; message: string }> {
  const row = await resolve(token, 'approve', LIMITS.approvePerLink);
  if (typeof row === 'string') return { ok: false, state: row, message: row === 'busy' ? 'Too many attempts. Please wait a few minutes and try again.' : 'This proposal link is not valid.' };
  if (row.status === 'approved') return { ok: true, approvedAt: row.approved_at ?? new Date().toISOString() };
  const h = await headers();
  const { data, error } = await supabaseAdmin().rpc('proposal_approve', {
    p_proposal: row.id,
    p_ip: getClientIp(h) ?? 'unknown',
    p_agent: h.get('user-agent') ?? '',
  });
  if (error) throw error;
  if (data !== true) {
    // Refused: voided or expired meanwhile, or approved by a second click. Say which, as it is now.
    const { data: fresh } = await supabaseAdmin().from('proposals').select('status, approved_at').eq('id', row.id).maybeSingle();
    if (fresh?.status === 'approved') return { ok: true, approvedAt: (fresh.approved_at as string | null) ?? new Date().toISOString() };
    const now = stateOf({ ...row, status: (fresh?.status as string | undefined) ?? row.status });
    return { ok: false, state: now.state, message: now.state === 'voided' ? 'This proposal was withdrawn. Please contact us for an updated one.' : 'This proposal has expired. Please contact us for an updated one.' };
  }
  return { ok: true, approvedAt: new Date().toISOString() };
}
