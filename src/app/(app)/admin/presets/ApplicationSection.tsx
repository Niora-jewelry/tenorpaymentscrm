'use client';

/**
 * Admin → Presets → Application: the Prepopulated Application's settings
 * (spec: the link "expires after 30 days (adjustable in admin settings)"; the
 * Send modal's "subject and message come from an editable template").
 *
 * The template is plain text with placeholders, filled per merchant when the
 * Send dialog opens — where it can still be edited before sending.
 */
import { useMemo, useState, useTransition } from 'react';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { saveApplicationSettingsAction } from './applicationActions';

const PLACEHOLDERS: { key: string; means: string; sample: string }[] = [
  { key: 'contact_name', means: 'The contact’s first name ("there" when unknown)', sample: 'Joe' },
  { key: 'merchant', means: 'The DBA, or the legal name', sample: 'Joe’s Pizza' },
  { key: 'link', means: 'The merchant’s secure link (added at the end if left out)', sample: 'Complete the application online' },
  { key: 'expires', means: 'The day the link stops working', sample: 'November 28, 2026' },
  { key: 'sender_name', means: 'The name of the person sending', sample: 'Alex Morgan' },
];

const fill = (text: string) =>
  text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k: string) => PLACEHOLDERS.find((p) => p.key === k)?.sample ?? m);

export function ApplicationSection({ initial }: { initial: { linkExpiryDays: number; emailSubject: string; emailBody: string } }) {
  const [days, setDays] = useState(String(initial.linkExpiryDays));
  const [subject, setSubject] = useState(initial.emailSubject);
  const [body, setBody] = useState(initial.emailBody);
  const [saved, setSaved] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, start] = useTransition();

  const n = Number(days);
  const daysOk = Number.isInteger(n) && n >= 1 && n <= 365;
  const dirty = n !== saved.linkExpiryDays || subject !== saved.emailSubject || body !== saved.emailBody;
  const preview = useMemo(() => {
    const b = body.includes('{{link}}') ? body : `${body.trimEnd()}\n\n{{link}}`;
    return { subject: fill(subject), body: fill(b) };
  }, [subject, body]);

  const save = () =>
    start(async () => {
      setError(null);
      setDone(false);
      const r = await saveApplicationSettingsAction({ linkExpiryDays: n, emailSubject: subject, emailBody: body });
      if (!r.ok) return setError(r.message);
      setSaved({ linkExpiryDays: n, emailSubject: subject.trim(), emailBody: body.trim() });
      setDone(true);
    });

  const field = 'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none focus-field';
  const label = 'mb-1 block text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400';

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(320px,42%)]">
      <div className="rounded-xl border border-line bg-white">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink-900">Send Application</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">
            What goes out when someone clicks Send application on a record. They can still edit the subject and message before sending.
          </p>
        </div>
        <div className="space-y-4 px-4 py-4">
          <div>
            <label htmlFor="app-days" className={label}>
              Link lifetime
            </label>
            <div className="flex items-center gap-2">
              <input
                id="app-days"
                inputMode="numeric"
                value={days}
                onChange={(e) => setDays(e.target.value.replace(/\D/g, '').slice(0, 3))}
                className={`${field} w-24 tabular-nums ${daysOk ? '' : 'border-bad'}`}
              />
              <span className="text-[13px] text-ink-600">days</span>
            </div>
            <p className={`mt-1 text-[12px] ${daysOk ? 'text-ink-400' : 'text-bad'}`}>
              {daysOk
                ? 'The merchant’s link stops working after this, or when the application is voided. Resending restarts it.'
                : 'Between 1 and 365 days.'}
            </p>
          </div>
          <div>
            <label htmlFor="app-subject" className={label}>
              Email subject
            </label>
            <input id="app-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={200} className={field} />
          </div>
          <div>
            <label htmlFor="app-body" className={label}>
              Email message
            </label>
            <textarea id="app-body" rows={11} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} className={`${field} resize-y leading-relaxed`} />
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
            <Button variant="ghost" disabled={!dirty || pending} onClick={() => (setDays(String(saved.linkExpiryDays)), setSubject(saved.emailSubject), setBody(saved.emailBody))}>
              Undo changes
            </Button>
            <Button variant="primary" icon="check" disabled={!dirty || !daysOk || !subject.trim() || !body.trim()} loading={pending} loadingLabel="Saving…" onClick={save}>
              Save
            </Button>
          </div>
        </div>
      </div>

      <aside className="rounded-xl border border-line bg-white xl:sticky xl:top-4 xl:self-start">
        <div className="border-b border-line px-4 py-3">
          <h3 className="text-[13px] font-semibold text-ink-900">Preview</h3>
          <p className="text-[12px] text-ink-500">With sample details. The PDF is attached to every email.</p>
        </div>
        <div className="space-y-3 px-4 py-4 text-[13px]">
          <p>
            <span className="text-ink-400">Subject </span>
            <span className="font-semibold text-ink-900">{preview.subject}</span>
          </p>
          <div className="whitespace-pre-wrap rounded-lg border border-line-soft bg-canvas/40 px-3 py-3 leading-relaxed text-ink-700">
            {preview.body.split('Complete the application online').map((part, i, all) => (
              <span key={i}>
                {part}
                {i < all.length - 1 ? <span className="font-semibold text-brand-700 underline underline-offset-2">Complete the application online</span> : null}
              </span>
            ))}
          </div>
          <p className="flex items-center gap-2 rounded-lg border border-line-soft px-3 py-2 text-[12.5px] text-ink-600">
            <Icon name="paperclip" size={13} className="text-ink-400" /> TapDash Application - Joe’s Pizza.pdf
          </p>
        </div>
      </aside>
    </div>
  );
}
