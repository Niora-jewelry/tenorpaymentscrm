'use client';

/**
 * CRM Settings › Integrations: enter Twilio, Microsoft 365, SignWell and alert
 * email keys here instead of in the hosting environment.
 *
 * A saved secret never comes back to the browser. The screen shows that it is
 * set, who set it and its last four characters, and it can only be replaced.
 */
import { useState, useTransition } from 'react';
import { Icon, type IconName } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import type { IntegrationGroup } from '@/lib/integrations/catalog';
import type { ChangeView, GroupView, IntegrationsScreen, SettingView } from '@/lib/integrations/service';
import {
  connectSignwellAction,
  removeIntegrationAction,
  saveIntegrationAction,
  sendTestAlertAction,
  testIntegrationAction,
  type IntegrationOutcome,
} from './actions';

const ICONS: Record<IntegrationGroup, IconName> = { twilio: 'phone', microsoft: 'mail', signwell: 'file-text', alerts: 'bell' };

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

const inputClass =
  'w-full rounded-lg border border-line bg-white px-3 py-2 text-[13.5px] text-ink-900 outline-none placeholder:text-ink-300 focus:border-brand-500 focus:ring-2 focus:ring-brand-100';

function StatePill({ g }: { g: GroupView }) {
  const failed = g.lastTest && !g.lastTest.ok;
  const [label, cls] = !g.ready
    ? ['Not connected', 'border-[#f7e0af] bg-[#fdf1d8] text-[#8a5a09]']
    : failed
      ? ['Last test failed', 'border-[#f4c7c3] bg-[#fdecea] text-[#a12a20]']
      : ['Connected', 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]'];
  return <span className={`inline-flex items-center rounded-full border px-2 py-[2.5px] text-[11.5px] font-semibold ${cls}`}>{label}</span>;
}

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
      <span className="w-full text-[12.5px] text-ink-500 sm:w-[190px] sm:shrink-0">{label}</span>
      <code className="min-w-0 flex-1 break-all rounded-md bg-canvas px-2 py-1 text-[12px] text-ink-700">{url}</code>
      <button type="button" onClick={copy} className="rounded-md border border-line bg-white px-2 py-1 text-[12px] font-medium text-ink-600 hover:bg-canvas">
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

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

function SettingRow({ s, value, onChange, busy, onRemove }: { s: SettingView; value: string | undefined; onChange: (v: string | undefined) => void; busy: boolean; onRemove: () => void }) {
  const editing = value !== undefined;
  const id = `integration-${s.key}`;
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
      <label htmlFor={id} className="pt-1 text-[13px] font-medium text-ink-800">
        {s.label}
        {!s.required ? <span className="ml-1 font-normal text-ink-400">optional</span> : null}
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
          <p className={`break-all pt-1 text-[13px] ${s.unreadable ? 'text-[#a12a20]' : s.hint || s.kind === 'switch' ? 'text-ink-800' : 'text-ink-400'}`}>{current}</p>
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

function GroupCard({ g, origin, canEdit }: { g: GroupView; origin: string; canEdit: boolean }) {
  const [edits, setEdits] = useState<Record<string, string | undefined>>({});
  const [outcome, setOutcome] = useState<IntegrationOutcome | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<SettingView | null>(null);
  const [pending, start] = useTransition();
  const changed = Object.entries(edits).filter(([, v]) => v !== undefined) as [string, string][];
  const addresses = ADDRESSES[g.group];

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

  return (
    <section aria-labelledby={`group-${g.group}`} className="rounded-panel border border-line bg-white">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 px-5 py-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-700">
          <Icon name={ICONS[g.group]} size={17} />
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
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            {g.group === 'alerts' ? (
              <button type="button" disabled={pending || !g.ready} onClick={() => act(sendTestAlertAction)} className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink-700 hover:bg-canvas disabled:opacity-50">
                Send me a test alert
              </button>
            ) : null}
            {g.group === 'signwell' ? (
              <button type="button" disabled={pending} onClick={() => act(connectSignwellAction)} className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink-700 hover:bg-canvas disabled:opacity-50">
                Connect this site
              </button>
            ) : null}
            <button type="button" disabled={pending} onClick={() => act(() => testIntegrationAction(g.group))} className="rounded-lg border border-line bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink-700 hover:bg-canvas disabled:opacity-50">
              Test connection
            </button>
          </div>
        ) : null}
      </header>

      {!canEdit && g.missing.length ? <p className="border-t border-line-soft px-5 py-3 text-[12.5px] text-ink-500">Still needed: {g.missing.join(', ')}.</p> : null}

      {canEdit ? (
        <div className="border-t border-line-soft px-5">
          <div className="divide-y divide-line-faint">
            {g.settings.map((s) => (
              <SettingRow
                key={s.key}
                s={s}
                value={edits[s.key]}
                busy={pending}
                onChange={(v) => setEdits((e) => ({ ...e, [s.key]: v }))}
                onRemove={() => setConfirmRemove(s)}
              />
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

          {changed.length ? (
            <div className="flex flex-wrap items-center gap-3 border-t border-line-soft py-3">
              <button type="button" disabled={pending} onClick={save} className="inline-flex items-center gap-2 rounded-lg bg-brand-900 px-3.5 py-2 text-[13px] font-semibold text-white hover:bg-brand-800 disabled:opacity-60">
                {pending ? <Spinner /> : null}
                Test and save
              </button>
              <span className="text-[12.5px] text-ink-500">{g.title} checks the keys first. If it refuses them, nothing changes.</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {outcome ? (
        <p role="status" className={`mx-5 mb-4 flex gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed ${outcome.ok ? 'border-[#bfe6dd] bg-[#e6f6f2] text-[#0b6b5d]' : 'border-[#f4c7c3] bg-[#fdecea] text-[#a12a20]'}`}>
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

      {canEdit && addresses ? (
        <div className="border-t border-line-soft bg-[#fbfcfe] px-5 py-3">
          <p className="mb-1 text-[12.5px] text-ink-500">{addresses.where}</p>
          {addresses.lines.map((l) => (
            <CopyLine key={l.label} label={l.label} url={`${origin}${l.path}`} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function History({ changes }: { changes: ChangeView[] }) {
  if (!changes.length) return null;
  return (
    <details className="rounded-panel border border-line bg-white">
      <summary className="cursor-pointer px-5 py-3 text-[13.5px] font-medium text-ink-800">Change history</summary>
      <ul className="divide-y divide-line-faint border-t border-line-soft">
        {changes.map((c) => (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 px-5 py-2.5 text-[12.5px]">
            <span className="text-ink-800">
              {c.action === 'set' ? 'Saved' : 'Removed'} {c.group} {c.label}
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
  return (
    <div className="space-y-4">
      {screen.canEdit ? (
        <p className="flex gap-2 rounded-lg border border-brand-100 bg-brand-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-brand-700">
          <Icon name="lock" size={14} className="mt-0.5 shrink-0 opacity-70" />
          <span>
            Keys are encrypted when saved and can’t be viewed again, only replaced. Each one is tested with the provider first, and a change reaches the whole CRM within a minute.
          </span>
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
