'use client';

/**
 * The application, as a form — rendered from the catalog, so it asks exactly
 * what the PDF asks, in the same sections and order (spec, Online path).
 *
 *   yes / no                 radio buttons, with the details box when Yes
 *   "select all that apply"  checkboxes
 *   single-choice ranges     radio buttons
 *   dates                    a date picker
 *   owners                   Owner 1 + "Add another owner", up to 4; first and
 *                            last name as separate inputs, joined on save
 *   SSNs                     never shown: "On file (•••-••-1234)" + Replace
 *
 * Used by the merchant's link page and by the CRM's "enter the answers by
 * hand" screen next to an unreadable PDF.
 */
import { useId, useMemo, useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import {
  MAX_OWNERS,
  OWNER_LABELS,
  QUESTIONS,
  SECTIONS,
  ownerField,
  type AddressAnswer,
  type AnswerValue,
  type Answers,
  type Question,
  type SectionId,
} from '@/lib/applications/catalog';

export type FormProps = {
  answers: Answers;
  onChange: (next: Answers) => void;
  problems: Record<string, string>;
  ssnOnFile: Record<number, string>;
  ssnEntered: Record<number, string>;
  disabled?: boolean;
  /** One page of the form (the merchant's step-by-step link); every section when absent. */
  only?: SectionId;
};

const input =
  'w-full rounded-lg border bg-white px-3 py-2 text-[14px] text-ink-900 outline-none transition-colors placeholder:text-ink-300 focus-field disabled:bg-canvas disabled:text-ink-500';
const labelCls = 'mb-1.5 block text-[13px] font-medium text-ink-800';

const str = (v: AnswerValue | undefined) => (typeof v === 'string' ? v : '');
const arr = (v: AnswerValue | undefined) => (Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []);
const addr = (v: AnswerValue | undefined): AddressAnswer =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? v
    : { street: typeof v === 'string' ? v : '', street2: '', city: '', state: '', zip: '' };

function Problem({ text, id }: { text?: string; id?: string }) {
  if (!text) return null;
  return (
    <p id={id} className="mt-1.5 flex items-center gap-1.5 text-[12.5px] font-medium text-bad">
      <Icon name="alert-triangle" size={12} />
      {text}
    </p>
  );
}

function Choice({
  type,
  name,
  checked,
  label,
  onChange,
  disabled,
}: {
  type: 'radio' | 'checkbox';
  name: string;
  checked: boolean;
  label: string;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <label
      className={`inline-flex cursor-pointer select-none items-center gap-2 rounded-lg border px-3 py-2 text-[13.5px] transition-colors ${
        checked ? 'border-brand-600 bg-brand-50 font-medium text-brand-800' : 'border-line bg-white text-ink-700 hover:border-ink-300'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <input type={type} name={name} checked={checked} onChange={onChange} disabled={disabled} className="size-4 accent-[#1d4ed8]" />
      {label}
    </label>
  );
}

function QuestionInput({ q, a, set, problems, disabled }: { q: Question; a: Answers; set: (k: string, v: AnswerValue) => void; problems: Record<string, string>; disabled?: boolean }) {
  const id = useId();
  const err = problems[q.id];
  const ring = err ? 'border-bad' : 'border-line';
  const described = err ? `${id}-err` : undefined;

  const control = (() => {
    switch (q.kind) {
      case 'long_text':
        return <textarea id={id} rows={3} value={str(a[q.id])} onChange={(e) => set(q.id, e.target.value)} disabled={disabled} aria-describedby={described} className={`${input} ${ring} resize-y`} />;
      case 'date':
        return <input id={id} type="date" value={str(a[q.id]).slice(0, 10)} onChange={(e) => set(q.id, e.target.value)} disabled={disabled} className={`${input} ${ring}`} />;
      case 'money':
        return (
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-[14px] text-ink-400">$</span>
            <input id={id} inputMode="decimal" value={str(a[q.id])} onChange={(e) => set(q.id, e.target.value)} disabled={disabled} className={`${input} ${ring} pl-7 tabular-nums`} />
          </div>
        );
      case 'count':
        return <input id={id} inputMode="numeric" value={str(a[q.id])} onChange={(e) => set(q.id, e.target.value)} disabled={disabled} className={`${input} ${ring} tabular-nums`} />;
      case 'address': {
        const v = addr(a[q.id]);
        const put = (patch: Partial<AddressAnswer>) => set(q.id, { ...v, ...patch });
        return (
          <div className="grid grid-cols-6 gap-2">
            <input aria-label={`${q.label} — street`} placeholder="Street address" value={v.street} onChange={(e) => put({ street: e.target.value })} disabled={disabled} className={`${input} ${ring} col-span-6 sm:col-span-4`} />
            <input aria-label={`${q.label} — suite`} placeholder="Suite / unit" value={v.street2} onChange={(e) => put({ street2: e.target.value })} disabled={disabled} className={`${input} border-line col-span-6 sm:col-span-2`} />
            <input aria-label={`${q.label} — city`} placeholder="City" value={v.city} onChange={(e) => put({ city: e.target.value })} disabled={disabled} className={`${input} border-line col-span-3`} />
            <input aria-label={`${q.label} — state`} placeholder="State" maxLength={2} value={v.state} onChange={(e) => put({ state: e.target.value.toUpperCase() })} disabled={disabled} className={`${input} border-line col-span-1 uppercase`} />
            <input aria-label={`${q.label} — ZIP`} placeholder="ZIP" inputMode="numeric" value={v.zip} onChange={(e) => put({ zip: e.target.value })} disabled={disabled} className={`${input} border-line col-span-2 tabular-nums`} />
          </div>
        );
      }
      case 'radio':
        return (
          <div role="radiogroup" aria-labelledby={`${id}-l`} className="flex flex-wrap gap-2">
            {q.options!.map((o) => (
              <Choice key={o.value} type="radio" name={q.id} label={o.label} checked={str(a[q.id]) === o.value} onChange={() => set(q.id, o.value)} disabled={disabled} />
            ))}
          </div>
        );
      case 'single_checkbox':
        return (
          <div role="radiogroup" aria-labelledby={`${id}-l`} className="flex flex-wrap gap-2">
            {q.options!.map((o) => (
              <Choice key={o.value} type="radio" name={q.id} label={o.label} checked={arr(a[q.id])[0] === o.value} onChange={() => set(q.id, [o.value])} disabled={disabled} />
            ))}
          </div>
        );
      case 'checkboxes': {
        const on = arr(a[q.id]);
        return (
          <div role="group" aria-labelledby={`${id}-l`} className="flex flex-wrap gap-2">
            {q.options!.map((o) => (
              <Choice
                key={o.value}
                type="checkbox"
                name={`${q.id}__${o.value}`}
                label={o.label}
                checked={on.includes(o.value)}
                onChange={() => set(q.id, on.includes(o.value) ? on.filter((x) => x !== o.value) : [...on, o.value])}
                disabled={disabled}
              />
            ))}
          </div>
        );
      }
      case 'percent_group': {
        const parts = q.options!.map((o) => ({ o, v: str(a[`${q.id}_${o.value}`]) }));
        const total = parts.reduce((s, p) => s + (Number(p.v.replace(/[%\s]/g, '')) || 0), 0);
        const any = parts.some((p) => p.v.trim());
        return (
          <div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {parts.map(({ o, v }) => (
                <label key={o.value} className="block">
                  <span className="mb-1 block text-[12px] text-ink-500">{o.label}</span>
                  <span className="relative block">
                    <input inputMode="decimal" value={v} onChange={(e) => set(`${q.id}_${o.value}`, e.target.value)} disabled={disabled} className={`${input} ${ring} pr-7 tabular-nums`} />
                    <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[13px] text-ink-400">%</span>
                  </span>
                </label>
              ))}
            </div>
            {any ? (
              <p className={`mt-1.5 text-[12px] font-medium tabular-nums ${Math.abs(total - 100) < 0.01 ? 'text-[#0b6b5d]' : 'text-ink-500'}`}>
                Total {Math.round(total * 100) / 100}% {Math.abs(total - 100) < 0.01 ? '✓' : 'of 100%'}
              </p>
            ) : null}
          </div>
        );
      }
      default:
        return (
          <input
            id={id}
            type={q.kind === 'email' ? 'email' : q.kind === 'phone' ? 'tel' : q.kind === 'url' ? 'url' : 'text'}
            inputMode={q.kind === 'phone' ? 'tel' : undefined}
            autoComplete={q.kind === 'email' ? 'email' : q.kind === 'phone' ? 'tel' : 'off'}
            placeholder={q.placeholder}
            value={str(a[q.id])}
            onChange={(e) => set(q.id, e.target.value)}
            disabled={disabled}
            aria-invalid={!!err || undefined}
            aria-describedby={described}
            className={`${input} ${ring}`}
          />
        );
    }
  })();

  const showDetails = q.details && (str(a[q.id]) === q.details.requiredWhen || str(a[q.details.id]));

  return (
    <div className={q.half ? 'sm:col-span-1' : 'sm:col-span-2'}>
      {['radio', 'single_checkbox', 'checkboxes', 'percent_group', 'address'].includes(q.kind) ? (
        <p id={`${id}-l`} className={labelCls}>
          {q.label}
        </p>
      ) : (
        <label htmlFor={id} className={labelCls}>
          {q.label}
        </label>
      )}
      {control}
      <Problem text={err} id={described} />
      {showDetails ? (
        <div className="mt-2.5">
          <label className="mb-1 block text-[12.5px] font-medium text-ink-600">
            {q.details!.label}
            {str(a[q.id]) === q.details!.requiredWhen ? <span className="text-bad"> *</span> : null}
          </label>
          <textarea
            rows={2}
            value={str(a[q.details!.id])}
            onChange={(e) => set(q.details!.id, e.target.value)}
            disabled={disabled}
            className={`${input} ${problems[q.details!.id] ? 'border-bad' : 'border-line'} resize-y`}
          />
          <Problem text={problems[q.details!.id]} />
        </div>
      ) : null}
      {q.comments ? (
        <div className="mt-2.5">
          <label className="mb-1 block text-[12.5px] font-medium text-ink-600">{q.comments.label}</label>
          <textarea rows={2} value={str(a[q.comments.id])} onChange={(e) => set(q.comments!.id, e.target.value)} disabled={disabled} className={`${input} border-line resize-y`} />
        </div>
      ) : null}
    </div>
  );
}

function Owners({
  a,
  set,
  onNames,
  problems,
  ssnOnFile,
  ssnEntered,
  disabled,
}: {
  a: Answers;
  set: (k: string, v: AnswerValue) => void;
  onNames: (n: number, first: string, last: string) => void;
  problems: Record<string, string>;
  ssnOnFile: Record<number, string>;
  ssnEntered: Record<number, string>;
  disabled?: boolean;
}) {
  const used = useMemo(() => {
    let n = 1;
    for (let i = 1; i <= MAX_OWNERS; i++) {
      if (['name', 'first', 'last', 'title', 'percentage', 'email', 'phone', 'ssn'].some((p) => str(a[ownerField(i, p as 'name')]).trim()) || ssnOnFile[i] || ssnEntered[i]) n = i;
    }
    return n;
  }, [a, ssnOnFile, ssnEntered]);
  const [count, setCount] = useState(used);
  const shown = Math.max(count, used);
  const [replacing, setReplacing] = useState<Record<number, boolean>>({});
  const total = Array.from({ length: shown }, (_, i) => Number(str(a[ownerField(i + 1, 'percentage')]).replace(/[%\s]/g, '')) || 0).reduce((s, x) => s + x, 0);

  const clear = (n: number) => {
    for (const p of ['name', 'first', 'last', 'title', 'percentage', 'email', 'phone', 'ssn'] as const) set(ownerField(n, p), '');
    setCount(n - 1);
  };

  return (
    <div className="space-y-3 sm:col-span-2">
      {Array.from({ length: shown }, (_, i) => i + 1).map((n) => {
        // A name that arrived as one value (an older draft) still shows split.
        const legacy = str(a[ownerField(n, 'name')]).trim();
        const sp = legacy.indexOf(' ');
        const first = str(a[ownerField(n, 'first')]) || (legacy && !a[ownerField(n, 'last')] ? (sp < 0 ? legacy : legacy.slice(0, sp)) : '');
        const last = str(a[ownerField(n, 'last')]) || (legacy && !a[ownerField(n, 'first')] && sp > 0 ? legacy.slice(sp + 1) : '');
        const put = (f: string, l: string) => onNames(n, f, l);
        const masked = ssnEntered[n] ?? ssnOnFile[n];
        const typing = replacing[n] || !masked || str(a[ownerField(n, 'ssn')]) !== '';
        const err = (p: string) => problems[ownerField(n, p as 'name')];
        return (
          <fieldset key={n} className="rounded-xl border border-line bg-canvas/40 p-4">
            <legend className="sr-only">Owner {n}</legend>
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[13px] font-semibold text-ink-900">Owner {n}</p>
              {n > 1 && n === shown && !disabled ? (
                <button type="button" onClick={() => clear(n)} className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-ink-500 hover:bg-white hover:text-bad">
                  <Icon name="trash" size={12} /> Remove
                </button>
              ) : null}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={labelCls}>First name</span>
                <input value={first} onChange={(e) => put(e.target.value, last)} disabled={disabled} autoComplete="off" className={`${input} ${err('name') ? 'border-bad' : 'border-line'}`} />
              </label>
              <label className="block">
                <span className={labelCls}>Last name</span>
                <input value={last} onChange={(e) => put(first, e.target.value)} disabled={disabled} autoComplete="off" className={`${input} ${err('name') ? 'border-bad' : 'border-line'}`} />
              </label>
              {err('name') ? <div className="sm:col-span-2 -mt-2"><Problem text={err('name')} /></div> : null}
              <label className="block">
                <span className={labelCls}>{OWNER_LABELS.title}</span>
                <input value={str(a[ownerField(n, 'title')])} onChange={(e) => set(ownerField(n, 'title'), e.target.value)} disabled={disabled} className={`${input} border-line`} />
              </label>
              <label className="block">
                <span className={labelCls}>{OWNER_LABELS.percentage}</span>
                <span className="relative block">
                  <input inputMode="decimal" value={str(a[ownerField(n, 'percentage')])} onChange={(e) => set(ownerField(n, 'percentage'), e.target.value)} disabled={disabled} className={`${input} ${err('percentage') ? 'border-bad' : 'border-line'} pr-7 tabular-nums`} />
                  <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[13px] text-ink-400">%</span>
                </span>
                <Problem text={err('percentage')} />
              </label>
              <label className="block">
                <span className={labelCls}>{OWNER_LABELS.email}</span>
                <input type="email" value={str(a[ownerField(n, 'email')])} onChange={(e) => set(ownerField(n, 'email'), e.target.value)} disabled={disabled} className={`${input} ${err('email') ? 'border-bad' : 'border-line'}`} />
                <Problem text={err('email')} />
              </label>
              <label className="block">
                <span className={labelCls}>{OWNER_LABELS.phone}</span>
                <input type="tel" value={str(a[ownerField(n, 'phone')])} onChange={(e) => set(ownerField(n, 'phone'), e.target.value)} disabled={disabled} className={`${input} ${err('phone') ? 'border-bad' : 'border-line'}`} />
                <Problem text={err('phone')} />
              </label>
              <div className="sm:col-span-2">
                <span className={labelCls}>{OWNER_LABELS.ssn}</span>
                {typing ? (
                  <input
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="123-45-6789"
                    value={str(a[ownerField(n, 'ssn')])}
                    onChange={(e) => set(ownerField(n, 'ssn'), e.target.value.replace(/[^\d-]/g, '').slice(0, 11))}
                    disabled={disabled}
                    className={`${input} ${err('ssn') ? 'border-bad' : 'border-line'} max-w-[220px] tabular-nums`}
                  />
                ) : (
                  <p className="flex flex-wrap items-center gap-2 text-[13.5px] text-ink-700">
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-2 tabular-nums">
                      <Icon name="lock" size={12} className="text-ink-400" />
                      {ssnEntered[n] ? 'Entered' : 'On file'} ({masked})
                    </span>
                    {!disabled ? (
                      <button type="button" onClick={() => setReplacing((r) => ({ ...r, [n]: true }))} className="text-[12.5px] font-semibold text-brand-700 hover:underline">
                        Replace
                      </button>
                    ) : null}
                  </p>
                )}
                <Problem text={err('ssn')} />
              </div>
            </div>
          </fieldset>
        );
      })}
      <div className="flex flex-wrap items-center justify-between gap-2">
        {shown < MAX_OWNERS && !disabled ? (
          <button type="button" onClick={() => setCount(shown + 1)} className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-ink-300 px-3 py-2 text-[13px] font-semibold text-ink-700 hover:border-brand-600 hover:bg-brand-50 hover:text-brand-700">
            <Icon name="plus" size={13} /> Add another owner
          </button>
        ) : (
          <span />
        )}
        <p className={`text-[12.5px] font-medium tabular-nums ${total >= 51 ? 'text-[#0b6b5d]' : 'text-ink-500'}`}>Ownership listed: {Math.round(total * 100) / 100}% {total >= 51 ? '✓' : '· at least 51%'}</p>
      </div>
      <Problem text={problems.owners} />
    </div>
  );
}

export function ApplicationForm({ answers, onChange, problems, ssnOnFile, ssnEntered, disabled, only }: FormProps) {
  const set = (k: string, v: AnswerValue) => onChange({ ...answers, [k]: v });
  // First and last change together, and replace any one-box name.
  const onNames = (n: number, first: string, last: string) =>
    onChange({ ...answers, [ownerField(n, 'first')]: first, [ownerField(n, 'last')]: last, [ownerField(n, 'name')]: '' });
  return (
    <div className="space-y-5">
      {SECTIONS.map((s, i) => only && s.id !== only ? null : (
        <section key={s.id} aria-labelledby={`sec-${s.id}`} className="rounded-2xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(8,32,47,.04)] sm:p-6">
          <header className="mb-5 flex items-baseline gap-3 border-b border-line-soft pb-3">
            <span className="font-mono text-[12px] font-semibold text-ink-300">{String(i + 1).padStart(2, '0')}</span>
            <div>
              <h2 id={`sec-${s.id}`} className="text-[16px] font-semibold text-ink-900">
                {s.title}
              </h2>
              <p className="text-[12.5px] text-ink-500">{s.blurb}</p>
            </div>
          </header>
          <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
            {s.id === 'ownership' ? (
              <Owners a={answers} set={set} onNames={onNames} problems={problems} ssnOnFile={ssnOnFile} ssnEntered={ssnEntered} disabled={disabled} />
            ) : (
              QUESTIONS.filter((q) => q.section === s.id).map((q) => <QuestionInput key={q.id} q={q} a={answers} set={set} problems={problems} disabled={disabled} />)
            )}
          </div>
        </section>
      ))}
    </div>
  );
}
