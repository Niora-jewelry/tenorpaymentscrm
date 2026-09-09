'use client';

/**
 * /signup — invite-only, three steps on ONE page.
 *
 * Spec §4: "Invite exists → OTP email sent; OTP input field appears inline on
 * the same page."
 *
 * The step is decided by the SERVER — each action returns which step to render,
 * so a user cannot skip ahead to the password form by editing local state.
 */
import { useActionState, useState } from 'react';
import Link from 'next/link';
import {
  startSignupAction,
  verifySignupOtpAction,
  completeSignupAction,
  type FormState,
} from '../actions';
import { AuthLayout, Field, CodeInput, Button, Alert, Steps, StepActions, LinkButton } from '../ui';

const initial: FormState = { ok: false, step: 'email' };

export default function SignupPage() {
  const [emailState, emailAction] = useActionState(startSignupAction, initial);
  const [codeState, codeAction] = useActionState(verifySignupOtpAction, initial);
  const [passwordState, passwordAction] = useActionState(completeSignupAction, initial);
  const [typedEmail, setTypedEmail] = useState('');

  const step: 1 | 2 | 3 =
    passwordState.step === 'password' || codeState.step === 'password'
      ? 3
      : emailState.step === 'code' || codeState.step === 'code'
        ? 2
        : 1;

  const email = codeState.email ?? emailState.email ?? typedEmail;

  const titles = {
    1: { title: 'Create your account', subtitle: 'TapDash is invite-only. Use the email your administrator invited.' },
    2: { title: 'Check your email', subtitle: `We sent a 6-digit code to ${email}. It expires in 10 minutes.` },
    3: { title: 'Choose a password', subtitle: 'Last step — pick something you do not use anywhere else.' },
  }[step];

  return (
    <AuthLayout
      title={titles.title}
      subtitle={titles.subtitle}
      footer={
        <p className="text-[13.5px] text-ink-500">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-brand-700 hover:underline">
            Sign in
          </Link>
        </p>
      }
    >
      <Steps current={step} />

      {/* Step 1 — email */}
      {step === 1 ? (
        <>
          {emailState.message ? (
            <Alert tone={emailState.ok ? 'info' : 'error'}>{emailState.message}</Alert>
          ) : null}

          <form action={emailAction} noValidate>
            <Field
              label="Work email"
              name="email"
              type="email"
              autoComplete="username"
              placeholder="you@company.com"
              required
              defaultValue={emailState.email}
              error={emailState.errors?.email}
              onChange={(e) => setTypedEmail(e.currentTarget.value)}
            />
            <Button>Send me a code</Button>
          </form>
        </>
      ) : null}

      {/* Step 2 — code, inline on the same page */}
      {step === 2 ? (
        <>
          {codeState.message && !codeState.ok ? (
            <Alert tone="error">{codeState.message}</Alert>
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
            {/* A full reload, deliberately: the three form states live in
                useActionState and cannot be cleared from inside it, so this is
                the only way to genuinely start over rather than appear to. */}
            <button
              type="button"
              onClick={() => window.location.assign('/signup')}
              className="text-[13.5px] font-medium text-ink-500 underline-offset-2 hover:underline"
            >
              Use a different email
            </button>
          </StepActions>
        </>
      ) : null}

      {/* Step 3 — password. Email and ticket come from HTTP-only cookies, never
          from the form, so this step cannot be aimed at another address. */}
      {step === 3 ? (
        <>
          {passwordState.message ? <Alert tone="error">{passwordState.message}</Alert> : null}

          <form action={passwordAction} noValidate>
            <Field
              label="Your name"
              name="fullName"
              autoComplete="name"
              placeholder="Jordan Ellis"
            />
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              hint="At least 8 characters. Checked against known breached passwords."
              error={passwordState.errors?.password}
            />
            <Field
              label="Confirm password"
              name="confirmPassword"
              type="password"
              autoComplete="new-password"
              required
              error={passwordState.errors?.confirmPassword}
            />
            <Button>Create account</Button>
          </form>

          {/* Always a way back. If the verification window lapses, the user can
              request a fresh code instead of being stranded on this step. */}
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
