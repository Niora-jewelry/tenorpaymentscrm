'use client';

/**
 * /reset-password — neutral throughout.
 *
 * Spec §5: "never confirms whether an account exists."
 *
 * So the screen advances to the code step for EVERY valid email address,
 * whether or not an account exists. That is not a bug — showing the code box
 * only for real accounts would leak exactly what the neutral flow exists to
 * hide, and so would answering faster for one than the other.
 */
import { useActionState, useState } from 'react';
import Link from 'next/link';
import {
  startResetAction,
  verifyResetOtpAction,
  completeResetAction,
  type FormState,
} from '../actions';
import { AuthLayout, Field, CodeInput, Button, Alert, Steps, StepActions, LinkButton } from '../ui';

const initial: FormState = { ok: false, step: 'email' };

export default function ResetPasswordPage() {
  const [emailState, emailAction] = useActionState(startResetAction, initial);
  const [codeState, codeAction] = useActionState(verifyResetOtpAction, initial);
  const [passwordState, passwordAction] = useActionState(completeResetAction, initial);
  const [typedEmail, setTypedEmail] = useState('');

  const step: 1 | 2 | 3 =
    passwordState.step === 'password' || codeState.step === 'password'
      ? 3
      : emailState.step === 'code' || codeState.step === 'code'
        ? 2
        : 1;

  const email = codeState.email ?? emailState.email ?? typedEmail;

  const titles = {
    1: { title: 'Reset your password', subtitle: "Enter your email and we'll send a 6-digit code." },
    2: { title: 'Check your email', subtitle: 'If that address has an account, a code is on its way.' },
    3: { title: 'Set a new password', subtitle: 'Choose something you do not use anywhere else.' },
  }[step];

  return (
    <AuthLayout
      title={titles.title}
      subtitle={titles.subtitle}
      footer={
        <p className="text-[13.5px] text-ink-500">
          <Link href="/login" className="font-semibold text-brand-700 hover:underline">
            ← Back to sign in
          </Link>
        </p>
      }
    >
      <Steps current={step} />

      {step === 1 ? (
        <form action={emailAction} noValidate>
          <Field
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            placeholder="you@company.com"
            required
            error={emailState.errors?.email}
            onChange={(e) => setTypedEmail(e.currentTarget.value)}
          />
          <Button>Send reset code</Button>
        </form>
      ) : null}

      {step === 2 ? (
        <>
          {codeState.message && !codeState.ok ? (
            <Alert tone="error">{codeState.message}</Alert>
          ) : emailState.message ? (
            <Alert>{emailState.message}</Alert>
          ) : null}

          <form action={codeAction} noValidate>
            <input type="hidden" name="email" value={email} />
            <CodeInput error={codeState.errors?.code} />
            <Button>Verify code</Button>
          </form>

          <StepActions>
            <form action={emailAction}>
              <input type="hidden" name="email" value={email} />
              <LinkButton>Send a new code</LinkButton>
            </form>
            <button
              type="button"
              onClick={() => window.location.assign('/reset-password')}
              className="text-[13.5px] font-medium text-ink-500 underline-offset-2 hover:underline"
            >
              Use a different email
            </button>
          </StepActions>
        </>
      ) : null}

      {step === 3 ? (
        <>
          {passwordState.message ? <Alert tone="error">{passwordState.message}</Alert> : null}
          <Alert>Setting a new password signs you out on every other device.</Alert>

          <form action={passwordAction} noValidate>
            <Field
              label="New password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              hint="At least 8 characters. Checked against known breached passwords."
              error={passwordState.errors?.password}
            />
            <Field
              label="Confirm new password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              error={passwordState.errors?.confirmPassword}
            />
            <Button>Update password</Button>
          </form>

          <StepActions>
            <form action={emailAction}>
              <input type="hidden" name="email" value={email} />
              <LinkButton>Verification expired? Send a new code</LinkButton>
            </form>
          </StepActions>
        </>
      ) : null}
    </AuthLayout>
  );
}
