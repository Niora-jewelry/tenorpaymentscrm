'use server';

/**
 * Server Actions for every auth form.
 *
 * These get Next.js's built-in Origin/Host check, and `serverActions
 * .allowedOrigins` in next.config.ts pins the accepted origins — together, the
 * CSRF cover for SameSite=Lax session cookies.
 *
 * Each action is a thin shell: parse the input, call the service, translate the
 * result into form state. All rules live in `lib/auth/*`.
 */
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import { requestContext } from '@/lib/security/request';
import { safeRedirectPath } from '@/lib/security/redirect';
import { env } from '@/lib/env';
import {
  startSignupSchema,
  verifyOtpSchema,
  setPasswordSchema,
  loginSchema,
  startResetSchema,
  fieldErrors,
} from '@/lib/auth/schemas';
import { startSignup, verifySignupOtp, completeSignup } from '@/lib/auth/signup';
import { login, logout } from '@/lib/auth/login';
import {
  startPasswordReset,
  verifyResetOtp,
  completePasswordReset,
} from '@/lib/auth/reset';
import { setTicketCookie, readTicketCookie, clearTicketCookie } from '@/lib/auth/ticket-cookie';
import { AUTH_MESSAGES } from '@/lib/auth/messages';

export type FormState = {
  ok: boolean;
  /** Advances the multi-step forms without the client deciding the step. */
  step?: 'email' | 'code' | 'password' | 'done';
  message?: string;
  errors?: Record<string, string>;
  email?: string;
};

async function context() {
  return requestContext(await headers());
}

// ---------------------------------------------------------------------------
// Signup
// ---------------------------------------------------------------------------

export async function startSignupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = startSignupSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { ok: false, step: 'email', errors: fieldErrors(parsed.error) };
  }

  const result = await startSignup(parsed.data.email, await context());

  switch (result.status) {
    case 'otp_sent':
      // The OTP field appears INLINE on the same page (spec §4).
      return { ok: true, step: 'code', email: parsed.data.email, message: AUTH_MESSAGES.otpSent };

    case 'already_registered':
      redirect(`/login?notice=${encodeURIComponent(result.message)}`);
      break;

    default:
      return { ok: false, step: 'email', message: result.message, email: parsed.data.email };
  }

  return { ok: false, step: 'email' };
}

export async function verifySignupOtpAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = verifyOtpSchema.safeParse({
    email: formData.get('email'),
    code: formData.get('code'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      step: 'code',
      errors: fieldErrors(parsed.error),
      email: String(formData.get('email') ?? ''),
    };
  }

  const result = await verifySignupOtp(parsed.data.email, parsed.data.code, await context());

  if (result.status === 'failed') {
    return { ok: false, step: 'code', message: result.message, email: parsed.data.email };
  }

  await setTicketCookie('signup', result.ticket, parsed.data.email);
  return { ok: true, step: 'password', email: parsed.data.email };
}

export async function completeSignupAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = setPasswordSchema.safeParse({
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
    fullName: formData.get('fullName') ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, step: 'password', errors: fieldErrors(parsed.error) };
  }

  // Email and ticket come from HTTP-only cookies, never from the form — so the
  // final step cannot be aimed at a different address than the verified one.
  const held = await readTicketCookie('signup');
  if (!held) {
    return { ok: false, step: 'email', message: AUTH_MESSAGES.verificationExpired };
  }

  const ctx = await context();
  const result = await completeSignup({
    email: held.email,
    ticket: held.ticket,
    password: parsed.data.password,
    confirmPassword: parsed.data.confirmPassword,
    fullName: parsed.data.fullName,
    context: ctx,
  });

  if (result.status === 'failed') {
    return { ok: false, step: 'password', message: result.message };
  }

  await clearTicketCookie('signup');

  // Auto-logged-in and taken directly to /dashboard — "No second manual login
  // step" (Decision B).
  const signedIn = await login(held.email, parsed.data.password, ctx);
  if (signedIn.status !== 'ok') {
    redirect('/login?notice=Account+created.+Please+sign+in.');
  }

  redirect('/dashboard');
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
  });
  if (!parsed.success) {
    return { ok: false, errors: fieldErrors(parsed.error) };
  }

  const result = await login(parsed.data.email, parsed.data.password, await context());

  if (result.status === 'failed') {
    // Always the same string, whatever actually went wrong.
    return { ok: false, message: result.message, email: parsed.data.email };
  }

  // The preserved destination is re-validated here, not trusted.
  redirect(safeRedirectPath(parsed.data.next, env.NEXT_PUBLIC_APP_URL));
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect('/login');
}

// ---------------------------------------------------------------------------
// Password reset — neutral throughout
// ---------------------------------------------------------------------------

export async function startResetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = startResetSchema.safeParse({ email: formData.get('email') });
  if (!parsed.success) {
    return { ok: false, step: 'email', errors: fieldErrors(parsed.error) };
  }

  // Identical response whether or not the account exists, and held to a uniform
  // duration so the timing does not answer the question either.
  const result = await startPasswordReset(parsed.data.email, await context());

  return { ok: true, step: 'code', email: parsed.data.email, message: result.message };
}

export async function verifyResetOtpAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = verifyOtpSchema.safeParse({
    email: formData.get('email'),
    code: formData.get('code'),
  });
  if (!parsed.success) {
    return {
      ok: false,
      step: 'code',
      errors: fieldErrors(parsed.error),
      email: String(formData.get('email') ?? ''),
    };
  }

  const result = await verifyResetOtp(parsed.data.email, parsed.data.code, await context());

  if (result.status === 'failed') {
    return { ok: false, step: 'code', message: result.message, email: parsed.data.email };
  }

  await setTicketCookie('reset', result.ticket, parsed.data.email);
  return { ok: true, step: 'password', email: parsed.data.email };
}

export async function completeResetAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const parsed = setPasswordSchema.safeParse({
    password: formData.get('password'),
    confirmPassword: formData.get('confirmPassword'),
  });
  if (!parsed.success) {
    return { ok: false, step: 'password', errors: fieldErrors(parsed.error) };
  }

  const held = await readTicketCookie('reset');
  if (!held) {
    return { ok: false, step: 'email', message: AUTH_MESSAGES.verificationExpired };
  }

  const result = await completePasswordReset({
    email: held.email,
    ticket: held.ticket,
    password: parsed.data.password,
    confirmPassword: parsed.data.confirmPassword,
    context: await context(),
  });

  if (result.status === 'failed') {
    return { ok: false, step: 'password', message: result.message };
  }

  await clearTicketCookie('reset');
  redirect(`/login?notice=${encodeURIComponent(AUTH_MESSAGES.passwordChanged)}`);
}
