/**
 * The people an invitation, a new chat or a new team can name: the account's Microsoft
 * contacts and frequent people, and the CRM's own users.
 */
import 'server-only';
import { graphForIdentity } from '@/lib/mail/tokens';
import type { AuthContext } from '@/lib/records/permissions';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ownIdentity } from './access';
import type { PersonResult } from './types';

const LIMIT = 12;

type GraphPerson = { displayName?: string; scoredEmailAddresses?: { address?: string }[]; userPrincipalName?: string };
type GraphContact = { displayName?: string; emailAddresses?: { address?: string }[] };

/** Everything a search term could use to break out of the filter. */
const safeTerm = (q: string) => q.replace(/[^\p{L}\p{N} @._-]/gu, '').trim().slice(0, 80);

async function fromMicrosoft(identityId: string, q: string): Promise<PersonResult[]> {
  const graph = graphForIdentity(identityId);
  const [people, contacts] = await Promise.all([
    graph.request<{ value?: GraphPerson[] }>({ path: '/me/people', query: { $search: `"${q}"`, $top: LIMIT, $select: 'displayName,scoredEmailAddresses,userPrincipalName' } }).catch(() => null),
    graph.request<{ value?: GraphContact[] }>({ path: '/me/contacts', query: { $filter: `startswith(displayName,'${q.replace(/'/g, "''")}')`, $top: LIMIT, $select: 'displayName,emailAddresses' } }).catch(() => null),
  ]);
  const out: PersonResult[] = [];
  for (const p of people?.value ?? []) {
    const email = p.scoredEmailAddresses?.[0]?.address ?? p.userPrincipalName;
    if (email) out.push({ name: p.displayName ?? email, email, source: 'microsoft' });
  }
  for (const c of contacts?.value ?? []) {
    const email = c.emailAddresses?.[0]?.address;
    if (email) out.push({ name: c.displayName ?? email, email, source: 'microsoft' });
  }
  return out;
}

async function fromCrm(q: string): Promise<PersonResult[]> {
  // % and _ would widen the match, and , would break the filter.
  const like = `%${q.replace(/[%_,]/g, '')}%`;
  const { data } = await supabaseAdmin().from('profiles').select('full_name, email').is('deleted_at', null).or(`full_name.ilike.${like},email.ilike.${like}`).limit(LIMIT);
  return (data ?? []).flatMap((p) => (p.email ? [{ name: (p.full_name as string | null)?.trim() || (p.email as string), email: p.email as string, source: 'crm' as const }] : []));
}

export async function searchPeople(ctx: AuthContext, args: { identityId: string; q: string }): Promise<PersonResult[]> {
  const identity = await ownIdentity(ctx, args.identityId);
  const q = safeTerm(args.q);
  if (q.length < 2) return [];
  const [microsoft, crm] = await Promise.all([fromMicrosoft(identity.id, q), fromCrm(q)]);
  const seen = new Set<string>([identity.email.toLowerCase()]);
  const merged: PersonResult[] = [];
  for (const p of [...crm, ...microsoft]) {
    const key = p.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(p);
  }
  return merged.slice(0, LIMIT);
}
