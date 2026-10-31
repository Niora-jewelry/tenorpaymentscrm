'use client';

/**
 * The Permissions spec's settings for one user type, or for one user.
 *
 *   Type mode   every setting's value for the type. Changing it changes every
 *               user on the type (except where a user has their own override).
 *   User mode   each row shows what their type gives them; a change becomes
 *               an OVERRIDE, marked as such with a reset back to the type
 *               (spec: "clearly mark which settings on a user are overrides,
 *               and offer a way to reset a user back to their template").
 *
 * A value above the acting admin's own level is shown but cannot be picked
 * (guardrail 2); the database refuses it regardless.
 */
import { useOptimistic, useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import type { SettingGroup, SettingRow } from '@/lib/records/permissionSettings';
import { setPermissionSettingAction, resetUserToTypeAction } from './templates/actions';

const RANK: Record<string, number> = { no: 0, hidden: 0, own: 0, mine: 1, view: 1, yes: 2, all: 2, full: 2, org: 2, edit: 2 };

/**
 * The six per-team settings as a table: a setting on each row, a team in each
 * column, the way the spec lays them out. 36 toggles in a list cannot be read;
 * this can. Each cell behaves exactly like a row above it.
 */
function TeamMatrix({
  rows,
  mode,
  shown,
  typeValues,
  ceiling,
  actorIsSuper,
  locked,
  onSet,
}: {
  rows: SettingRow[];
  mode: 'template' | 'user';
  shown: Record<string, string>;
  typeValues: Record<string, string>;
  ceiling: Record<string, string>;
  actorIsSuper: boolean;
  locked: boolean;
  onSet: (key: string, value: string | null) => void;
}) {
  const teams = [...new Map(rows.map((r) => [r.cell!.team, r.cell!.teamLabel])).entries()];
  const settings = [...new Map(rows.map((r) => [r.cell!.setting, r.cell!])).values()];
  const valueOf = (key: string) => shown[key] ?? (mode === 'user' ? typeValues[key] : undefined) ?? 'no';

  return (
    <div className="mt-3 overflow-x-auto rounded-lg border border-line-soft">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-line-soft bg-canvas/60">
            <th scope="col" className="px-3 py-2 text-[11.5px] font-semibold text-ink-500">Set for each team</th>
            {teams.map(([key, label]) => (
              <th key={key} scope="col" className="px-1.5 py-2 text-center text-[11.5px] font-semibold text-ink-700">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line-soft">
          {settings.map((s) => (
            <tr key={s.setting}>
              <th scope="row" className="px-3 py-1.5 font-normal">
                <span className="block text-[13px] font-medium text-ink-800">{s.settingLabel}</span>
                <span className="block text-[11.5px] leading-snug text-ink-400">{s.settingHint}</span>
              </th>
              {teams.map(([team, label]) => {
                const key = `team.${team}.${s.setting}`;
                const on = valueOf(key) === 'yes';
                const isOverride = mode === 'user' && shown[key] !== undefined;
                const tooHigh = !on && !actorIsSuper && (RANK[ceiling[key] ?? 'no'] ?? 0) < RANK.yes!;
                // Rule 4: without See team, See users does nothing.
                const inert = s.setting === 'see_users' && valueOf(`team.${team}.see_team`) !== 'yes';
                return (
                  <td key={team} className="px-1.5 py-1.5 text-center">
                    <span className="inline-flex items-center gap-1">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={`${label}: ${s.settingLabel}`}
                        disabled={locked || tooHigh}
                        title={tooHigh ? 'Higher than your own level — you cannot give it' : inert ? 'Works only with See team when assigned' : undefined}
                        onClick={() => onSet(key, on ? 'no' : 'yes')}
                        className={`min-w-10 cursor-pointer rounded-md px-2 py-1 text-[12px] font-semibold ring-1 ring-inset transition-colors disabled:cursor-not-allowed ${
                          on ? 'bg-brand-50 text-brand-700 ring-brand-200' : 'bg-white text-ink-400 ring-line hover:text-ink-900'
                        } ${inert ? 'opacity-50' : ''} ${isOverride ? 'outline-2 outline-offset-1 outline-warn' : ''}`}
                      >
                        {on ? 'Yes' : 'No'}
                      </button>
                      {isOverride && !locked ? (
                        <button
                          type="button"
                          aria-label={`Reset ${label}: ${s.settingLabel} to their type`}
                          title="Back to their type"
                          onClick={() => onSet(key, null)}
                          className="grid size-5 cursor-pointer place-items-center rounded text-ink-400 hover:bg-canvas hover:text-ink-900"
                        >
                          <Icon name="rotate-ccw" size={10} />
                        </button>
                      ) : null}
                    </span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SettingsPanel({
  mode,
  ownerId,
  groups,
  values,
  typeValues = {},
  typeLabel = null,
  ceiling,
  actorIsSuper,
  locked = null,
  grantOverrides = 0,
}: {
  mode: 'template' | 'user';
  ownerId: string;
  groups: SettingGroup[];
  /** The type's values (type mode), or the user's own overrides (user mode). */
  values: Record<string, string>;
  typeValues?: Record<string, string>;
  typeLabel?: string | null;
  ceiling: Record<string, string>;
  actorIsSuper: boolean;
  /** Why nothing here can be changed (guardrails 1 and 3), or null. */
  locked?: string | null;
  /** The user's tab / sub-tab / field overrides — "Reset to their type" removes those too. */
  grantOverrides?: number;
}) {
  const [shown, apply] = useOptimistic(values, (cur: Record<string, string>, change: { key: string; value: string | null }) => {
    const next = { ...cur };
    if (change.value === null) delete next[change.key];
    else next[change.key] = change.value;
    return next;
  });
  const [, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [resetting, startReset] = useTransition();
  const overrides = mode === 'user' ? Object.keys(shown).length + grantOverrides : 0;

  const set = (key: string, value: string | null) =>
    start(async () => {
      setError(null);
      apply({ key, value });
      const r = await setPermissionSettingAction({ ownerKind: mode, ownerId, key, value });
      if (!r.ok) setError(r.message ?? 'That change was not saved.');
    });

  return (
    <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
      <header className="flex flex-wrap items-center gap-3 border-b border-line-soft px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-semibold text-ink-900">Settings</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">
            {mode === 'template'
              ? 'The defaults for everyone of this type. Tabs, sub-tabs and fields are below.'
              : `What ${typeLabel ? `the ${typeLabel} type` : 'their type'} gives them, and where they differ.`}
          </p>
        </div>
        {mode === 'user' ? (
          <div className="flex items-center gap-2">
            <span className={`rounded-full px-2 py-0.5 text-[11.5px] font-semibold ${overrides ? 'bg-warn-bg text-warn' : 'bg-canvas text-ink-500'}`}>
              {overrides ? `${overrides} override${overrides === 1 ? '' : 's'}` : 'Matches their type'}
            </span>
            {overrides && !locked ? (
              <button
                type="button"
                disabled={resetting}
                onClick={() =>
                  startReset(async () => {
                    setError(null);
                    const r = await resetUserToTypeAction(ownerId);
                    if (!r.ok) setError(r.message ?? 'Could not reset.');
                  })
                }
                className="inline-flex items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-[12px] font-semibold text-ink-600 hover:border-ink-300 hover:text-ink-900"
              >
                <Icon name="rotate-ccw" size={12} />
                {resetting ? 'Resetting…' : 'Reset to their type'}
              </button>
            ) : null}
          </div>
        ) : null}
      </header>

      {locked ? (
        <p className="flex items-center gap-2 border-b border-line-soft bg-canvas px-4 py-2 text-[12.5px] text-ink-600">
          <Icon name="lock" size={12} /> {locked}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-center gap-2 border-b border-bad/20 bg-bad-bg px-4 py-2 text-[12.5px] text-bad">
          <Icon name="alert-triangle" size={12} /> {error}
        </p>
      ) : null}

      <div className="divide-y divide-line-soft">
        {groups.map((g) => (
          <div key={g.id} className="px-4 py-3.5">
            <h3 className="text-[12px] font-semibold uppercase tracking-[.07em] text-ink-700">{g.title}</h3>
            <p className="mt-0.5 text-[12px] text-ink-400">{g.blurb}</p>
            <div className="mt-2.5 grid gap-x-8 gap-y-1 @container lg:grid-cols-2">
              {g.rows.filter((row) => !row.cell).map((row) => {
                const own = shown[row.key];
                // Nothing stored resolves to the most restrictive value, which
                // every option list puts first (`user_perm`, migration 9810).
                const fromType = mode === 'user' ? typeValues[row.key] ?? row.options[0]?.value : undefined;
                const current = own ?? fromType ?? row.options[0]?.value;
                const isOverride = mode === 'user' && own !== undefined;
                return (
                  <div key={row.key} className="flex min-w-0 items-center gap-3 rounded-lg py-1.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-1.5 text-[13px] font-medium text-ink-800">
                        <span className="truncate">{row.label}</span>
                        {isOverride ? (
                          <span className="rounded bg-warn-bg px-1.5 py-px text-[10.5px] font-bold uppercase tracking-[.04em] text-warn">
                            Override
                          </span>
                        ) : null}
                      </p>
                      {row.hint ? <p className="truncate text-[11.5px] text-ink-400">{row.hint}</p> : null}
                      {isOverride && fromType ? (
                        <p className="text-[11.5px] text-ink-400">
                          Type gives {row.options.find((o) => o.value === fromType)?.label ?? fromType}
                        </p>
                      ) : null}
                    </div>
                    {row.fixed ? (
                      <span className="shrink-0 text-[12px] italic text-ink-400">{row.fixed}</span>
                    ) : (
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span role="radiogroup" aria-label={row.label} className="inline-flex rounded-lg border border-line bg-canvas p-0.5">
                          {row.options.map((o) => {
                            const on = current === o.value;
                            const tooHigh = !actorIsSuper && (RANK[o.value] ?? 0) > (RANK[ceiling[row.key] ?? 'no'] ?? 0);
                            return (
                              <button
                                key={o.value}
                                type="button"
                                role="radio"
                                aria-checked={on}
                                disabled={Boolean(locked) || tooHigh}
                                title={tooHigh ? 'Higher than your own level — you cannot give it' : undefined}
                                onClick={() => !on && set(row.key, o.value)}
                                className={`rounded-md px-2.5 py-1 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed ${
                                  on
                                    ? 'bg-white text-ink-900 shadow-[0_1px_2px_rgba(8,32,47,.12)] ring-1 ring-line'
                                    : 'text-ink-500 hover:text-ink-900 disabled:text-ink-300 disabled:hover:text-ink-300'
                                }`}
                              >
                                {o.label}
                              </button>
                            );
                          })}
                        </span>
                        {isOverride && !locked ? (
                          <button
                            type="button"
                            aria-label={`Reset ${row.label} to their type`}
                            title="Back to their type"
                            onClick={() => set(row.key, null)}
                            className="grid size-6 place-items-center rounded text-ink-400 hover:bg-canvas hover:text-ink-900"
                          >
                            <Icon name="rotate-ccw" size={11} />
                          </button>
                        ) : null}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
            {g.rows.some((row) => row.cell) ? (
              <TeamMatrix
                rows={g.rows.filter((row) => row.cell)}
                mode={mode}
                shown={shown}
                typeValues={typeValues}
                ceiling={ceiling}
                actorIsSuper={actorIsSuper}
                locked={Boolean(locked)}
                onSet={set}
              />
            ) : null}
          </div>
        ))}
      </div>
    </section>
  );
}
