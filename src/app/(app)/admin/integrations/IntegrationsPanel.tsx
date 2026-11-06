'use client';

/**
 * CRM Settings › Integrations: enter Twilio, Microsoft 365, SignWell, alert
 * email and Maverick Payments keys here instead of in the hosting environment.
 *
 * Laid out as tabs, one per service (client, 6 Nov 2026): Main connector,
 * Individual connectors and Activity, with the on/off switch on that row.
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
import { useEffect, useOptimistic, useState, useTransition, type ReactNode, type TransitionStartFunction } from 'react';
import { createPortal } from 'react-dom';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import type { IntegrationGroup } from '@/lib/integrations/catalog';
import { HELP } from '@/lib/integrations/help';
import type { ChangeView, GroupView, MicrosoftPerson, SettingView } from '@/lib/integrations/service';
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

/* ── the tabs ──────────────────────────────────────────────────────────── */

type ChannelState = 'live' | 'needs-config';
export type Channel = { name: string; what: string; where: string; state: ChannelState; note?: string };

export type IntegrationTab = {
  group: IntegrationGroup;
  title: string;
  /** Keys and status; null when this person may only see an Individual connectors part. */
  view: GroupView | null;
  channels: Channel[];
  /** Under Main connector, after the keys (Maverick: health and daily runs). */
  mainExtra: ReactNode;
  /** Individual connectors (Twilio: phone numbers; Maverick: merchants to match). */
  individual: ReactNode;
  /** Microsoft 365 › Individual connectors. */
  microsoftPeople: MicrosoftPerson[] | null;
};

type Sub = 'main' | 'individual' | 'activity';
const SUBS: { key: Sub; label: string; icon: IconName }[] = [
  { key: 'main', label: 'Main connector', icon: 'link' },
  { key: 'individual', label: 'Individual connectors', icon: 'users' },
  { key: 'activity', label: 'Activity', icon: 'clock' },
];

const subsFor = (t: IntegrationTab): Sub[] => [...(t.view || t.mainExtra ? (['main'] as Sub[]) : []), 'individual', ...(t.view ? (['activity'] as Sub[]) : [])];

export function IntegrationsPanel({
  tabs,
  canEdit,
  origin,
  changes,
  firstOn,
  initialTab,
  initialSub,
}: {
  tabs: IntegrationTab[];
  canEdit: boolean;
  origin: string;
  changes: ChangeView[];
  firstOn: Partial<Record<IntegrationGroup, string>>;
  initialTab?: string;
  initialSub?: string;
}) {
  const first = tabs.find((t) => t.group === initialTab) ?? tabs[0];
  const [active, setActive] = useState<IntegrationGroup | undefined>(first?.group);
  const [sub, setSub] = useState<Sub>(() => {
    const allowed = first ? subsFor(first) : [];
    return allowed.includes(initialSub as Sub) ? (initialSub as Sub) : (allowed[0] ?? 'main');
  });
  const tab = tabs.find((t) => t.group === active) ?? tabs[0];

  // The address follows the tab, so a refresh or a shared link opens the same place.
  const go = (group: IntegrationGroup, next?: Sub) => {
    const t = tabs.find((x) => x.group === group);
    if (!t) return;
    const allowed = subsFor(t);
    const s = next && allowed.includes(next) ? next : allowed.includes(sub) ? sub : allowed[0];
    setActive(group);
    setSub(s);
    window.history.replaceState(null, '', `?tab=${group}&sub=${s}`);
  };

  if (!tab) return <p className="text-[13px] text-ink-500">No integration is available to you.</p>;
  const subs = subsFor(tab);

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label="Integrations" className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {tabs.map((t) => {
          const on = t.group === tab.group;
          const s = t.view ? stateOf(t.view) : null;
          return (
            <button
              key={t.group}
              type="button"
              role="tab"
              id={`tab-${t.group}`}
              aria-selected={on}
              aria-controls={`panel-${t.group}`}
              onClick={() => go(t.group)}
              className={`flex items-center gap-2.5 rounded-panel border px-3 py-2.5 text-left transition-colors ${
                on ? 'border-brand-700 bg-white ring-1 ring-brand-700' : 'border-line bg-white hover:border-brand-300 hover:bg-brand-50/40'
              }`}
            >
              <span className={`grid size-8 shrink-0 place-items-center rounded-lg ${on ? 'bg-brand-900 text-white' : t.view && !t.view.enabled ? 'bg-canvas text-ink-400' : 'bg-brand-50 text-brand-700'}`}>
                <Icon name={ICONS[t.group]} size={15} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-semibold text-ink-900">{t.title}</span>
                {s ? (
                  <span className="flex items-center gap-1.5 text-[11.5px] text-ink-500">
                    <span className={`size-1.5 rounded-full ${s.dot}`} aria-hidden />
                    {s.label}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      <IntegrationView
        key={tab.group}
        t={tab}
        sub={subs.includes(sub) ? sub : subs[0]}
        onSub={(s) => go(tab.group, s)}
        canEdit={canEdit}
        origin={origin}
        changes={changes.filter((c) => c.grp === tab.group)}
        firstOn={firstOn[tab.group] ?? null}
      />
    </div>
  );
}

function IntegrationView({
  t,
  sub,
  onSub,
  canEdit,
  origin,
  changes,
  firstOn,
}: {
  t: IntegrationTab;
  sub: Sub;
  onSub: (s: Sub) => void;
  canEdit: boolean;
  origin: string;
  changes: ChangeView[];
  firstOn: string | null;
}) {
  const fromServer = t.view;
  // The switch shows at once. If the server refuses, it falls back by itself.
  const [enabled, setEnabledNow] = useOptimistic(fromServer?.enabled ?? true);
  const [outcome, setOutcome] = useState<IntegrationOutcome | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pending, start] = useTransition();
  const g: GroupView | null = fromServer ? { ...fromServer, enabled, ready: enabled && fromServer.ready } : null;
  const subs = subsFor(t);

  const setSwitch = (next: boolean) =>
    start(async () => {
      setEnabledNow(next);
      setOutcome(await setIntegrationEnabledAction({ group: t.group, enabled: next }));
    });

  return (
    <section
      id={`panel-${t.group}`}
      role="tabpanel"
      aria-labelledby={`tab-${t.group}`}
      className={`overflow-hidden rounded-panel border bg-white ${g && !g.enabled ? 'border-dashed border-line' : 'border-line'}`}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 pt-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[16px] font-semibold text-ink-900">{t.title}</h2>
            {g ? <StatePill g={g} /> : null}
          </div>
          {g ? <p className="text-[12.5px] text-ink-500">{g.powers}</p> : null}
        </div>
        {g ? (
          <button type="button" onClick={() => setHelpOpen(true)} className={btn} aria-label={`Help connecting ${t.title}`}>
            <Icon name="info" size={13} /> Help
          </button>
        ) : null}
      </header>

      {/* Subtabs on the left, the on/off switch on the same row to the right. */}
      <div className="mt-3 flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-line-soft px-5">
        <div role="tablist" aria-label={`${t.title} sections`} className="-mb-px flex flex-wrap gap-1">
          {SUBS.filter((s) => subs.includes(s.key)).map((s) => {
            const on = s.key === sub;
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => onSub(s.key)}
                className={`inline-flex items-center gap-1.5 border-b-2 px-3 py-2.5 text-[13px] font-semibold transition-colors ${
                  on ? 'border-brand-700 text-ink-900' : 'border-transparent text-ink-500 hover:text-ink-800'
                }`}
              >
                <Icon name={s.icon} size={13} />
                {s.label}
              </button>
            );
          })}
        </div>
        <span className="flex-1" />
        <div className="pb-2">
          {g && g.switchable && canEdit ? (
            <label className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1">
              <span className="text-[12.5px] font-semibold text-ink-700">{g.enabled ? 'On' : 'Off'}</span>
              <Toggle on={g.enabled} disabled={pending} label={`${t.title} ${g.enabled ? 'on' : 'off'}`} onChange={(next) => (next ? setSwitch(true) : setConfirmOff(true))} />
            </label>
          ) : g && !g.switchable ? (
            <span title="Sign-in codes are sent through it, so it can’t be switched off." className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1.5 text-[12px] text-ink-400">
              <Icon name="lock" size={12} /> Always on
            </span>
          ) : g ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-[12px] font-semibold text-ink-500">{g.enabled ? 'On' : 'Off'}</span>
          ) : null}
        </div>
      </div>

      {confirmOff && g ? (
        <div role="alert" className="mx-5 mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] text-[#8a5a09]">
          <Icon name="alert-triangle" size={14} className="shrink-0" />
          <span className="min-w-0 flex-1">
            Switch {t.title} off? Everything it powers stops ({g.powers.replace(/\.$/, '').toLowerCase()}). The keys stay saved, and switching it back on restores it.
          </span>
          <button type="button" disabled={pending} onClick={() => setConfirmOff(false)} className="rounded-md px-2 py-1 font-medium hover:bg-white/60">
            Keep it on
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => {
              setConfirmOff(false);
              setSwitch(false);
            }}
            className="rounded-md bg-[#8a5a09] px-2.5 py-1 font-semibold text-white hover:opacity-90"
          >
            Switch off
          </button>
        </div>
      ) : null}

      {g && !g.enabled ? (
        <p className="mx-5 mt-4 flex items-start gap-2 rounded-lg bg-canvas px-3 py-2.5 text-[12.5px] text-ink-500">
          <Icon name="ban" size={13} className="mt-[2px] shrink-0" />
          <span>
            Switched off{g.switchedBy ? ` by ${g.switchedBy.by ?? 'an admin'}, ${when(g.switchedBy.at)}` : ''}. The CRM treats it as not connected. Keys are kept.
          </span>
        </p>
      ) : null}

      {outcome ? <OutcomeNote outcome={outcome} /> : null}

      <div className="px-5 py-4">
        {sub === 'main' ? (
          <MainConnector t={t} g={g} canEdit={canEdit} origin={origin} pending={pending} start={start} setOutcome={setOutcome} />
        ) : sub === 'individual' ? (
          <Individual t={t} />
        ) : g ? (
          <Activity g={g} canEdit={canEdit} changes={changes} firstOn={firstOn} />
        ) : null}
      </div>

      {helpOpen && g ? <HelpSheet g={g} origin={origin} onClose={() => setHelpOpen(false)} /> : null}
    </section>
  );
}

function OutcomeNote({ outcome }: { outcome: IntegrationOutcome }) {
  return (
    <p
      role="status"
      className={`mx-5 mt-4 flex gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed ${outcome.ok ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-[#f4c7c3] bg-[#fdecea] text-[#a12a20]'}`}
    >
      <Icon name={outcome.ok ? 'check' : 'alert-triangle'} size={14} className="mt-0.5 shrink-0" />
      <span>
        {outcome.ok ? outcome.note : outcome.message}
        {outcome.ok && outcome.warning ? <strong className="mt-0.5 block font-medium text-[#8a5a09]">{outcome.warning}</strong> : null}
      </span>
    </p>
  );
}

/* ── Main connector ────────────────────────────────────────────────────── */

function MainConnector({
  t,
  g,
  canEdit,
  origin,
  pending,
  start,
  setOutcome,
}: {
  t: IntegrationTab;
  g: GroupView | null;
  canEdit: boolean;
  origin: string;
  pending: boolean;
  start: TransitionStartFunction;
  setOutcome: (o: IntegrationOutcome | null) => void;
}) {
  const [edits, setEdits] = useState<Record<string, string | undefined>>({});
  const [confirmRemove, setConfirmRemove] = useState<SettingView | null>(null);
  const [gone, markGone] = useOptimistic<readonly string[], string>([], (list, key) => [...list, key]);
  const [saving, setSaving] = useState(false);
  const changed = Object.entries(edits).filter(([, v]) => v !== undefined) as [string, string][];
  const addresses = g ? ADDRESSES[g.group] : undefined;
  const settings = (g?.settings ?? []).map((s) => (gone.includes(s.key) ? { ...s, source: null, hint: null, unreadable: false, updatedBy: null, updatedAt: null } : s));
  const required = settings.filter((s) => s.required);
  const requiredSet = required.filter((s) => s.hint && !s.unreadable).length;

  const act = (work: () => Promise<IntegrationOutcome>, after?: (r: IntegrationOutcome) => void) =>
    start(async () => {
      setOutcome(null);
      const r = await work();
      setOutcome(r);
      after?.(r);
    });

  const save = () => {
    if (!g) return;
    setSaving(true);
    act(
      () => saveIntegrationAction({ group: g.group, values: Object.fromEntries(changed) }),
      // What was typed leaves the browser's memory once it is saved. On a failure it stays so a typo can be fixed.
      (r) => {
        setSaving(false);
        if (r.ok) setEdits({});
      },
    );
  };

  return (
    <div className="space-y-5">
      {g && canEdit ? (
        <div className="rounded-lg border border-line">
          <div className="flex flex-wrap items-center gap-3 border-b border-line-soft bg-[#fbfcfe] px-4 py-2.5">
            <span className="text-[13px] font-semibold text-ink-800">Keys</span>
            {required.length ? (
              <span className="flex items-center gap-2 text-[12px] text-ink-400">
                <span className="relative h-1.5 w-16 overflow-hidden rounded-full bg-canvas">
                  <span
                    className={`absolute inset-y-0 left-0 rounded-full ${requiredSet === required.length ? 'bg-[#1a9b84]' : 'bg-[#e0a526]'}`}
                    style={{ width: `${(requiredSet / required.length) * 100}%` }}
                  />
                </span>
                {requiredSet} of {required.length} required set
              </span>
            ) : null}
            <span className="flex-1" />
            <span className="inline-flex items-center gap-1 text-[11.5px] text-ink-400">
              <Icon name="lock" size={11} /> Encrypted. Can be replaced, never viewed.
            </span>
          </div>
          <div className="divide-y divide-line-faint px-4">
            {settings.map((s) => (
              <SettingRow key={s.key} s={s} value={edits[s.key]} busy={pending} onChange={(v) => setEdits((e) => ({ ...e, [s.key]: v }))} onRemove={() => setConfirmRemove(s)} />
            ))}
          </div>

          {confirmRemove ? (
            <div role="alert" className="mx-4 mb-3 flex flex-wrap items-center gap-3 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2.5 text-[12.5px] text-[#8a5a09]">
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
                  start(async () => {
                    markGone(key);
                    setOutcome(await removeIntegrationAction(key));
                  });
                }}
                className="rounded-md bg-[#a12a20] px-2.5 py-1 font-semibold text-white hover:opacity-90"
              >
                Remove
              </button>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-4 py-3">
            {changed.length ? (
              <>
                <button
                  type="button"
                  disabled={pending}
                  onClick={save}
                  className="inline-flex items-center gap-2 rounded-lg bg-brand-900 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-800 disabled:opacity-60"
                >
                  {pending ? <Spinner /> : null}
                  {saving ? `Testing with ${g.title}…` : 'Test and save'}
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
            <div className="border-t border-line-soft bg-[#fbfcfe] px-4 py-3">
              <p className="mb-1 text-[12.5px] text-ink-500">{addresses.where}</p>
              {addresses.lines.map((l) => (
                <CopyLine key={l.label} label={l.label} url={`${origin}${l.path}`} />
              ))}
            </div>
          ) : null}

          {g.lastTest ? (
            <p className="border-t border-line-soft px-4 py-2.5 text-[12px] text-ink-400">
              Last tested {when(g.lastTest.at)}
              {g.lastTest.by ? ` by ${g.lastTest.by}` : ''}: {g.lastTest.note}
            </p>
          ) : null}
        </div>
      ) : g ? (
        <p className="flex gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-500">
          <Icon name="lock" size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span>
            Only a super admin can change these keys.{g.missing.length ? ` Still needed: ${g.missing.join(', ')}.` : ''}
          </span>
        </p>
      ) : null}

      {t.mainExtra}

      {t.channels.length ? (
        <section>
          <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">What it powers</h3>
          <ul className="grid gap-2 md:grid-cols-2">
            {t.channels.map((c) => (
              <li key={c.name} className="rounded-lg border border-line px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-semibold text-ink-900">{c.name}</span>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-px text-[11px] font-semibold ${
                      c.state === 'live' ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]'
                    }`}
                  >
                    {c.state === 'live' ? 'Working' : 'Not set up'}
                  </span>
                </div>
                <p className="mt-1 text-[12.5px] text-ink-500">{c.what}</p>
                {c.note ? <p className="mt-1 text-[12px] text-ink-400">{c.note}</p> : null}
                <p className="mt-1.5 inline-flex items-center gap-1.5 text-[11.5px] text-ink-400">
                  <Icon name="arrow-right" size={11} />
                  {c.where}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/* ── Individual connectors ─────────────────────────────────────────────── */

const NONE: Record<IntegrationGroup, string> = {
  twilio: 'You can’t assign phone numbers. An admin with Phone numbers access can.',
  microsoft: 'Nobody has connected a Microsoft account yet. Each person connects their own in Settings › Email.',
  signwell: 'SignWell has none. Every agreement is sent from the company account under Main connector.',
  alerts: 'Alert email has none. It sends from one company mailbox, set under Main connector.',
  maverick: 'You can’t match Maverick merchants to records.',
};

const MS_STATUS: Record<string, { label: string; cls: string }> = {
  ok: { label: 'Connected', cls: 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' },
  degraded: { label: 'Having trouble', cls: 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]' },
  broken: { label: 'Needs reconnecting', cls: 'border-[#f4c7c3] bg-[#fdecea] text-[#a12a20]' },
  paused_user: { label: 'Paused', cls: 'border-line bg-canvas text-ink-500' },
};

function Individual({ t }: { t: IntegrationTab }) {
  if (t.individual) return <>{t.individual}</>;
  const people = t.microsoftPeople;
  if (people && people.length) {
    return (
      <div className="space-y-2">
        <p className="text-[12.5px] text-ink-500">Each person connects their own Microsoft account in Settings › Email. Their Email, Calendar and Chat use it.</p>
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[560px] text-left text-[13px]">
            <thead className="border-b border-line-soft bg-canvas text-[11.5px] font-semibold uppercase tracking-[.05em] text-ink-400">
              <tr>
                <th className="px-4 py-2.5">Person</th>
                <th className="px-4 py-2.5">Mailbox</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Connected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {people.map((p) => {
                const st = MS_STATUS[p.status] ?? { label: p.status, cls: 'border-line bg-canvas text-ink-500' };
                return (
                  <tr key={p.id}>
                    <td className="px-4 py-2.5 font-semibold text-ink-900">{p.person}</td>
                    <td className="px-4 py-2.5 text-ink-700">
                      {p.mailbox}
                      {p.shared ? <span className="ml-1.5 rounded bg-canvas px-1.5 py-px text-[11px] text-ink-500">Shared</span> : null}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className={`rounded-full border px-2 py-px text-[11px] font-semibold ${st.cls}`}>{st.label}</span>
                    </td>
                    <td className="px-4 py-2.5 text-ink-500">{when(p.connectedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  return <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[13px] text-ink-500">{NONE[t.group]}</p>;
}

/* ── Activity ──────────────────────────────────────────────────────────── */

const changeText = (c: ChangeView) =>
  c.action === 'turned_on' ? 'Switched on' : c.action === 'turned_off' ? 'Switched off' : `${c.action === 'set' ? 'Saved' : 'Removed'} ${c.label}`;

function Activity({ g, canEdit, changes, firstOn }: { g: GroupView; canEdit: boolean; changes: ChangeView[]; firstOn: string | null }) {
  const tiles: { label: string; value: string; sub?: string }[] = [
    { label: 'Activated', value: firstOn ? when(firstOn) : canEdit ? 'Not yet' : '—', sub: firstOn ? 'First connected here' : undefined },
    {
      label: 'Now',
      value: !g.enabled ? 'Switched off' : g.ready ? 'On and connected' : 'On, not connected',
      sub: g.switchedBy ? `Last switched by ${g.switchedBy.by ?? 'an admin'}, ${when(g.switchedBy.at)}` : undefined,
    },
    {
      label: 'Last test',
      value: g.lastTest ? (g.lastTest.ok ? 'Passed' : 'Failed') : canEdit ? 'Never tested' : '—',
      sub: g.lastTest ? `${when(g.lastTest.at)}${g.lastTest.by ? ` by ${g.lastTest.by}` : ''}` : undefined,
    },
  ];
  return (
    <div className="space-y-4">
      <dl className="grid gap-2 sm:grid-cols-3">
        {tiles.map((x) => (
          <div key={x.label} className="rounded-lg border border-line px-3.5 py-3">
            <dt className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">{x.label}</dt>
            <dd className="mt-1 text-[14px] font-semibold text-ink-900">{x.value}</dd>
            {x.sub ? <dd className="mt-0.5 text-[12px] text-ink-400">{x.sub}</dd> : null}
          </div>
        ))}
      </dl>
      <section>
        <h3 className="mb-2 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Change history</h3>
        {!canEdit ? (
          <p className="text-[12.5px] text-ink-500">Only a super admin can see the change history.</p>
        ) : changes.length ? (
          <ul className="divide-y divide-line-faint rounded-lg border border-line">
            {changes.map((c) => (
              <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-4 py-2.5 text-[12.5px]">
                <span className="flex items-center gap-2 text-ink-800">
                  {changeText(c)}
                  {c.hint && c.action === 'set' && c.hint.startsWith('ending') ? <span className="text-ink-400">({c.hint})</span> : null}
                </span>
                <span className="text-ink-400">
                  {c.by}, {when(c.at)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12.5px] text-ink-500">No changes yet.</p>
        )}
      </section>
    </div>
  );
}
