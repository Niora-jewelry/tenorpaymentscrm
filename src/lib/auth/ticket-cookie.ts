/**
 * The verification ticket cookie.
 *
 * After an OTP is verified the server issues a ticket. Only its HASH is stored
 * in the database; the ticket itself rides in an HTTP-only cookie so that the
 * browser cannot read it and the client never carries "I verified the OTP" as
 * state the server would have to trust.
 *
 * Scoped, short-lived, single-use, and cleared the moment it is spent.
 */
import 'server-only';
import { cookies } from 'next/headers';
import { isProduction } from '@/lib/env.server';
import { TICKET_TTL_SECONDS } from '@/lib/security/otp';

const SIGNUP_TICKET = 'td_signup_ticket';
const SIGNUP_EMAIL = 'td_signup_email';
const RESET_TICKET = 'td_reset_ticket';
const RESET_EMAIL = 'td_reset_email';

function names(purpose: 'signup' | 'reset') {
  return purpose === 'signup'
    ? { ticket: SIGNUP_TICKET, email: SIGNUP_EMAIL }
    : { ticket: RESET_TICKET, email: RESET_EMAIL };
}

export async function setTicketCookie(
  purpose: 'signup' | 'reset',
  ticket: string,
  email: string,
): Promise<void> {
  const store = await cookies();
  const { ticket: ticketName, email: emailName } = names(purpose);

  const options = {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    maxAge: TICKET_TTL_SECONDS,
  };

  store.set(ticketName, ticket, options);
  // The email is pinned server-side too, so the final step cannot be pointed at
  // a different address than the one that was verified.
  store.set(emailName, email.trim().toLowerCase(), options);
}

export async function readTicketCookie(
  purpose: 'signup' | 'reset',
): Promise<{ ticket: string; email: string } | null> {
  const store = await cookies();
  const { ticket: ticketName, email: emailName } = names(purpose);

  const ticket = store.get(ticketName)?.value;
  const email = store.get(emailName)?.value;

  if (!ticket || !email) return null;
  return { ticket, email };
}

export async function clearTicketCookie(purpose: 'signup' | 'reset'): Promise<void> {
  const store = await cookies();
  const { ticket: ticketName, email: emailName } = names(purpose);
  store.delete(ticketName);
  store.delete(emailName);
}
