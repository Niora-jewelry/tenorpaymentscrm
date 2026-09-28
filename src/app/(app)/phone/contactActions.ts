'use server';

/**
 * Server actions for the address book.
 *
 * Thin shells, like `phoneActions.ts`: parse, authorise, call the data layer,
 * revalidate. Every rule lives in `lib/phone/contacts.ts` so a second caller
 * cannot skip it.
 *
 * ── NORMALISATION HAPPENS HERE, ONCE ─────────────────────────────────────
 * Numbers are turned into E.164 at this boundary and nowhere else. Matching a
 * call or a text to a contact is an exact string comparison, so a contact
 * saved as "(732) 724-1779" would be a contact nothing ever matches — stored
 * correctly, displayed correctly, and silently useless. `lib/phone/normalize.ts`
 * exists for exactly this, and this is the last place user input can still be
 * raw.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { authorize } from '@/lib/records/permissions';
import { normalizePhone } from '@/lib/phone/normalize';
import {
  createContact,
  removeContact,
  updateContact,
  contactActivity,
  type ContactActivity,
  type ContactResult,
} from '@/lib/phone/contacts';

/** Parse, never trust — CLAUDE.md rule 6. */
const contactSchema = z.object({
  displayName: z.string().trim().min(1, 'Give this contact a name.').max(120),
  company: z.string().trim().max(160).optional().or(z.literal('')),
  email: z
    .string()
    .trim()
    .max(200)
    .email('That does not look like an email address.')
    .optional()
    .or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
  numbers: z
    .array(
      z.object({
        raw: z.string().trim().min(3, 'Enter a phone number.').max(32),
        label: z.string().trim().max(40).optional().or(z.literal('')),
      }),
    )
    .min(1, 'A contact needs at least one phone number.')
    .max(5, 'Five numbers is the most a contact can hold.'),
});

export type ContactInput = z.infer<typeof contactSchema>;
export type ContactState = { ok: boolean; message?: string; id?: string };

const idSchema = z.object({ contactId: z.string().uuid() });

/** Raw numbers in, E.164 out — or the first one that cannot be understood. */
function normalizeAll(
  numbers: ContactInput['numbers'],
): { ok: true; numbers: { e164: string; label: string | null }[] } | { ok: false; message: string } {
  const out: { e164: string; label: string | null }[] = [];
  const seen = new Set<string>();

  for (const n of numbers) {
    const result = normalizePhone(n.raw);
    if (!result.ok) {
      return {
        ok: false,
        message:
          result.reason === 'too_short'
            ? `"${n.raw}" is too short to be a phone number.`
            : result.reason === 'too_long'
              ? `"${n.raw}" is too long to be a phone number.`
              : 'Enter a phone number.',
      };
    }
    /*
     * Two spellings of one number - "7327241779" and "(732) 724-1779" - are
     * identical after normalising, and would hit the unique index as a
     * database error rather than as advice. Caught here instead.
     */
    if (seen.has(result.e164)) {
      return { ok: false, message: 'That contact has the same number listed twice.' };
    }
    seen.add(result.e164);
    out.push({ e164: result.e164, label: n.label ? n.label : null });
  }

  return { ok: true, numbers: out };
}

function shape(result: ContactResult): ContactState {
  return result.ok ? { ok: true, id: result.id } : { ok: false, message: result.message };
}

export async function createContactAction(input: ContactInput): Promise<ContactState> {
  const ctx = await authorize();

  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'That contact is not valid.' };
  }

  const numbers = normalizeAll(parsed.data.numbers);
  if (!numbers.ok) return { ok: false, message: numbers.message };

  const result = await createContact(ctx, {
    displayName: parsed.data.displayName,
    company: parsed.data.company || null,
    email: parsed.data.email || null,
    notes: parsed.data.notes || null,
    numbers: numbers.numbers,
  });

  revalidatePath('/phone');
  return shape(result);
}

export async function updateContactAction(
  contactId: string,
  input: ContactInput,
): Promise<ContactState> {
  const ctx = await authorize();

  const id = idSchema.safeParse({ contactId });
  if (!id.success) return { ok: false, message: 'That contact could not be found.' };

  const parsed = contactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'That contact is not valid.' };
  }

  const numbers = normalizeAll(parsed.data.numbers);
  if (!numbers.ok) return { ok: false, message: numbers.message };

  const result = await updateContact(ctx, id.data.contactId, {
    displayName: parsed.data.displayName,
    company: parsed.data.company || null,
    email: parsed.data.email || null,
    notes: parsed.data.notes || null,
    numbers: numbers.numbers,
  });

  revalidatePath('/phone');
  return shape(result);
}

export async function removeContactAction(contactId: string): Promise<ContactState> {
  const ctx = await authorize();

  const id = idSchema.safeParse({ contactId });
  if (!id.success) return { ok: false, message: 'That contact could not be found.' };

  const result = await removeContact(ctx, id.data.contactId);
  revalidatePath('/phone');
  return shape(result);
}

/**
 * One contact's calls, texts and recordings.
 *
 * An action rather than page props because the panel loads it on demand: a
 * user with two hundred contacts should not pay for two hundred histories to
 * open the page.
 */
export async function contactActivityAction(contactId: string): Promise<ContactActivity> {
  const ctx = await authorize();

  const id = idSchema.safeParse({ contactId });
  if (!id.success) return { calls: [], messages: [] };

  return contactActivity(ctx, id.data.contactId);
}
