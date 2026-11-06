'use client';

/**
 * The Team member(s) assigned control: one line wherever it sits (a list cell,
 * a drawer card, the header strip), and a panel to work it.
 *
 *   Open    the team's initials, marked open, until someone takes it
 *   Taken   the person's initials and their team's, full names on the tooltip
 *   Hidden  absent. The server sent nothing, so there is nothing to leave out.
 *
 * People are added one at a time, shown as "Full name / Team". A team can no
 * longer be added whole (client, 6 Nov 2026), though a team already open on a
 * record stays there until someone is named or it is unassigned.
 *
 * Every button here is decided by the database (`canTake`, `canUnassign`,
 * `canNameMember`, the assign picker's list). The rules themselves are enforced
 * again by the functions these actions call.
 */
import { useRef, useState, useTransition, type MouseEvent } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
import { MenuSurface } from '@/proto/ui/MenuSurface';
import { PersonAvatar, resolvePerson, usePeopleById } from '@/proto/ui/people';
import { initialsFor } from '@/proto/ui/identity';
import type { AssignableTeam, RecordTeams, TeamEntry, TeamResult } from '@/lib/teams/types';
import { assignMemberAction, takeAssignmentAction, unassignMemberAction, unassignTeamAction } from './teamActions';

const stop = (e: MouseEvent) => e.stopPropagation();

function OpenTag() {
  return <span className="shrink-0 rounded bg-warn-bg px-1.5 py-px text-[11px] font-semibold text-warn">Open</span>;
}

/** Assign to me, wherever the viewer stands: list, drawer, or the locked sheet. */
export function AssignToMe({ moduleSlug, recordId, team, size = 'sm', label }: { moduleSlug: string; recordId: string; team: TeamEntry; size?: 'sm' | 'md'; label?: string }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2" onClick={stop}>
      <Button
        size={size}
        variant="primary"
        loading={pending}
        loadingLabel="Assigning…"
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await takeAssignmentAction({ moduleSlug, recordId, teamId: team.teamId });
            if (!r.ok) setError(r.message);
          })
        }
      >
        {label ?? 'Assign to me'}
      </Button>
      {error ? (
        <span role="alert" title={error} className="max-w-[220px] truncate text-[12px] text-bad">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** How many fit on a line before the rest fold into "+N". */
const INLINE = 5;

type Slot = { key: string; full: string; person: ReturnType<typeof resolvePerson> | null; team: string; open: boolean };

/** One slot per person, and one for a team nobody has taken yet. */
function slotsOf(teams: TeamEntry[], byId: ReturnType<typeof usePeopleById>): Slot[] {
  return teams.flatMap((t): Slot[] => {
    const team = initialsFor(t.label);
    if (!t.people.length) return [{ key: t.teamId, full: `${t.label}${t.open ? ' / Open' : ''}`, person: null, team, open: Boolean(t.open) }];
    return t.people.map((id) => {
      const person = resolvePerson(id, byId);
      return { key: `${t.teamId}:${id}`, full: `${person.name} / ${t.label}`, person, team, open: false };
    });
  });
}

/** Initials only, so more people fit inline. The tooltip has the full names. */
function InitialsChip({ slot }: { slot: Slot }) {
  return (
    <span
      title={slot.full}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full border py-px pl-px pr-1.5 text-[11px] font-semibold tabular-nums ${
        slot.open ? 'border-[#f7e0af] bg-warn-bg text-warn' : 'border-line bg-white text-ink-500'
      }`}
    >
      {/* The chip's own tooltip wins: the avatar's would show an email address. */}
      {slot.person ? (
        <span className="pointer-events-none inline-flex">
          <PersonAvatar person={slot.person} size={18} />
        </span>
      ) : (
        <span className="pl-1">Open</span>
      )}
      {slot.team}
    </span>
  );
}

export function TeamAssignments({
  moduleSlug,
  recordId,
  data,
  assignable,
  viewerId,
  viewerIsAdmin,
  offersTake = true,
}: {
  moduleSlug: string;
  recordId: string;
  data: RecordTeams | undefined;
  assignable: AssignableTeam[];
  viewerId: string;
  viewerIsAdmin: boolean;
  /** Off in the list, where Assign to me sits in the frozen Deal Name cell. */
  offersTake?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const teams = data?.teams ?? [];
  const writable = data?.writable ?? false;
  const byId = usePeopleById();
  const onRecord = new Map(teams.map((t) => [t.teamId, t]));
  /*
   * Everyone this viewer may add: people of a team not on the record yet, or of
   * one still open there. One person per team, so a taken team offers nobody.
   * A team hidden from this viewer can still be on the record; the database
   * answers "already taken" if they try, and that is all they learn.
   */
  const addable: Addable[] = !writable
    ? []
    : assignable
        .filter((t) => !onRecord.has(t.id) || onRecord.get(t.id)!.canNameMember)
        .flatMap((t) => t.members.map((id) => ({ teamId: t.id, teamLabel: t.label, userId: id, name: resolvePerson(id, byId).name })))
        .sort((a, b) => a.name.localeCompare(b.name) || a.teamLabel.localeCompare(b.teamLabel));
  const take = offersTake ? teams.find((t) => t.canTake) : undefined;
  const hasPanel = teams.length > 0 || addable.length > 0;
  const slots = slotsOf(teams, byId);

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" onClick={stop} onDoubleClick={stop}>
      <button
        ref={anchor}
        type="button"
        disabled={!hasPanel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Team members assigned: ${slots.map((s) => s.full).join(', ') || 'none'}`}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 overflow-hidden rounded-md py-0.5 text-left transition-colors hover:bg-canvas disabled:cursor-default disabled:hover:bg-transparent"
      >
        {slots.length ? (
          <>
            {slots.slice(0, INLINE).map((s) => (
              <InitialsChip key={s.key} slot={s} />
            ))}
            {slots.length > INLINE ? (
              <span title={slots.slice(INLINE).map((s) => s.full).join('\n')} className="shrink-0 text-[12px] font-medium text-ink-400">
                +{slots.length - INLINE}
              </span>
            ) : null}
          </>
        ) : addable.length ? (
          <span className="inline-flex items-center gap-1 px-1 text-[12.5px] text-ink-400">
            <Icon name="plus" size={12} /> Add user
          </span>
        ) : (
          <span className="px-1 text-ink-400/70">—</span>
        )}
      </button>
      {take ? <AssignToMe moduleSlug={moduleSlug} recordId={recordId} team={take} /> : null}

      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="left" width={340} label="Team assignment" role="dialog" padded={false}>
        {open ? <Panel moduleSlug={moduleSlug} recordId={recordId} teams={teams} addable={addable} viewerId={viewerId} viewerIsAdmin={viewerIsAdmin} /> : null}
      </MenuSurface>
    </span>
  );
}

type Addable = { teamId: string; teamLabel: string; userId: string; name: string };

function Panel({
  moduleSlug,
  recordId,
  teams,
  addable,
  viewerId,
  viewerIsAdmin,
}: {
  moduleSlug: string;
  recordId: string;
  teams: TeamEntry[];
  addable: Addable[];
  viewerId: string;
  viewerIsAdmin: boolean;
}) {
  const byId = usePeopleById();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [needle, setNeedle] = useState('');
  /** Taking yourself off can take the record out of your own view, so it asks once. */
  const [confirmSelf, setConfirmSelf] = useState<string | null>(null);

  const act = (call: () => Promise<TeamResult>) =>
    start(async () => {
      setError(null);
      setConfirmSelf(null);
      const r = await call();
      if (r.ok) setNeedle('');
      else setError(r.message);
    });

  const base = { moduleSlug, recordId };

  const wanted = needle.trim().toLowerCase();
  const shown = wanted ? addable.filter((a) => `${a.name} / ${a.teamLabel}`.toLowerCase().includes(wanted)) : addable;

  return (
    <div className="max-h-[420px] overflow-y-auto p-3">
      <p className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Assigned</p>
      {teams.length ? (
        <ul className="mt-1.5 space-y-1">
          {teams.map((t) => {
            return (
              <li key={t.teamId}>
                {/* A team nobody has taken: there is no person to show yet. */}
                {t.people.length === 0 ? (
                <div className="flex items-center gap-2 rounded-md px-1 py-0.5">
                  <span className="min-w-0 truncate text-[12.5px] text-ink-700">{t.label}</span>
                  {t.open ? <OpenTag /> : null}
                  <span className="ml-auto flex shrink-0 items-center gap-2">
                    {t.canTake ? <AssignToMe moduleSlug={moduleSlug} recordId={recordId} team={t} /> : null}
                    {t.canUnassign ? (
                      <button
                        type="button"
                        disabled={pending}
                        aria-label={`Unassign the ${t.label} team`}
                        title={`Unassign the ${t.label} team`}
                        onClick={() => act(() => unassignTeamAction({ ...base, teamId: t.teamId }))}
                        className="grid size-6 cursor-pointer place-items-center rounded text-ink-400 hover:bg-canvas hover:text-ink-900 disabled:cursor-not-allowed"
                      >
                        <Icon name="x" size={13} />
                      </button>
                    ) : null}
                  </span>
                </div>
                ) : null}

                {t.people.map((id) => {
                  const p = resolvePerson(id, byId);
                  const mine = id === viewerId && !viewerIsAdmin;
                  const remove = () => act(() => unassignMemberAction({ ...base, teamId: t.teamId, userId: id }));
                  return (
                    <div key={id}>
                      <div className="flex items-center gap-2 rounded-md px-1 py-0.5 text-[12.5px] text-ink-700">
                        <PersonAvatar person={p} size={18} />
                        <span className="min-w-0 truncate">
                          {p.name} <span className="text-ink-400">/ {t.label}</span>
                        </span>
                        {t.canUnassign ? (
                          <button
                            type="button"
                            disabled={pending}
                            aria-label={`Unassign ${p.name}`}
                            title={`Unassign ${p.name}`}
                            onClick={() => (mine ? setConfirmSelf(id) : remove())}
                            className="ml-auto grid size-6 shrink-0 cursor-pointer place-items-center rounded text-ink-400 hover:bg-canvas hover:text-ink-900 disabled:cursor-not-allowed"
                          >
                            <Icon name="x" size={12} />
                          </button>
                        ) : null}
                      </div>
                      {confirmSelf === id ? (
                        <div className="mt-1.5 rounded-md bg-warn-bg px-2 py-1.5 text-[12px] text-warn">
                          You may lose access to this record.
                          <span className="mt-1 flex gap-1.5">
                            <Button size="sm" variant="danger" onClick={remove}>
                              Unassign me
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => setConfirmSelf(null)}>
                              Keep it
                            </Button>
                          </span>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1 text-[12.5px] text-ink-400">Nobody is assigned.</p>
      )}

      {addable.length ? (
        <>
          <p className="mt-3 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Add a user</p>
          {addable.length > 6 ? (
            <input
              type="search"
              value={needle}
              onChange={(e) => setNeedle(e.currentTarget.value)}
              placeholder="Search name or team…"
              aria-label="Search users"
              className="mt-1.5 w-full rounded-md border border-line px-2 py-1.5 text-[12.5px] outline-none focus-field"
            />
          ) : null}
          <ul className="mt-1.5 space-y-px">
            {shown.map((a) => {
              const p = resolvePerson(a.userId, byId);
              return (
                <li key={`${a.teamId}:${a.userId}`}>
                  <button
                    type="button"
                    disabled={pending}
                    title={`Add ${a.name} / ${a.teamLabel}`}
                    onClick={() => act(() => assignMemberAction({ ...base, teamId: a.teamId, userId: a.userId }))}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-left text-[12.5px] text-ink-700 hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <PersonAvatar person={p} size={18} />
                    <span className="min-w-0 truncate">
                      {a.name} <span className="text-ink-400">/ {a.teamLabel}</span>
                    </span>
                    <Icon name="plus" size={13} className="ml-auto shrink-0 text-ink-400" />
                  </button>
                </li>
              );
            })}
            {shown.length === 0 ? <li className="px-1 py-1 text-[12.5px] text-ink-400">Nobody matches.</li> : null}
          </ul>
        </>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 rounded-md bg-bad-bg px-2 py-1.5 text-[12px] text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Above the drawer while the viewer can read this record but not work it yet. */
export function OpenRecordNotice({ moduleSlug, recordId, data }: { moduleSlug: string; recordId: string; data: RecordTeams }) {
  const take = data.teams.find((t) => t.canTake);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-[#f7e0af] bg-[#fdf1d8] px-3 py-2 text-[13px] text-[#8a5a09]">
      <Icon name="eye" size={14} className="shrink-0" />
      <span className="min-w-0 flex-1">This record is open. You can read it{take ? '. Assign it to yourself to work on it.' : ' until someone takes it.'}</span>
      {take ? <AssignToMe moduleSlug={moduleSlug} recordId={recordId} team={take} /> : null}
    </div>
  );
}
