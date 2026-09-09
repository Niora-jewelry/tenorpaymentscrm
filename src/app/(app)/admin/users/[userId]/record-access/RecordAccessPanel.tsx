'use client';

/**
 * Both directions of `record_visibility_grants`, for one person.
 *
 * ── TWO TABLES, NOT ONE ──────────────────────────────────────────────────
 * The grant is one-directional — `(owner_id, viewer_id)` unique, `owner_id <>
 * viewer_id` enforced — so "whose records can Sarah see" and "who can see
 * Sarah's records" are different questions with different answers. One combined
 * list would invite the reading that access is mutual, which is exactly the
 * assumption that quietly gives somebody more than an admin meant to.
 *
 * ── AND THE ROW IS NOT THE WHOLE ANSWER ──────────────────────────────────
 * A grant follows the owner's TEAM MEMBERSHIPS (`can_see_record()` joins to
 * `record_team_members`, never to `records.creator_user_id` — "Record creator
 * grants nothing"), so the set of records it covers changes as the owner is
 * added to and removed from teams. There is no count to show that would still
 * be true a minute later, so the panel says what the grant means instead of
 * pretending to a number.
 *
 * No optimistic local state: this is an infrequent admin action on a screen
 * whose whole job is being accurate about a permission, and a `revalidatePath`
 * round trip is the right amount of engineering. Same call as `UsersTable`.
 */
import { useState, useTransition } from 'react';
import { Button, OutlineChip } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { PersonAvatar } from '@/proto/ui/people';
import { formatDateTime } from '@/proto/ui/tokens';
import { grantRecordVisibilityAction, revokeRecordVisibilityAction } from '../../actions';
import type { VisibilityGrant, VisibilityPerson } from '@/lib/records/adminVisibility';

/** Which way round a table is. The subject is one end of every row in it; the
 * `other` end is the person the row is about. */
type Direction = 'sees' | 'seenBy';

export function RecordAccessPanel({
  subject,
  people,
  sees,
  seenBy,
}: {
  subject: { id: string; name: string; email: string; isAdmin: boolean };
  people: VisibilityPerson[];
  sees: VisibilityGrant[];
  seenBy: VisibilityGrant[];
}) {
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ direction: Direction; message: string } | null>(null);
  const [staged, setStaged] = useState<{ sees: string; seenBy: string }>({ sees: '', seenBy: '' });

  const grant = (direction: Direction, otherId: string) => {
    if (!otherId) return;
    setNotice(null);
    startTransition(async () => {
      // The subject is the VIEWER in the "sees" table and the OWNER in the
      // "seen by" one. Deciding that here, once, is what keeps the two tables
      // from being two half-copies of the same call with the arguments swapped
      // in one of them.
      const result =
        direction === 'sees'
          ? await grantRecordVisibilityAction(otherId, subject.id)
          : await grantRecordVisibilityAction(subject.id, otherId);
      if (result.ok) setStaged((s) => ({ ...s, [direction]: '' }));
      else setNotice({ direction, message: result.message });
    });
  };

  const revoke = (direction: Direction, row: VisibilityGrant) => {
    setNotice(null);
    startTransition(async () => {
      const result = await revokeRecordVisibilityAction(row.id, row.ownerId, row.viewerId);
      if (!result.ok) setNotice({ direction, message: result.message });
    });
  };

  const table = (
    direction: Direction,
    rows: VisibilityGrant[],
    opts: { title: string; blurb: string; empty: string; addLabel: string },
  ) => {
    // Everyone not already on this side of a grant, and never the subject —
    // `visibility_grant_not_self` refuses that at the database, so offering it
    // would be offering a refusal.
    const taken = new Set(rows.map((r) => (direction === 'sees' ? r.ownerId : r.viewerId)));
    const addable = people.filter((p) => p.id !== subject.id && !taken.has(p.id));
    const rowNotice = notice?.direction === direction ? notice.message : null;

    return (
      <section className="overflow-hidden rounded-xl border border-line bg-white shadow-[0_1px_2px_rgba(8,32,47,.05)]">
        <header className="border-b border-line-soft px-4 py-3">
          <h2 className="text-[14px] font-semibold text-ink-900">{opts.title}</h2>
          <p className="mt-0.5 text-[12.5px] text-ink-500">{opts.blurb}</p>
        </header>

        {rows.length ? (
          <ul>
            {rows.map((r) => {
              const other = direction === 'sees'
                ? { id: r.ownerId, name: r.ownerName }
                : { id: r.viewerId, name: r.viewerName };
              return (
                <li key={r.id} className="flex items-center gap-2.5 border-b border-line-faint px-4 py-2.5 last:border-0">
                  <PersonAvatar
                    person={{ id: other.id, name: other.name, email: '', suspended: false, unknown: false }}
                    size={24}
                  />
                  <div className="min-w-0">
                    <div className="truncate text-[13.5px] font-medium text-ink-900">{other.name}</div>
                    <div className="text-[11.5px] text-ink-400">
                      {r.grantedByName ? `Granted by ${r.grantedByName}` : 'Granted by an account since removed'}
                      {' · '}
                      {formatDateTime(r.createdAt)}
                    </div>
                  </div>
                  <span className="ml-auto">
                    <Button size="sm" variant="ghost" icon="x" disabled={pending} onClick={() => revoke(direction, r)}>
                      Revoke
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="px-4 py-5 text-[13px] text-ink-400">{opts.empty}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft bg-canvas/50 px-4 py-2.5">
          <select
            aria-label={opts.addLabel}
            disabled={pending || addable.length === 0}
            value={staged[direction]}
            onChange={(e) => setStaged((s) => ({ ...s, [direction]: e.target.value }))}
            className="min-w-[240px] flex-1 rounded border border-line bg-white px-2 py-1 text-[12.5px] outline-none focus:border-brand-600"
          >
            <option value="">{addable.length ? `${opts.addLabel}…` : 'Nobody left to add'}</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>
                {/* Email always, not only when it differs from the name: on a
                    screen that hands one person sight of another's records,
                    "which Chris" is not a question to leave to a display name
                    that may be blank or shared. */}
                {p.name} — {p.email}
                {p.suspended ? ' (paused)' : ''}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            disabled={pending || !staged[direction]}
            onClick={() => grant(direction, staged[direction])}
          >
            Grant
          </Button>
        </div>

        {rowNotice ? (
          <p className="flex items-start gap-1.5 border-t border-line-soft bg-[#fdf1d8] px-4 py-2 text-[12px] text-[#8a5a09]">
            <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
            {rowNotice}
          </p>
        ) : null}
      </section>
    );
  };

  return (
    <div className="space-y-4">
      {subject.isAdmin ? (
        <p className="flex items-start gap-2 rounded-panel border border-line bg-white px-4 py-3 text-[12.5px] text-ink-500">
          <Icon name="alert-triangle" size={14} className="mt-[2px] shrink-0 text-ink-400" />
          <span>
            <strong className="text-ink-700">{subject.name} is an admin</strong> and already sees every
            record — `can_see_record()` returns true for an admin before it looks at any grant. Rows in
            the first table below change nothing while that is true; rows in the second one still do,
            because they are about {subject.name}&rsquo;s own records.
          </span>
        </p>
      ) : null}

      {table('sees', sees, {
        title: `Records ${subject.name} can also see`,
        blurb:
          'Every record these people are a team member of becomes visible to ' +
          `${subject.name} — and stops being visible the moment they leave that record's team.`,
        empty: `${subject.name} sees only the records they are a team member of.`,
        addLabel: 'Grant access to someone’s records',
      })}

      {table('seenBy', seenBy, {
        title: `Who can also see ${subject.name}'s records`,
        blurb:
          `These people see every record ${subject.name} is a team member of. ` +
          'The grant is one-directional — it says nothing about the other way round.',
        empty: `Nobody has been granted access to ${subject.name}'s records.`,
        addLabel: 'Give someone access to these records',
      })}

      <p className="flex items-start gap-2 px-1 text-[12px] leading-relaxed text-ink-400">
        <OutlineChip tone="brand">Enforced in the database</OutlineChip>
        <span>
          Unlike the Hidden/View/Edit matrix, this is not applied by a render path that could forget
          it: <code className="text-ink-500">can_see_record()</code> is called by the row-level
          security policy on every content table, so a record nobody here has a path to is not
          filtered from the response — it is not in the result set. Changes take effect on the next
          query.
        </span>
      </p>
    </div>
  );
}
