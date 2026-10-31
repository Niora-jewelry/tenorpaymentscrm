'use client';

/**
 * The Team member(s) assigned control: one line wherever it sits (a list cell,
 * a drawer card, the header strip), and a panel to work it.
 *
 *   Open    the team, with an "Open" tag, until someone takes it
 *   Taken   the team and the person
 *   Hidden  absent. The server sent nothing, so there is nothing to leave out.
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
import type { AssignableTeam, RecordTeams, TeamEntry, TeamResult } from '@/lib/teams/types';
import { assignMemberAction, assignTeamAction, takeAssignmentAction, unassignMemberAction, unassignTeamAction } from './teamActions';

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

function TeamChip({ entry }: { entry: TeamEntry }) {
  const byId = usePeopleById();
  const people = entry.people.map((id) => resolvePerson(id, byId));
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-line bg-white px-1.5 py-0.5 text-[12px] text-ink-700">
      <span className="shrink-0 font-medium text-ink-800">{entry.label}</span>
      {people.length ? (
        <>
          <span className="flex shrink-0 -space-x-1">
            {people.slice(0, 2).map((p) => (
              <PersonAvatar key={p.id} person={p} size={16} />
            ))}
          </span>
          <span className="min-w-0 truncate text-ink-500">{people.map((p) => p.name).join(', ')}</span>
        </>
      ) : null}
      {entry.open ? <OpenTag /> : null}
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
  const onRecord = new Set(teams.map((t) => t.teamId));
  // A team hidden from this viewer can still be on the record; the database
  // answers "already assigned" if they try, and that is all they learn.
  const addable = writable ? assignable.filter((t) => !onRecord.has(t.id)) : [];
  const take = offersTake ? teams.find((t) => t.canTake) : undefined;
  const hasPanel = teams.length > 0 || addable.length > 0;

  return (
    <span className="flex min-w-0 flex-1 items-center gap-1.5" onClick={stop} onDoubleClick={stop}>
      <button
        ref={anchor}
        type="button"
        disabled={!hasPanel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Team members assigned: ${teams.map((t) => t.label).join(', ') || 'none'}`}
        onClick={() => setOpen((o) => !o)}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md py-0.5 text-left transition-colors hover:bg-canvas disabled:cursor-default disabled:hover:bg-transparent"
      >
        {teams.length ? (
          <>
            <TeamChip entry={teams[0]!} />
            {teams.length > 1 ? <span className="shrink-0 text-[12px] font-medium text-ink-400">+{teams.length - 1}</span> : null}
          </>
        ) : addable.length ? (
          <span className="inline-flex items-center gap-1 px-1 text-[12.5px] text-ink-400">
            <Icon name="plus" size={12} /> Assign
          </span>
        ) : (
          <span className="px-1 text-ink-400/70">—</span>
        )}
      </button>
      {take ? <AssignToMe moduleSlug={moduleSlug} recordId={recordId} team={take} /> : null}

      <MenuSurface open={open} onClose={() => setOpen(false)} anchorRef={anchor} align="left" width={340} label="Team assignment" role="dialog" padded={false}>
        {open ? <Panel moduleSlug={moduleSlug} recordId={recordId} teams={teams} addable={addable} assignable={assignable} viewerId={viewerId} viewerIsAdmin={viewerIsAdmin} /> : null}
      </MenuSurface>
    </span>
  );
}

function Panel({
  moduleSlug,
  recordId,
  teams,
  addable,
  assignable,
  viewerId,
  viewerIsAdmin,
}: {
  moduleSlug: string;
  recordId: string;
  teams: TeamEntry[];
  addable: AssignableTeam[];
  assignable: AssignableTeam[];
  viewerId: string;
  viewerIsAdmin: boolean;
}) {
  const byId = usePeopleById();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  /** The team whose member list is open, for "a specific member". */
  const [naming, setNaming] = useState<string | null>(null);
  /** Taking yourself off can take the record out of your own view, so it asks once. */
  const [confirmSelf, setConfirmSelf] = useState<string | null>(null);

  const act = (call: () => Promise<TeamResult>) =>
    start(async () => {
      setError(null);
      setConfirmSelf(null);
      const r = await call();
      if (r.ok) setNaming(null);
      else setError(r.message);
    });

  const base = { moduleSlug, recordId };

  const memberList = (team: { id: string; label: string; members: string[] }) => (
    <ul className="mt-1 space-y-px rounded-lg border border-line-soft bg-canvas p-1">
      {team.members.map((id) => {
        const p = resolvePerson(id, byId);
        return (
          <li key={id}>
            <button
              type="button"
              disabled={pending}
              onClick={() => act(() => assignMemberAction({ ...base, teamId: team.id, userId: id }))}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12.5px] text-ink-700 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              <PersonAvatar person={p} size={18} />
              <span className="min-w-0 truncate">{p.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );

  return (
    <div className="max-h-[420px] overflow-y-auto p-3">
      <p className="text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Assigned</p>
      {teams.length ? (
        <ul className="mt-1.5 space-y-2">
          {teams.map((t) => {
            const pick = assignable.find((a) => a.id === t.teamId);
            return (
              <li key={t.teamId} className="rounded-lg border border-line-soft px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[13px] font-semibold text-ink-900">{t.label}</span>
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

                {t.people.map((id) => {
                  const p = resolvePerson(id, byId);
                  const mine = id === viewerId && !viewerIsAdmin;
                  const remove = () => act(() => unassignMemberAction({ ...base, teamId: t.teamId, userId: id }));
                  return (
                    <div key={id} className="mt-1.5">
                      <div className="flex items-center gap-2 text-[12.5px] text-ink-700">
                        <PersonAvatar person={p} size={18} />
                        <span className="min-w-0 truncate">{p.name}</span>
                        {t.canUnassign ? (
                          <button
                            type="button"
                            disabled={pending}
                            aria-label={`Unassign ${p.name}`}
                            title={`Unassign ${p.name}. ${t.label} goes back to Open.`}
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

                {t.canNameMember && pick?.members.length ? (
                  <div className="mt-1.5">
                    <button
                      type="button"
                      onClick={() => setNaming((n) => (n === t.teamId ? null : t.teamId))}
                      className="inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium text-brand-600 hover:underline"
                    >
                      Assign a specific member
                      <Icon name={naming === t.teamId ? 'chevron-up' : 'chevron-down'} size={12} />
                    </button>
                    {naming === t.teamId ? memberList(pick) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="mt-1 text-[12.5px] text-ink-400">No team is assigned.</p>
      )}

      {addable.length ? (
        <>
          <p className="mt-3 text-[11.5px] font-semibold uppercase tracking-[.06em] text-ink-400">Add a team</p>
          <ul className="mt-1.5 space-y-px">
            {addable.map((t) => (
              <li key={t.id}>
                <div className="flex items-center gap-2 rounded-md py-0.5">
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => act(() => assignTeamAction({ ...base, teamId: t.id }))}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] text-ink-800 hover:bg-canvas disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <Icon name="plus" size={13} className="shrink-0 text-ink-400" />
                    <span className="min-w-0 truncate">{t.label}</span>
                  </button>
                  {t.members.length ? (
                    <button
                      type="button"
                      aria-expanded={naming === t.id}
                      onClick={() => setNaming((n) => (n === t.id ? null : t.id))}
                      className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded px-1 py-1 text-[12px] font-medium text-brand-600 hover:underline"
                    >
                      A member
                      <Icon name={naming === t.id ? 'chevron-up' : 'chevron-down'} size={12} />
                    </button>
                  ) : null}
                </div>
                {naming === t.id ? memberList(t) : null}
              </li>
            ))}
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
