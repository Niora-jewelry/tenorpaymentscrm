/**
 * Input schemas.
 *
 * Every server boundary parses with these. Parse, never trust — the validated
 * type IS the function's input type, so there is no unvalidated path through.
 */
import { z } from 'zod';
import { MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH } from '@/lib/security/password';

/**
 * Emails are lowercased and trimmed at BOTH invite creation and signup, so a
 * case mismatch can never lock someone out of an invite meant for them.
 */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Enter a valid email address.');

export const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from your email.');

export const passwordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(MAX_PASSWORD_LENGTH);

export const startSignupSchema = z.object({ email: emailSchema });

export const verifyOtpSchema = z.object({
  email: emailSchema,
  code: otpCodeSchema,
});

export const setPasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
    fullName: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.password === v.confirmPassword, {
    message: 'Both passwords must match.',
    path: ['confirmPassword'],
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Enter your password.'),
  next: z.string().optional(),
});

export const startResetSchema = z.object({ email: emailSchema });

/** Flattens a Zod failure into the first message per field, for form display. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || 'form';
    out[key] ??= issue.message;
  }
  return out;
}
