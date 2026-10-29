/**
 * Every way the link page can have no form: submitted (thank you), expired,
 * voided, unknown, or too many attempts. Plain, calm, and specific about
 * what to do next — never a stack trace, never a hint about other merchants.
 */
import { Icon, type IconName } from '@/proto/ui/icons';

const COPY: Record<string, { icon: IconName; tone: 'ok' | 'neutral' | 'warn'; title: string; body: string }> = {
  submitted: {
    icon: 'check',
    tone: 'ok',
    title: 'Thank you — your application is in',
    body: 'We have received your answers and will be in touch if we need anything else. This link is now read-only, so there is nothing more to do here.',
  },
  thanks_pdf: {
    icon: 'check',
    tone: 'ok',
    title: 'Thank you — your PDF is in',
    body: 'We have received your completed application. This link is now closed, so there is nothing more to do here.',
  },
  expired: {
    icon: 'clock',
    tone: 'neutral',
    title: 'This link has expired',
    body: 'For your security, application links only last a limited time. Reply to the email you received and we will send you a new one.',
  },
  voided: {
    icon: 'ban',
    tone: 'neutral',
    title: 'This link is no longer active',
    body: 'This application was withdrawn. If you still need to apply, reply to the email you received and we will send you a new link.',
  },
  not_found: {
    icon: 'link',
    tone: 'neutral',
    title: 'We could not find this application',
    body: 'Check that you opened the full link from your email. If it still does not work, reply to that email and we will send a new one.',
  },
  busy: {
    icon: 'alert-triangle',
    tone: 'warn',
    title: 'Too many attempts',
    body: 'Please wait a few minutes and open the link from your email again.',
  },
};

export function LinkMessage({ state, label, merchant }: { state: string; label?: string; merchant?: string }) {
  const c = COPY[state] ?? COPY.not_found!;
  const ring = c.tone === 'ok' ? 'bg-[#e6f6f2] text-[#0b6b5d]' : c.tone === 'warn' ? 'bg-[#fdf1d8] text-[#8a5a09]' : 'bg-canvas text-ink-500';
  return (
    <main className="flex min-h-dvh items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-[460px] rounded-2xl border border-line bg-white p-8 text-center shadow-[0_12px_40px_-16px_rgba(8,32,47,.25)]">
        <span className={`mx-auto grid size-12 place-items-center rounded-full ${ring}`}>
          <Icon name={c.icon} size={22} />
        </span>
        <h1 className="mt-5 text-[20px] font-semibold tracking-tight text-ink-900">{c.title}</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-600">{c.body}</p>
        {label || merchant ? (
          <p className="mt-6 border-t border-line-soft pt-4 text-[12px] text-ink-400">
            {merchant ? <span className="font-medium text-ink-600">{merchant}</span> : null}
            {merchant && label ? ' · ' : null}
            {label ? <span className="font-mono">{label}</span> : null}
          </p>
        ) : null}
      </div>
    </main>
  );
}
