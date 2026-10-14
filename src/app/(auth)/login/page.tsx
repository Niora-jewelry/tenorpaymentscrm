'use client';

/**
 * /login — the default page for existing users.
 *
 * Three actions, exactly as specified: Login, Forgot password, Sign up.
 * `?next=` carries the preserved destination and is validated both here (before
 * it reaches the markup) and again server-side before any redirect.
 */
import { useActionState, Suspense } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { loginAction, type FormState } from '../actions';
import { AuthLayout, Field, Button, Alert } from '../ui';
import { safeRedirectPath, DEFAULT_REDIRECT } from '@/lib/security/redirect';
import { env } from '@/lib/env';

const initial: FormState = { ok: false };

/** Why the user was bounced back here, in words they can act on. */
const REASONS: Record<string, string> = {
  suspended: 'Your account has been paused. Contact your administrator.',
  session_revoked: 'Your password changed, so you were signed out. Sign in again.',
  idle: 'You were signed out after 24 hours of inactivity.',
};

function LoginForm({ demoHint }: { demoHint: string | null }) {
  const params = useSearchParams();
  const [state, action] = useActionState(loginAction, initial);

  // Validated before it reaches the markup, not only before the redirect.
  const safeNext = safeRedirectPath(params.get('next'), env.NEXT_PUBLIC_APP_URL);
  const next = safeNext === DEFAULT_REDIRECT ? '' : safeNext;

  const notice = params.get('notice');
  const reason = params.get('reason');
  const reasonMessage = reason ? REASONS[reason] : null;

  return (
    <AuthLayout
      title="Sign in"
      subtitle="Welcome back. Enter your details to continue."
      footer={
        <p className="text-[13.5px] text-ink-500">
          Need an account?{' '}
          <Link href="/signup" className="font-semibold text-brand-700 hover:underline">
            Sign up with your invite
          </Link>
        </p>
      }
    >
      {notice ? <Alert tone="success">{notice}</Alert> : null}
      {reasonMessage ? <Alert>{reasonMessage}</Alert> : null}
      {state.message ? <Alert tone="error">{state.message}</Alert> : null}

      {demoHint ? (
        <Alert>
          <strong className="font-semibold">Demo mode.</strong> Sign in with{' '}
          <code className="rounded bg-white/70 px-1.5 py-0.5 font-mono text-[12.5px]">
            {demoHint}
          </code>
          . Real accounts arrive once the database is connected.
        </Alert>
      ) : null}

      <form action={action} noValidate>
        <input type="hidden" name="next" value={next} />

        <Field
          label="Email"
          name="email"
          type="email"
          autoComplete="username"
          placeholder="you@company.com"
          required
          defaultValue={state.email}
          error={state.errors?.email}
        />

        <div className="mb-5">
          <Field
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            required
            error={state.errors?.password}
          />
          <div className="-mt-3 flex justify-end">
            <Link
              href="/reset-password"
              className="text-[13px] font-medium text-brand-700 hover:underline"
            >
              Forgot password?
            </Link>
          </div>
        </div>

        <Button>Sign in</Button>
      </form>
    </AuthLayout>
  );
}

export default function LoginPage() {
  // Server-injected at build/render time; absent unless demo mode is on.
  const demoHint = process.env.NEXT_PUBLIC_DEMO_HINT || null;

  return (
    <Suspense fallback={<AuthLayout title="Sign in">&nbsp;</AuthLayout>}>
      <LoginForm demoHint={demoHint} />
    </Suspense>
  );
}
