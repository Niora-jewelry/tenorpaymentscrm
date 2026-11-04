'use client';

/**
 * CRM Settings › Integrations: enter Twilio, Microsoft 365, SignWell, alert
 * email and Maverick Payments keys here instead of in the hosting environment.
 *
 * Each service has (client, 4 Nov 2026):
 *  - an on/off switch that keeps its keys (alert email has none: sign-in codes
 *    depend on it);
 *  - a Help panel: where each value is found in the provider's screens, the
 *    steps in order, and links straight there.
 *
 * A saved secret never comes back to the browser. The screen shows that it is
 * set, who set it and its last four characters, and it can only be replaced.
 */
import { useEffect, useState, useTransition } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import type { IntegrationGroup } from '@/lib/integrations/catalog';
import { HELP } from '@/lib/integrations/help';
import type { ChangeView, GroupView, IntegrationsScreen, SettingView } from '@/lib/integrations/service';
import {
  connectSignwellAction,
  removeIntegrationAction,
  saveIntegrationAction,
  sendTestAlertAction,
  setIntegrationEnabledAction,
  testIntegrationAction,
  type IntegrationOutcome,
} from './actions';

const ICONS: Record<IntegrationGroup, IconName> = { twilio: 'phone', microsoft: 'mail', signwell: 'file-pen', alerts: 'bell', maverick: 'briefcase' };

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const inputClass =
  'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

const btn = 'inline-flex items-center gap-1.5 rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink-700 transition-colors hover:bg-canvas disabled:opacity-50';

type State = { label: string; cls: string; dot: string };

function stateOf(g: GroupView): State {
  if (!g.enabled) return { label: 'Switched off', cls: 'border-line bg-canvas text-ink-500', dot: 'bg-ink-300' };
  if (!g.ready) return { label: 'Not connected', cls: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]', dot: 'bg-[#e0a526]' };
  if (g.lastTest && !g.lastTest.ok) return { label: 'Last test failed', cls: 'border-[#f4c7c3] bg-[#fdecea] text-[#a12a20]', dot: 'bg-[#d0453a]' };
  return { label: 'Connected', cls: 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]', dot: 'bg-[#1a9b84]' };
}

function StatePill({ g }: { g: GroupView }) {
  const s = stateOf(g);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-[2.5px] text-[11.5px] font-semibold ${s.cls}`}>
      <span className={`size-1.5 rounded-full ${s.dot}`} aria-hidden />
      {s.label}
    </span>
  );
}

/* ── addresses to paste into each provider ─────────────────────────────── */

const ADDRESSES: Partial<Record<IntegrationGroup, { where: string; lines: { label: string; path: string }[] }>> = {
  twilio: {
    where: 'Paste these into the Twilio console, on each phone number and on the TwiML app.',
    lines: [
      { label: 'A call comes in', path: '/api/twilio/voice' },
      { label: 'A message comes in', path: '/api/twilio/message' },
      { label: 'TwiML app Voice URL', path: '/api/twilio/voice' },
    ],
  },
  microsoft: {
    where: 'Add this in Azure, under the app’s Authentication page, as a Web redirect URI.',
    lines: [{ label: 'Redirect URI', path: '/api/mail/oauth/callback' }],
  },
  signwell: {
    where: '“Connect this site” registers this address with SignWell for you.',
    lines: [{ label: 'Signing events', path: '/api/agreements/webhooks/signwell' }],
  },
};

function CopyLine({ label, url }: { label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5">
      <span className="w-full text-[12.5px] text-ink-500 sm:w-[170px] sm:shrink-0">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded-md bg-canvas px-2 py-1 text-[12px] text-ink-700">{url}</code>
      <button type="button" onClick={copy} className="inline-flex items-center gap-1 rounded-md border border-line bg-white px-2 py-1 text-[12px] font-medium text-ink-600 hover:bg-canvas">
        <Icon name={copied ? 'check' : 'copy'} size={12} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

/* ── one setting ───────────────────────────────────────────────────────── */

function SettingRow({ s, value, onChange, busy, onRemove }: { s: SettingView; value: string | undefined; onChange: (v: string | undefined) => void; busy: boolean; onRemove: () => void }) {
  const editing = value !== undefined;
  const id = `integration-${s.key}`;
  const set = Boolean(s.hint) || s.kind === 'switch';
  const current = s.unreadable
    ? 'Saved value can’t be read. Enter it again.'
    : s.kind === 'switch'
      ? // Unset means on: only an explicit "false" sends real agreements.
        s.hint === 'false'
        ? 'Off'
        : 'On'
      : (s.hint ?? 'Not set');
  return (
    <div className="grid gap-x-4 gap-y-1.5 py-3 sm:grid-cols-[190px_minmax(0,1fr)_auto] sm:items-start">
      <label htmlFor={id} className="flex items-start gap-2 pt-1 text-[13px] font-medium text-ink-800">
        <span
          aria-hidden
          className={`mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full ${s.unreadable ? 'bg-[#fdecea] text-[#a12a20]' : set ? 'bg-[#e6f6f2] text-[#0b6b5d]' : s.required ? 'bg-[#fdf1d8] text-[#8a5a09]' : 'bg-canvas text-ink-300'}`}
        >
          {set && !s.unreadable ? <Icon name="check" size={9} strokeWidth={3} /> : <span className="size-1 rounded-full bg-current" />}
        </span>
        <span>
          {s.label}
          {!s.required ? <span className="ml-1 font-normal text-ink-400">optional</span> : null}
        </span>
      </label>
      <div className="min-w-0">
        {editing ? (
          s.kind === 'switch' ? (
            <select id={id} value={value} onChange={(e) => onChange(e.target.value)} className={inputClass}>
              <option value="true">On (documents are not binding)</option>
              <option value="false">Off (real agreements)</option>
            </select>
          ) : (
            <input
              id={id}
              type={s.kind === 'secret' ? 'password' : s.kind === 'date' ? 'date' : 'text'}
              inputMode={s.kind === 'number' ? 'numeric' : undefined}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder={s.placeholder ?? undefined}
              autoComplete={s.kind === 'secret' ? 'new-password' : 'off'}
              spellCheck={false}
              className={inputClass}
            />
          )
        ) : (
          <p className={`break-all pt-1 text-[13px] ${s.unreadable ? 'text-[#a12a20]' : set ? 'font-mono text-[12.5px] text-ink-800' : 'text-ink-400'}`}>{current}</p>
        )}
        <p className="mt-1 text-[12px] leading-relaxed text-ink-400">
          {!editing && s.source === 'crm' && s.updatedAt ? `Saved here${s.updatedBy ? ` by ${s.updatedBy}` : ''}, ${when(s.updatedAt)}. ` : null}
          {!editing && s.source === 'server' ? 'From the hosting settings. Saving a value here replaces it. ' : null}
          {s.help}
        </p>
      </div>
      <div className="flex gap-1.5 sm:justify-end">
        {editing ? (
          <button type="button" disabled={busy} onClick={() => onChange(undefined)} className="rounded-md px-2 py-1 text-[12.5px] font-medium text-ink-500 hover:bg-canvas">
            Cancel
          </button>
        ) : (
          <>
            {s.source === 'crm' ? (
              <button type="button" disabled={busy} onClick={onRemove} aria-label={`Remove ${s.label}`} className="rounded-md px-2 py-1 text-[12.5px] font-medium text-ink-500 hover:bg-canvas hover:text-[#a12a20]">
                Remove
              </button>
            ) : null}
            <button
              type="button"
              disabled={busy}
              onClick={() => onChange(s.kind === 'switch' ? (s.hint ?? 'true') : '')}
              aria-label={`${s.kind === 'switch' ? 'Change' : s.hint ? 'Replace' : 'Add'} ${s.label}`}
              className="rounded-md border border-line bg-white px-2.5 py-1 text-[12.5px] font-medium text-ink-700 hover:bg-canvas"
            >
              {s.kind === 'switch' ? 'Change' : s.hint ? 'Replace' : 'Add'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/* ── on/off ────────────────────────────────────────────────────────────── */

function Toggle({ on, disabled, label, onChange }: { on: boolean; disabled: boolean; label: string; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300 disabled:opacity-50 ${on ? 'bg-[#1a9b84]' : 'bg-ink-300'}`}
    >
      <span className={`inline-block size-5 rounded-full bg-white shadow-sm transition-transform ${on ? 'translate-x-[22px]' : 'translate-x-[2px]'}`} />
    </button>
  );
}

/* ── Help ──────────────────────────────────────────────────────────────── */

function HelpSheet({ g, origin, onClose }: { g: GroupView; origin: string; onClose: () => void }) {
  const help = HELP[g.group];
  const addresses = ADDRESSES[g.group];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const labelOf = (key: string) => g.settings.find((s) => s.key === key)?.label ?? key.replace(/_/g, ' ').toLowerCase();
  // Opened by a click, so it only ever renders in the browser.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex justify-end">
      <div className="absolute inset-0 animate-fade-in bg-brand-950/30" onClick={onClose} />
      <aside role="dialog" aria-modal="true" aria-labelledby={`help-${g.group}`} className="relative flex h-full w-full max-w-[520px] animate-fade-in flex-col bg-white shadow-[-24px_0_64px_-12px_rgba(14,28,52,.35)]">
        <header className="flex items-start gap-3 border-b border-line-soft px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
            <Icon name={ICONS[g.group]} size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id={`help-${g.group}`} className="text-[16px] font-semibold text-ink-900">
              Connecting {g.title}
            </h2>
            <p className="mt-0.5 text-[12.5px] text-ink-500">{help.summary}</p>
          </div>
          <button type="button" aria-label="Close help" onClick={onClose} className="grid size-8 shrink-0 place-items-center rounded-lg text-ink-400 hover:bg-canvas hover:text-ink-900">
            <Icon name="x" size={15} />
          </button>
        </header>
        <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
          <p className="flex items-start gap-2 rounded-lg bg-canvas px-3 py-2 text-[12.5px] text-ink-600">
            <Icon name="user" size={13} className="mt-[2px] shrink-0 text-ink-400" />
            <span>
              <strong className="font-semibold text-ink-800">Who can get these: </strong>
              {help.who}
            </span>
          </p>

          <section>
            <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Steps</h3>
            <ol className="space-y-3">
              {help.steps.map((s, i) => (
                <li key={i} className="flex gap-3">
                  <span className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-900 text-[11.5px] font-bold text-white">{i + 1}</span>
                  <div className="min-w-0 flex-1 pt-0.5 text-[13px] leading-relaxed text-ink-700">
                    {s.text}
                    {s.link ? (
                      <a href={s.link.href} target="_blank" rel="noopener noreferrer" className="mt-1 flex w-fit items-center gap-1 text-[12.5px] font-semibold text-brand-700 hover:underline">
                        {s.link.label} <Icon name="external-link" size={12} />
                      </a>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          </section>

          {addresses ? (
            <section>
              <h3 className="mb-1 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Addresses for this site</h3>
              <p className="mb-1 text-[12.5px] text-ink-500">{addresses.where}</p>
              {addresses.lines.map((l) => (
                <CopyLine key={l.label} label={l.label} url={`${origin}${l.path}`} />
              ))}
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Where each value comes from</h3>
            <dl className="divide-y divide-line-faint overflow-hidden rounded-lg border border-line">
              {Object.entries(help.where).map(([key, where]) => (
                <div key={key} className="grid gap-0.5 px-3 py-2.5 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-3">
                  <dt className="text-[12.5px] font-semibold text-ink-800">{labelOf(key)}</dt>
                  <dd className="text-[12.5px] leading-relaxed text-ink-600">{where}</dd>
                </div>
              ))}
            </dl>
          </section>

          {help.notes?.length ? (
            <section className="space-y-2">
              {help.notes.map((n) => (
                <p key={n} className="flex gap-2 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[12.5px] leading-relaxed text-[#8a5a09]">
                  <Icon name="info" size={13} className="mt-[2px] shrink-0" />
                  <span>{n}</span>
                </p>
              ))}
            </section>
          ) : null}

          <section>
            <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Links</h3>
            <ul className="flex flex-wrap gap-2">
              {help.links.map((l) => (
                <li key={l.href}>
                  <a href={l.href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12.5px] font-medium text-ink-700 hover:border-brand-300 hover:bg-brand-50">
                    {l.label} <Icon name="external-link" size={12} className="text-ink-400" />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

/* ── one service ───────────────────────────────────────────────────────── */

function GroupCard({ g, origin, canEdit }: { g: GroupView; origin: string; canEdit: boolean }) {
  const [edits, setEdits] = useState<Record<string, string | undefined>>({});
  const [outcome, setOutcome] = useState<IntegrationOutcome | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SettingView | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [open, setOpen] = useState(canEdit && g.enabled && !g.ready);
  const [pending, start] = useTransition();
  const changed = Object.entries(edits).filter(([, v]) => v !== undefined) as [string, string][];
  const addresses = ADDRESSES[g.group];
  const required = g.settings.filter((s) => s.required);
  const requiredSet = required.filter((s) => s.hint && !s.unreadable).length;

  const act = (work: () => Promise<IntegrationOutcome>, after?: (r: IntegrationOutcome) => void) =>
    start(async () => {
      setOutcome(null);
      const r = await work();
      setOutcome(r);
      after?.(r);
    });

  const save = () =>
    act(
      () => saveIntegrationAction({ group: g.group, values: Object.fromEntries(changed) }),
      // What was typed leaves the browser's memory once it is saved. On a failure it stays so a typo can be fixed.
      (r) => {
        if (r.ok) setEdits({});
      },
    );

  const flip = (next: boolean) => {
    if (!next) return setConfirmOff(true);
    act(() => setIntegrationEnabledAction({ group: g.group, enabled: true }));
  };

  return (
    <section id={`service-${g.group}`} aria-labelledby={`group-${g.group}`} className={`scroll-mt-4 overflow-hidden rounded-panel border bg-white transition-colors ${g.enabled ? 'border-line' : 'border-dashed border-line'}`}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-3 px-5 py-4">
        <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${g.enabled ? 'bg-brand-900 text-white' : 'bg-canvas text-ink-400'}`}>
          <Icon name={ICONS[g.group]} size={18} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={`group-${g.group}`} className="text-[15px] font-semibold text-ink-900">
              {g.title}
            </h2>
            <StatePill g={g} />
          </div>
          <p className="text-[12.5px] text-ink-500">{g.powers}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setHelpOpen(true)} className={btn} aria-label={`Help connecting ${g.title}`}>
            <Icon name="info" size={13} /> Help
          </button>
          {canEdit && g.switchable ? (
            <label className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1">
              <span className="text-[12.5px] font-medium text-ink-600">{g.enabled ? 'On' : 'Off'}</span>
              <Toggle on={g.enabled} disabled={pending} label={`${g.title} ${g.enabled ? 'on' : 'off'}`} onChange={flip} />
            </label>
          ) : !g.switchable ? (
            <span title="Sign-in codes are sent through it, so it can’t be switched off." className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink-400">
              <Icon name="lock" size={12} /> Always on
            </span>
          ) : null}
        </div>
      </header>

      {confirmOff ? (
        <div role="alert" className="mx-5 mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] text-[#8a5a09]">
          <Icon name="alert-triangle" size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            Switch {g.title} off? Everything it powers stops ({g.powers.replace(/\.$/, '').toLowerCase()}). The keys stay saved, and switching it back on restores it.
          </span>
          <button type="button" disabled={pending} onClick={() => setConfirmOff(false)} className="rounded-md px-2 py-1 font-medium hover:bg-white/60">
            Keep it on
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setConfirmOff(false);
              act(() => setIntegrationEnabledAction({ group: g.group, enabled: false }));
            }}
            className="rounded-md bg-[#8a5a09] px-2.5 py-1 font-semibold text-white hover:opacity-90"
          >
            Switch off
          </button>
        </div>
      ) : null}

      {!g.enabled ? (
        <p className="flex items-start gap-2 border-t border-line-soft bg-canvas px-5 py-2.5 text-[12.5px] text-ink-500">
          <Icon name="ban" size={13} className="mt-[2px] shrink-0" />
          <span>
            Switched off{g.switchedBy ? ` by ${g.switchedBy.by ?? 'an admin'}, ${when(g.switchedBy.at)}` : ''}. The CRM treats it as not connected. Keys are kept.
          </span>
        </p>
      ) : null}

      {!canEdit && g.missing.length ? <p className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-500">Still needed: {g.missing.join(', ')}.</p> : null}

      {canEdit ? (
        <>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="flex w-full items-center gap-3 border-t border-line-soft px-5 py-2.5 text-left hover:bg-[#fbfcfe]"
          >
            <span className="text-[12.5px] font-semibold text-ink-700">Keys</span>
            {required.length ? (
              <span className="flex items-center gap-2 text-[12px] text-ink-400">
                <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-canvas">
                  <span className={`absolute inset-y-0 left-0 rounded-full ${requiredSet === required.length ? 'bg-[#1a9b84]' : 'bg-[#e0a526]'}`} style={{ width: `${(requiredSet / required.length) * 100}%` }} />
                </span>
                {requiredSet} of {required.length} required set
              </span>
            ) : null}
            <span className="flex-1" />
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} className="text-ink-400" />
          </button>

          {open ? (
            <div className="border-t border-line-soft px-5">
              <div className="divide-y divide-line-faint">
                {g.settings.map((s) => (
                  <SettingRow key={s.key} s={s} value={edits[s.key]} busy={pending} onChange={(v) => setEdits((e) => ({ ...e, [s.key]: v }))} onRemove={() => setConfirmRemove(s)} />
                ))}
              </div>

              {confirmRemove ? (
                <div role="alert" className="mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] text-[#8a5a09]">
                  <span className="min-w-0 flex-1">
                    Remove {confirmRemove.label}? The CRM goes back to the hosting settings for it, and if they have none, what depends on it stops working.
                  </span>
                  <button type="button" disabled={pending} onClick={() => setConfirmRemove(null)} className="rounded-md px-2 py-1 font-medium hover:bg-white/60">
                    Keep it
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      const key = confirmRemove.key;
                      setConfirmRemove(null);
                      act(() => removeIntegrationAction(key));
                    }}
                    className="rounded-md bg-[#a12a20] px-2.5 py-1 font-semibold text-white hover:opacity-90"
                  >
                    Remove
                  </button>
                </div>
              ) : null}

              <div className="flex flex-wrap items-center gap-2 border-t border-line-soft py-3">
                {changed.length ? (
                  <>
                    <button type="button" disabled={pending} onClick={save} className="inline-flex items-center gap-2 rounded-lg bg-brand-900 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-800 disabled:opacity-60">
                      {pending ? <Spinner /> : null}
                      Test and save
                    </button>
                    <span className="mr-auto text-[12.5px] text-ink-500">{g.title} checks the keys first. If it refuses them, nothing changes.</span>
                  </>
                ) : (
                  <span className="mr-auto text-[12px] text-ink-400">Press Add or Replace on a value to change it.</span>
                )}
                {g.group === 'alerts' ? (
                  <button type="button" disabled={pending || !g.ready} onClick={() => act(sendTestAlertAction)} className={btn}>
                    <Icon name="send" size={13} /> Send me a test alert
                  </button>
                ) : null}
                {g.group === 'signwell' ? (
                  <button type="button" disabled={pending || !g.enabled} onClick={() => act(connectSignwellAction)} className={btn}>
                    <Icon name="link" size={13} /> Connect this site
                  </button>
                ) : null}
                <button type="button" disabled={pending} onClick={() => act(() => testIntegrationAction(g.group))} className={btn}>
                  {pending ? <Spinner /> : <Icon name="refresh-cw" size={13} />} Test connection
                </button>
              </div>

              {addresses ? (
                <div className="-mx-5 border-t border-line-soft bg-[#fbfcfe] px-5 py-3">
                  <p className="mb-1 text-[12.5px] text-ink-500">{addresses.where}</p>
                  {addresses.lines.map((l) => (
                    <CopyLine key={l.label} label={l.label} url={`${origin}${l.path}`} />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {outcome ? (
        <p role="status" className={`mx-5 mb-4 mt-1 flex gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed ${outcome.ok ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-[#f4c7c3] bg-[#fdecea] text-[#a12a20]'}`}>
          <Icon name={outcome.ok ? 'check' : 'alert-triangle'} size={14} className="mt-0.5 shrink-0" />
          <span>
            {outcome.ok ? outcome.note : outcome.message}
            {outcome.ok && outcome.warning ? <strong className="mt-0.5 block font-medium text-[#8a5a09]">{outcome.warning}</strong> : null}
          </span>
        </p>
      ) : canEdit && g.lastTest ? (
        <p className="border-t border-line-soft px-5 py-2.5 text-[12px] text-ink-400">
          Last tested {when(g.lastTest.at)}
          {g.lastTest.by ? ` by ${g.lastTest.by}` : ''}: {g.lastTest.note}
        </p>
      ) : null}

      {helpOpen ? <HelpSheet g={g} origin={origin} onClose={() => setHelpOpen(false)} /> : null}
    </section>
  );
}

/* ── overview + history ────────────────────────────────────────────────── */

function Overview({ groups }: { groups: GroupView[] }) {
  return (
    <nav aria-label="Services" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
      {groups.map((g) => {
        const s = stateOf(g);
        return (
          <a
            key={g.group}
            href={`#service-${g.group}`}
            className="group flex items-center gap-2.5 rounded-panel border border-line bg-white px-3 py-2.5 transition-colors hover:border-brand-300 hover:bg-brand-50/40"
          >
            <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${g.enabled ? 'bg-brand-50 text-brand-700' : 'bg-canvas text-ink-400'}`}>
              <Icon name={ICONS[g.group]} size={15} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-ink-900">{g.title}</span>
              <span className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
                <span className={`size-1.5 rounded-full ${s.dot}`} aria-hidden />
                {s.label}
              </span>
            </span>
          </a>
        );
      })}
    </nav>
  );
}

const changeText = (c: ChangeView) =>
  c.action === 'turned_on' ? `Switched ${c.group} on` : c.action === 'turned_off' ? `Switched ${c.group} off` : `${c.action === 'set' ? 'Saved' : 'Removed'} ${c.group} ${c.label}`;

function History({ changes }: { changes: ChangeView[] }) {
  if (!changes.length) return null;
  return (
    <details className="rounded-panel border border-line bg-white">
      <summary className="cursor-pointer px-5 py-3 text-[13.5px] font-medium text-ink-800">Change history</summary>
      <ul className="divide-y divide-line-faint border-t border-line-soft">
        {changes.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-2.5 text-[12.5px]">
            <span className="text-ink-800">
              {changeText(c)}
              {c.hint && c.action === 'set' && c.hint.startsWith('ending') ? <span className="text-ink-400"> ({c.hint})</span> : null}
            </span>
            <span className="text-ink-400">
              {c.by}, {when(c.at)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function IntegrationsPanel({ screen }: { screen: IntegrationsScreen }) {
  const connected = screen.groups.filter((g) => g.ready).length;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <p className="text-[12.5px] text-ink-500">
          <strong className="font-semibold text-ink-800">
            {connected} of {screen.groups.length}
          </strong>{' '}
          services connected. Press Help on any of them for where each key comes from.
        </p>
      </div>
      <Overview groups={screen.groups} />
      {screen.canEdit ? (
        <p className="flex gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-brand-700">
          <Icon name="lock" size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span>Keys are encrypted when saved and can’t be viewed again, only replaced. Each one is tested with the provider first, and a change reaches the whole CRM within a minute.</span>
        </p>
      ) : (
        <p className="flex gap-2 rounded-lg border border-line bg-white px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-500">
          <Icon name="lock" size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span>Only a super admin can change these. You can see whether each one is connected.</span>
        </p>
      )}
      {screen.groups.map((g) => (
        <GroupCard key={g.group} g={g} origin={screen.origin} canEdit={screen.canEdit} />
      ))}
      <History changes={screen.changes} />
    </div>
  );
}
