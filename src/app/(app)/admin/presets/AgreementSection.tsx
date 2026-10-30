'use client';

/**
 * Admin → Presets → Agreements: how long signers have (spec: 30 days),
 * whether the signing service reminds them, the name and address the
 * emails come from, and the email itself — a template with placeholders,
 * filled per merchant when the Send dialog opens.
 */
import { useMemo, useState, useTransition } from 'react';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { saveAgreementSettingsAction } from './agreementActions';

type Initial = { expiresDays: number; reminders: boolean; requesterName: string; requesterEmail: string | null; emailSubject: string; emailMessage: string; configured: boolean; testMode: boolean };

const PLACEHOLDERS: { key: string; means: string; sample: string }[] = [
  { key: 'signer_name', means: 'The first signer’s first name', sample: 'Jane' },
  { key: 'merchant', means: 'The DBA, or the legal name', sample: 'Joe’s Pizza' },
  { key: 'expires', means: 'The day the signing link stops working', sample: 'November 28, 2026' },
  { key: 'sender_name', means: 'The name of the person sending', sample: 'Alex Morgan' },
];
const fill = (text: string) => text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => PLACEHOLDERS.find((p) => p.key === k)?.sample ?? m);

export function AgreementSection({ initial }: { initial: Initial }) {
  const [days, setDays] = useState(String(initial.expiresDays));
  const [reminders, setReminders] = useState(initial.reminders);
  const [name, setName] = useState(initial.requesterName);
  const [email, setEmail] = useState(initial.requesterEmail ?? '');
  const [subject, setSubject] = useState(initial.emailSubject);
  const [message, setMessage] = useState(initial.emailMessage);
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const n = Number(days);
  const daysOk = Number.isInteger(n) && n >= 1 && n <= 365;
  const dirty = n !== saved.expiresDays || reminders !== saved.reminders || name !== saved.requesterName || email !== (saved.requesterEmail ?? '') || subject !== saved.emailSubject || message !== saved.emailMessage;
  const preview = useMemo(() => ({ subject: fill(subject), message: fill(message) }), [subject, message]);

  const save = () =>
    start(async () => {
      setError(null);
      setDone(false);
      const r = await saveAgreementSettingsAction({ expiresDays: n, reminders, requesterName: name, requesterEmail: email.trim() || null, emailSubject: subject, emailMessage: message });
      if (!r.ok) return setError(r.message);
      setSaved({ ...saved, expiresDays: n, reminders, requesterName: name.trim(), requesterEmail: email.trim() || null, emailSubject: subject.trim(), emailMessage: message.trim() });
      setDone(true);
    });

  const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none focus-field';
  const label = 'mb-1 block text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400';

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,42%)]">
      <div className="rounded-xl border border-line bg-white">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink-900">Send Agreement</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">What goes out when someone clicks Send agreement on a record. They can still edit the subject and message before sending.</p>
        </div>
        <div className="space-y-4 px-4 py-4">
          {!initial.configured ? (
            <p className="flex items-start gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] leading-relaxed text-[#8a5a09]">
              <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0" />
              <span>
                The signing service (SignWell) is not connected: set <code className="rounded bg-white px-1 ring-1 ring-[#f7e0af]">SIGNWELL_API_KEY</code> and{' '}
                <code className="rounded bg-white px-1 ring-1 ring-[#f7e0af]">SIGNWELL_WEBHOOK_ID</code> on the deployment. Until then nothing can be sent.
              </span>
            </p>
          ) : initial.testMode ? (
            <p className="flex items-start gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-600">
              <Icon name="info" size={14} className="mt-[2px] shrink-0 text-ink-400" />
              Test mode is on: agreements are watermarked and not binding. Set <code className="rounded bg-white px-1 ring-1 ring-line">SIGNWELL_TEST_MODE=false</code> in production to send real ones.
            </p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="agr-days" className={label}>
                Signing window
              </label>
              <div className="flex items-center gap-2">
                <input id="agr-days" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 3))} className={`${field} w-24 tabular-nums ${daysOk ? '' : 'border-bad'}`} />
                <span className="text-[13px] text-ink-600">days</span>
              </div>
              <p className={`mt-1 text-[12px] ${daysOk ? 'text-ink-400' : 'text-bad'}`}>{daysOk ? 'After this the agreement expires and a new one must be sent.' : 'Between 1 and 365 days.'}</p>
            </div>
            <div>
              <p className={label}>Reminders</p>
              <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-line px-3 py-2 text-[13px] text-ink-800">
                <input type="checkbox" checked={reminders} onChange={(e) => setReminders(e.target.checked)} className="size-4 accent-[#1d4ed8]" />
                Remind signers who have not signed
              </label>
              <p className="mt-1 text-[12px] text-ink-400">The signing service sends them on days 3, 6 and 10. “Send reminder now” on the record works either way.</p>
            </div>
            <div>
              <label htmlFor="agr-name" className={label}>
                Sender name
              </label>
              <input id="agr-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} className={field} />
              <p className="mt-1 text-[12px] text-ink-400">Shown as who the agreement comes from.</p>
            </div>
            <div>
              <label htmlFor="agr-email" className={label}>
                Sender email <span className="font-normal normal-case tracking-normal text-ink-300">— optional</span>
              </label>
              <input id="agr-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} className={field} placeholder="agreements@example.com" />
              <p className="mt-1 text-[12px] text-ink-400">Replies and the audit trail use it. Blank uses the signing account’s own.</p>
            </div>
          </div>
          <div>
            <label htmlFor="agr-subject" className={label}>
              Email subject
            </label>
            <input id="agr-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={field} />
          </div>
          <div>
            <label htmlFor="agr-message" className={label}>
              Email message
            </label>
            <textarea id="agr-message" rows={9} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={5000} className={`${field} resize-y leading-relaxed`} />
          </div>
          <div className="rounded-lg border border-line-soft bg-canvas/50 px-3 py-2.5">
            <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Placeholders</p>
            <ul className="grid gap-1 text-[12.5px] sm:grid-cols-2">
              {PLACEHOLDERS.map((p) => (
                <li key={p.key} className="flex items-baseline gap-2">
                  <code className="shrink-0 rounded bg-white px-1.5 py-px text-[11.5px] text-ink-700 ring-1 ring-line">{`{{${p.key}}}`}</code>
                  <span className="text-ink-500">{p.means}</span>
                </li>
              ))}
            </ul>
          </div>
          {error ? (
            <p role="alert" className="flex items-center gap-2 rounded-lg bg-bad-bg px-3 py-2 text-[12.5px] text-bad">
              <Icon name="alert-triangle" size={13} /> {error}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-3">
            {done && !dirty ? (
              <span className="flex items-center gap-1 text-[12.5px] text-[#0b6b5d]">
                <Icon name="check" size={13} /> Saved
              </span>
            ) : null}
            <Button
              variant="ghost"
              disabled={!dirty || pending}
              onClick={() => {
                setDays(String(saved.expiresDays));
                setReminders(saved.reminders);
                setName(saved.requesterName);
                setEmail(saved.requesterEmail ?? '');
                setSubject(saved.emailSubject);
                setMessage(saved.emailMessage);
              }}
            >
              Undo changes
            </Button>
            <Button variant="primary" icon="check" disabled={!dirty || !daysOk || !name.trim() || !subject.trim() || !message.trim()} loading={pending} loadingLabel="Saving…" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </div>

      <aside className="rounded-xl border border-line bg-white xl:sticky xl:top-4 xl:self-start">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-[13px] font-semibold text-ink-900">Preview</h3>
          <p className="text-[12px] text-ink-500">With sample details. The signing service adds its own button to sign.</p>
        </div>
        <div className="space-y-3 px-4 py-4 text-[13px]">
          <p>
            <span className="text-ink-400">From </span>
            <span className="font-semibold text-ink-900">{name.trim() || 'TapDash'}</span>
            {email.trim() ? <span className="text-ink-500"> &lt;{email.trim()}&gt;</span> : null}
          </p>
          <p>
            <span className="text-ink-400">Subject </span>
            <span className="font-semibold text-ink-900">{preview.subject}</span>
          </p>
          <pre className="whitespace-pre-wrap rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5 font-sans leading-relaxed text-ink-800">{preview.message}</pre>
        </div>
      </aside>
    </div>
  );
}
