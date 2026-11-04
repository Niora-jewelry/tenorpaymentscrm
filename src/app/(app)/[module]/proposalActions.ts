'use server';

/**
 * Proposals — the CRM user's actions. Parse, then hand to the service, which
 * asks the gate (the proposals tab, field grants, own Outlook mailbox).
 */
import { z } from 'zod';
import { revalidatePath } from 'next/cache';
import { authorize } from '@/lib/records/permissions';
import { ProposalError, proposalPreCheck, proposalSendDefaults, sendProposal, voidProposal, type OptionalPage, type ProposalSendDefaults } from '@/lib/proposals/service';
import type { ProblemGroup } from '@/lib/records/fieldProblems';

type Result<T> = { ok: true; data: T } | { ok: false; message: string };

const uuid = z.uuid();
const slug = z.string().regex(/^[a-z0-9-]{1,64}$/).nullable();
const email = z.string().trim().toLowerCase().max(254);
const Compose = z.object({
  recordId: uuid,
  mailboxId: uuid,
  to: email.min(3),
  cc: z.array(email).max(20),
  subject: z.string().trim().min(1, 'Add a subject.').max(200),
  body: z.string().trim().min(1, 'Add a message.').max(5000),
});

async function run<T>(fn: () => Promise<T>, fallback: string): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    if (e instanceof ProposalError) return { ok: false, message: e.message };
    if (e instanceof Error && /No (edit )?access/.test(e.message)) return { ok: false, message: 'You do not have access to do that on this record.' };
    console.error('[proposals]', fallback, e instanceof Error ? e.message.slice(0, 300) : e);
    return { ok: false, message: fallback };
  }
}
const refresh = () => revalidatePath('/[module]', 'page');

export async function proposalDefaultsAction(recordId: string, moduleSlug: string | null): Promise<Result<ProposalSendDefaults>> {
  const id = uuid.safeParse(recordId);
  const mod = slug.safeParse(moduleSlug);
  if (!id.success || !mod.success) return { ok: false, message: 'That record is not valid.' };
  const ctx = await authorize();
  return run(() => proposalSendDefaults(ctx, id.data, mod.data), 'Could not prepare the proposal.');
}

export async function proposalPreCheckAction(recordId: string, moduleSlug: string | null): Promise<Result<{ groups: ProblemGroup[]; optional: OptionalPage[] }>> {
  const id = uuid.safeParse(recordId);
  const mod = slug.safeParse(moduleSlug);
  if (!id.success || !mod.success) return { ok: false, message: 'That record is not valid.' };
  const ctx = await authorize();
  return run(() => proposalPreCheck(ctx, id.data, mod.data), 'Could not check the proposal.');
}

export async function sendProposalAction(input: z.input<typeof Compose>): Promise<Result<{ label: string }>> {
  const parsed = Compose.safeParse(input);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the email details.' };
  const ctx = await authorize();
  const r = await run(() => sendProposal(ctx, parsed.data), 'The proposal was not sent. Try again.');
  if (r.ok) refresh();
  return r.ok ? { ok: true, data: { label: r.data.label } } : r;
}

export async function voidProposalAction(proposalId: string): Promise<Result<null>> {
  const id = uuid.safeParse(proposalId);
  if (!id.success) return { ok: false, message: 'That proposal is not valid.' };
  const ctx = await authorize();
  const r = await run(() => voidProposal(ctx, id.data).then(() => null), 'The proposal was not voided. Try again.');
  if (r.ok) refresh();
  return r;
}
