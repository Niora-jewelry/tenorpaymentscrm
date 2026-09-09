'use client';

/**
 * Auth screen components.
 *
 * Layout: a two-panel split. The left panel carries the brand gradient and
 * grounds the product; the right holds the form on a clean surface. This is
 * deliberate for a CRM — people sign in here every single morning, so the screen
 * should feel like a workplace tool rather than a marketing page.
 *
 * Accent discipline: the lime (#d5ff4a) appears exactly twice per screen — the
 * primary button and one mark in the brand panel. It never carries text on a
 * light ground, where its contrast is 1.4:1.
 */
import { useFormStatus } from 'react-dom';
import { useState, useId } from 'react';

/* -------------------------------------------------------------------------- */
/* Brand                                                                       */
/* -------------------------------------------------------------------------- */

export function Wordmark({ onDark = false }: { onDark?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-2.5 font-semibold tracking-tight ${
        onDark ? 'text-white' : 'text-ink-900'
      }`}
    >
      <span
        aria-hidden
        className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent text-[15px]
                   font-bold text-accent-ink"
      >
        T
      </span>
      <span className="text-[17px]">TapDash</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

const MODULES = ['Records List', 'Leads', 'Deals', 'Contacts', 'Tickets', 'Residuals'];

export function AuthLayout({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1fr)]">
      {/* Brand panel — hidden below lg, where it would only push the form off
          the fold on a phone. */}
      <aside className="brand-gradient relative hidden overflow-hidden px-14 py-12 lg:flex lg:flex-col">
        {/* Lime bloom, low opacity: presence without competing with the form. */}
        <div
          aria-hidden
          className="pointer-events-none absolute -right-32 top-[22%] h-[520px] w-[520px] rounded-full opacity-20 blur-3xl"
          style={{ background: 'radial-gradient(circle, #d5ff4a 0%, transparent 70%)' }}
        />
        {/* Grid, echoing the dashboard this signs you into. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.06]"
          style={{
            backgroundImage:
              'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
            backgroundSize: '56px 56px',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 bottom-0 h-56"
          style={{ background: 'linear-gradient(to top, rgba(1,39,64,0.45), transparent)' }}
        />

        <div className="relative">
          <Wordmark onDark />
        </div>

        <div className="relative mt-auto max-w-[440px]">
          <p className="text-[12px] font-bold uppercase tracking-[0.18em] text-accent">
            Merchant services CRM
          </p>
          <h2 className="mt-5 text-[36px] font-semibold leading-[1.12] tracking-[-0.02em] text-white">
            One record.
            <br />
            Every view of it.
          </h2>
          <p className="mt-5 text-[15px] leading-[1.65] text-brand-100">
            Leads, deals, contacts, tickets and residuals all read from a single
            store — so nothing is duplicated, and nothing is lost when a record
            moves between them.
          </p>

          {/* The module inventory, as a quiet proof of scope. */}
          <ul className="mt-8 flex flex-wrap gap-2">
            {MODULES.map((module) => (
              <li
                key={module}
                className="rounded-full border border-white/18 bg-white/8 px-3 py-1.5
                           text-[12.5px] font-medium text-white/85 backdrop-blur-sm"
              >
                {module}
              </li>
            ))}
          </ul>
        </div>

        <div className="relative mt-12 flex items-center gap-2.5 border-t border-white/12 pt-6 text-[13px] text-brand-100/80">
          <ShieldIcon />
          <span>Invite-only access · every action recorded</span>
        </div>
      </aside>

      {/* Form panel */}
      <main className="flex flex-col justify-center bg-canvas px-5 py-10 sm:px-10 lg:px-14">
        <div className="mx-auto w-full max-w-[430px]">
          <div className="mb-8 lg:hidden">
            <Wordmark />
          </div>

          <div
            className="rounded-[18px] border border-line bg-surface px-7 py-8 sm:px-9 sm:py-10"
            style={{
              boxShadow:
                '0 1px 2px rgba(8,32,47,0.04), 0 8px 28px -12px rgba(8,32,47,0.14)',
            }}
          >
            <header>
              <h1 className="text-[25px] font-semibold leading-tight tracking-[-0.015em] text-ink-900">
                {title}
              </h1>
              {subtitle ? (
                <p className="mt-2 text-[14.5px] leading-relaxed text-ink-500">{subtitle}</p>
              ) : null}
            </header>

            <div className="mt-7">{children}</div>

            {footer ? (
              <div className="mt-7 border-t border-line-soft pt-5">{footer}</div>
            ) : null}
          </div>

          <p className="mt-6 text-center text-[12.5px] text-ink-400">
            Protected by invite-only access. Every sign-in is recorded.
          </p>
        </div>
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Form controls                                                               */
/* -------------------------------------------------------------------------- */

export function Field({
  label,
  name,
  type = 'text',
  error,
  hint,
  ...rest
}: {
  label: string;
  name: string;
  type?: string;
  error?: string;
  hint?: string;
} & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const isPassword = type === 'password';
  const [revealed, setRevealed] = useState(false);

  return (
    <div className="mb-5">
      <label htmlFor={id} className="mb-1.5 block text-[13.5px] font-medium text-ink-700">
        {label}
      </label>

      <div className="relative">
        <input
          id={id}
          name={name}
          type={isPassword && revealed ? 'text' : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
          className={`w-full rounded-[10px] border bg-white px-3.5 py-2.5 text-[15px]
                      text-ink-900 placeholder:text-ink-400
                      transition-[border-color,box-shadow] duration-150
                      focus:outline-none focus:ring-4
                      ${isPassword ? 'pr-[74px]' : ''}
                      ${
                        error
                          ? 'border-bad focus:border-bad focus:ring-bad/12'
                          : 'border-line focus-underline focus:ring-brand-600/12'
                      }`}
          {...rest}
        />

        {isPassword ? (
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1
                       text-[12.5px] font-semibold text-ink-500 hover:bg-canvas hover:text-ink-700"
            aria-label={revealed ? 'Hide password' : 'Show password'}
          >
            {revealed ? 'Hide' : 'Show'}
          </button>
        ) : null}
      </div>

      {error ? (
        <p id={`${id}-error`} role="alert" className="mt-1.5 text-[13px] text-bad">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-[13px] text-ink-400">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Six separate boxes for the one-time code.
 *
 * Worth the extra code: it makes the expected length obvious without a hint,
 * supports paste across all six, and auto-advances — which matters because
 * people type these from a phone with an inbox open beside them.
 */
export function CodeInput({ name = 'code', error }: { name?: string; error?: string }) {
  const [digits, setDigits] = useState<string[]>(Array(6).fill(''));
  const id = useId();

  function update(index: number, value: string) {
    const cleaned = value.replace(/\D/g, '');
    if (!cleaned) {
      setDigits((prev) => prev.map((d, i) => (i === index ? '' : d)));
      return;
    }

    setDigits((prev) => {
      const next = [...prev];
      // A pasted string fills forward from here rather than filling one box.
      for (let i = 0; i < cleaned.length && index + i < 6; i += 1) {
        next[index + i] = cleaned[i]!;
      }
      return next;
    });

    const focusTarget = Math.min(index + cleaned.length, 5);
    document.getElementById(`${id}-${focusTarget}`)?.focus();
  }

  function onKeyDown(index: number, event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && !digits[index] && index > 0) {
      document.getElementById(`${id}-${index - 1}`)?.focus();
    }
  }

  return (
    <div className="mb-5">
      <span className="mb-1.5 block text-[13.5px] font-medium text-ink-700">6-digit code</span>

      <input type="hidden" name={name} value={digits.join('')} />

      <div className="flex gap-2" role="group" aria-label="6-digit verification code">
        {digits.map((digit, index) => (
          <input
            key={index}
            id={`${id}-${index}`}
            inputMode="numeric"
            autoComplete={index === 0 ? 'one-time-code' : 'off'}
            maxLength={6}
            value={digit}
            onChange={(e) => update(index, e.currentTarget.value)}
            onKeyDown={(e) => onKeyDown(index, e)}
            aria-label={`Digit ${index + 1}`}
            className={`h-[52px] w-full rounded-[10px] border bg-white text-center font-mono
                        text-[19px] font-medium text-ink-900 tabular
                        transition-[border-color,box-shadow] duration-150
                        focus:outline-none focus:ring-4
                        ${
                          error
                            ? 'border-bad focus:border-bad focus:ring-bad/12'
                            : 'border-line focus-underline focus:ring-brand-600/12'
                        }`}
          />
        ))}
      </div>

      {error ? (
        <p role="alert" className="mt-1.5 text-[13px] text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Button({
  children,
  variant = 'primary',
  ...rest
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'secondary' | 'ghost';
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();

  const styles = {
    // The lime, carrying brand-950 text: 14.8:1. One per screen.
    primary:
      'bg-accent text-accent-ink hover:bg-accent-dim active:bg-accent-dim shadow-sm',
    secondary: 'bg-white text-ink-700 border border-line hover:bg-canvas',
    ghost: 'bg-transparent text-brand-700 hover:bg-brand-50',
  }[variant];

  return (
    <button
      type="submit"
      disabled={pending || rest.disabled}
      {...rest}
      className={`inline-flex w-full items-center justify-center gap-2 rounded-[10px]
                  px-4 py-3 text-[14.5px] font-semibold
                  transition-[background-color,opacity] duration-150
                  disabled:cursor-not-allowed disabled:opacity-55 ${styles} ${rest.className ?? ''}`}
    >
      {pending ? <Spinner /> : null}
      {pending ? 'Just a moment…' : children}
    </button>
  );
}

export function Alert({
  children,
  tone = 'info',
}: {
  children: React.ReactNode;
  tone?: 'info' | 'error' | 'success';
}) {
  if (!children) return null;

  const styles = {
    info: 'bg-brand-50 border-brand-100 text-brand-900',
    error: 'bg-bad-bg border-bad/25 text-bad',
    success: 'bg-ok-bg border-ok/25 text-ok',
  }[tone];

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={`mb-5 flex gap-2.5 rounded-[10px] border px-3.5 py-3 text-[13.5px]
                  leading-relaxed ${styles}`}
    >
      <span aria-hidden className="mt-[3px] shrink-0">
        {tone === 'error' ? <AlertIcon /> : tone === 'success' ? <CheckIcon /> : <InfoIcon />}
      </span>
      <span>{children}</span>
    </div>
  );
}

/**
 * A quiet escape hatch under a step.
 *
 * Every multi-step flow needs a visible way backwards. Without one, a user who
 * mistypes their email or lets a code expire has no route except reloading the
 * page and guessing.
 */
export function StepActions({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 border-t border-line-soft pt-4">
      {children}
    </div>
  );
}

export function LinkButton({
  children,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      {...rest}
      className="text-[13.5px] font-medium text-brand-700 underline-offset-2
                 hover:underline disabled:cursor-not-allowed disabled:opacity-55"
    >
      {children}
    </button>
  );
}

/** Numbered progress for the multi-step signup and reset flows. */
export function Steps({ current }: { current: 1 | 2 | 3 }) {
  const labels = ['Email', 'Verify', 'Password'];

  return (
    <ol className="mb-7 flex items-center gap-2" aria-label="Progress">
      {labels.map((label, index) => {
        const step = index + 1;
        const done = step < current;
        const active = step === current;

        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              aria-current={active ? 'step' : undefined}
              className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-[11.5px]
                          font-bold tabular ${
                            done
                              ? 'bg-brand-700 text-white'
                              : active
                                ? 'bg-accent text-accent-ink'
                                : 'bg-line-soft text-ink-400'
                          }`}
            >
              {done ? '✓' : step}
            </span>
            <span
              className={`text-[12.5px] font-medium ${
                active ? 'text-ink-900' : 'text-ink-400'
              }`}
            >
              {label}
            </span>
            {step < 3 ? <span className="h-px flex-1 bg-line-soft" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Icons — inline, so no network request and no icon dependency                */
/* -------------------------------------------------------------------------- */

function Spinner() {
  return (
    <svg className="h-4 w-4 animate-spin" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <path
        d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ShieldIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.5 13 3.5v4c0 3.2-2.1 6.1-5 7-2.9-.9-5-3.8-5-7v-4L8 1.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="m5.8 8 1.6 1.6L10.4 6.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function InfoIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 7.2v4M8 4.8h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6v4.2M8 11.3h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
