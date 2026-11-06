'use client';

/**
 * The Lock, Hide, Unlock and Unhide steps (Lock & Hide spec): the item tree and
 * the groups. A tab or sub-tab picked covers what's inside it, so its children
 * show as covered rather than as choices.
 */
import { useState } from 'react';
import { Icon } from '@/proto/ui/icons';
import type { Catalog, RestrictableTab } from '@/lib/automations/catalog';
import type { FlowStep, RestrictionGroup } from '@/lib/automations/steps';

/** As `StepFields`' own. */
const labelClass = 'block text-[11px] font-semibold uppercase tracking-[.05em] text-ink-500';

type Restriction = Extract<FlowStep, { type: 'lock' | 'hide' | 'unlock' | 'unhide' }>;

export function RestrictionFields({ step, catalog, onChange }: { step: Restriction; catalog: Catalog; onChange: (s: FlowStep) => void }) {
  const setItems = (items: string[]) => onChange({ ...step, items });
  const coversFiles = step.items.some((i) => i === 'tab:files' || i.startsWith('row:') || i === 'tab:statements');
  return (
    <div className="space-y-4">
      <ItemPicker catalog={catalog} items={step.items} onChange={setItems} />
      {step.type === 'lock' ? (
        <GroupPicker label="Can unlock" hint="They can still edit it, and unlock it for everyone." catalog={catalog} value={step.canLift} onChange={(canLift) => onChange({ ...step, canLift })} />
      ) : null}
      {step.type === 'hide' ? (
        <>
          <GroupPicker label="Can see and unhide" catalog={catalog} value={step.canLift} onChange={(canLift) => onChange({ ...step, canLift })} />
          <GroupPicker label="Can see only" catalog={catalog} value={step.canSee} onChange={(canSee) => onChange({ ...step, canSee })} />
          <p className="text-[12px] text-ink-400">Everyone else can’t see it. Super admins always can.</p>
        </>
      ) : null}
      {(step.type === 'lock' || step.type === 'hide') && coversFiles ? (
        <label className="flex max-w-[460px] items-start gap-2 text-[13px] text-ink-700">
          <input type="checkbox" className="mt-0.5" checked={step.allowDownload} onChange={(e) => onChange({ ...step, allowDownload: e.target.checked })} />
          <span>
            Allow download
            <span className="block text-[12px] text-ink-400">
              For people who can see the files but can’t {step.type === 'lock' ? 'unlock' : 'unhide'}. Locked Statements never allow download.
            </span>
          </span>
        </label>
      ) : null}
      {step.type === 'unlock' || step.type === 'unhide' ? (
        <p className="text-[12px] text-ink-400">
          If nothing chosen is {step.type === 'unlock' ? 'locked' : 'hidden'} on the record, this step is skipped and the automation stops there.
        </p>
      ) : null}
    </div>
  );
}

function ItemPicker({ catalog, items, onChange }: { catalog: Catalog; items: string[]; onChange: (items: string[]) => void }) {
  const has = (i: string) => items.includes(i);
  const toggle = (i: string, on: boolean, drop: string[] = []) =>
    onChange(on ? [...items.filter((x) => !drop.includes(x)), i] : items.filter((x) => x !== i));

  return (
    <div>
      <span className={labelClass}>Covers</span>
      <div className="max-h-[420px] max-w-[560px] overflow-y-auto rounded-lg border border-line">
        {catalog.vitalFields.length ? (
          <Branch label="Vital Info" count={catalog.vitalFields.filter((f) => has(`field:${f.value}`)).length}>
            {catalog.vitalFields.map((f) => (
              <Leaf key={f.value} label={f.label} checked={has(`field:${f.value}`)} onChange={(on) => toggle(`field:${f.value}`, on)} />
            ))}
          </Branch>
        ) : null}
        {catalog.restrictable.map((t) => (
          <TabBranch key={t.key} tab={t} catalog={catalog} has={has} toggle={toggle} />
        ))}
      </div>
      <p className="mt-1.5 text-[12px] text-ink-400">
        {items.length ? `${items.length} chosen.` : 'Nothing chosen yet.'} Marketing, Communication, Updates and Cases can’t be locked or hidden.
      </p>
    </div>
  );
}

function TabBranch({ tab, catalog, has, toggle }: {
  tab: RestrictableTab; catalog: Catalog; has: (i: string) => boolean; toggle: (i: string, on: boolean, drop?: string[]) => void;
}) {
  const whole = has(`tab:${tab.key}`);
  // Everything inside, so picking the tab can tidy away what it now covers.
  const inside = [
    ...tab.fields.map((f) => `field:${f.value}`),
    ...tab.subtabs.flatMap((s) => [`subtab:${s.id}`, ...s.fields.map((f) => `field:${f.value}`)]),
    ...(tab.level === 'row' ? catalog.fileRows.map((r) => `row:${r}`) : []),
  ];
  const picked = inside.filter(has).length + (whole ? 1 : 0);
  return (
    <Branch label={tab.label} count={picked}>
      <Leaf label={tab.level === 'tab' ? 'Whole tab (only option)' : 'Whole tab'} strong checked={whole} onChange={(on) => toggle(`tab:${tab.key}`, on, inside)} />
      {tab.level === 'row'
        ? catalog.fileRows.map((r) => <Leaf key={r} label={r} covered={whole} checked={whole || has(`row:${r}`)} onChange={(on) => toggle(`row:${r}`, on)} />)
        : null}
      {tab.fields.map((f) => (
        <Leaf key={f.value} label={f.label} covered={whole} checked={whole || has(`field:${f.value}`)} onChange={(on) => toggle(`field:${f.value}`, on)} />
      ))}
      {tab.subtabs.map((s) => {
        const sub = has(`subtab:${s.id}`);
        return (
          <div key={s.id} className="pl-3">
            <Leaf label={`${s.label} (whole sub-tab)`} strong covered={whole} checked={whole || sub} onChange={(on) => toggle(`subtab:${s.id}`, on, s.fields.map((f) => `field:${f.value}`))} />
            <div className="pl-3">
              {s.fields.map((f) => (
                <Leaf key={f.value} label={f.label} covered={whole || sub} checked={whole || sub || has(`field:${f.value}`)} onChange={(on) => toggle(`field:${f.value}`, on)} />
              ))}
            </div>
          </div>
        );
      })}
    </Branch>
  );
}

function Branch({ label, count, children }: { label: string; count: number; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-line-soft last:border-b-0">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-medium text-ink-900 hover:bg-canvas">
        <Icon name="chevron-down" size={12} className={`text-ink-400 transition-transform ${open ? '' : '-rotate-90'}`} />
        {label}
        {count ? <span className="ml-auto rounded-full bg-brand-50 px-1.5 text-[11px] font-semibold text-brand-700">{count}</span> : null}
      </button>
      {open ? <div className="px-3 pb-2">{children}</div> : null}
    </div>
  );
}

function Leaf({ label, checked, onChange, covered = false, strong = false }: {
  label: string; checked: boolean; onChange: (on: boolean) => void; covered?: boolean; strong?: boolean;
}) {
  return (
    <label className={`flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13px] ${covered ? 'text-ink-400' : 'cursor-pointer text-ink-700 hover:bg-canvas'}`} title={covered ? 'Covered by what it’s inside' : undefined}>
      <input type="checkbox" checked={checked} disabled={covered} onChange={(e) => onChange(e.target.checked)} />
      <span className={`truncate ${strong ? 'font-medium' : ''}`}>{label}</span>
    </label>
  );
}

/** Teams whole, or narrowed to people: the same way as round robin. */
function GroupPicker({ label, hint, catalog, value, onChange }: {
  label: string; hint?: string; catalog: Catalog; value: RestrictionGroup; onChange: (g: RestrictionGroup) => void;
}) {
  const set = (teamIds: string[], userIds: string[]) => onChange({ teamIds, userIds });
  return (
    <div>
      <span className={labelClass}>{label}</span>
      {hint ? <p className="-mt-0.5 mb-1.5 text-[12px] text-ink-400">{hint}</p> : null}
      <ul className="grid max-w-[560px] gap-1.5 sm:grid-cols-2">
        {catalog.teams.filter((t) => !t.superAdmin).map((t) => {
          const whole = value.teamIds.includes(t.id);
          const memberIds = t.members.map((m) => m.value);
          return (
            <li key={t.id} className="rounded-lg border border-line-soft p-2">
              <label className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-ink-900">
                <input
                  type="checkbox"
                  checked={whole}
                  onChange={(e) =>
                    set(
                      e.target.checked ? [...value.teamIds, t.id] : value.teamIds.filter((x) => x !== t.id),
                      value.userIds.filter((u) => !memberIds.includes(u)),
                    )
                  }
                />
                {t.label} <span className="font-normal text-ink-400">(whole team)</span>
              </label>
              {!whole && t.members.length ? (
                <div className="mt-1 space-y-0.5 pl-5">
                  {t.members.map((m) => (
                    <label key={m.value} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-ink-700">
                      <input
                        type="checkbox"
                        checked={value.userIds.includes(m.value)}
                        onChange={(e) => set(value.teamIds, e.target.checked ? [...value.userIds, m.value] : value.userIds.filter((x) => x !== m.value))}
                      />
                      <span className="truncate">{m.label}</span>
                    </label>
                  ))}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
