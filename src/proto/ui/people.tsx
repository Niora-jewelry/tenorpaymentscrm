'use client';

/**
 * Who the real people are, for every component that renders a person.
 *
 * The `team_member` field type stores user ids and nothing else — it is the ONE
 * field that grants record visibility (migration 6), so what it holds has to be
 * an id, never a name. Every surface that DRAWS one (`AvatarStack` in a table
 * cell, the drawer's picker, the create dialog) therefore needs a way to turn
 * those ids into people, and none of them are in a position to fetch it: they
 * are Client Components several levels below the request.
 *
 * Context rather than props, deliberately. The alternative is threading a
 * roster through `RecordsTable` → `DataTable` → `CellValue`, and through
 * `DrawerTabs` → `RealFieldGrid` → `FieldRenderer` — six components that have no
 * other reason to know people exist, two of which are the prototype's own reused
 * UI. `(app)/layout.tsx` provides it once, above every real screen.
 *
 * ── THE FALLBACK IS THE PROTOTYPE'S OWN FIXTURE ──────────────────────────
 * With no provider above it, `usePeople()` returns `src/proto/data.ts`'s
 * `USERS`. That is what keeps `/prototype/*` working unchanged — it has no
 * database and its records' team-member values are fixture ids — and it means
 * `AvatarStack` needs no "which world am I in" branch.
 *
 * ── AN UNRESOLVED ID IS SHOWN, NOT DROPPED ───────────────────────────────
 * `AvatarStack` used to `.filter(Boolean)` ids it could not resolve, so a member
 * whose profile had since been soft-deleted simply disappeared from the record —
 * a person silently missing from the field that decides who can see it. Unknown
 * ids now resolve to a neutral placeholder that says so.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { USERS } from '../data';
import { hueForId, initialsFor } from './identity';

/** One assignable person. `email` disambiguates two people with the same (or
 * no) display name — see migration 40 for why that is a security property here
 * and not a nicety. `suspended` is offered so a picker can refuse a paused
 * account while still resolving one that is already assigned. */
export type Person = {
  id: string;
  name: string;
  email: string;
  suspended: boolean;
};

/** The prototype's fixture, in this shape. Its users have no email and are
 * never paused; the ids are `u1`-style, not uuids, which is exactly why the two
 * worlds can share one lookup without colliding. */
const PROTOTYPE_PEOPLE: Person[] = USERS.map((u) => ({
  id: u.id,
  name: u.name,
  email: '',
  suspended: false,
}));

const PeopleContext = createContext<Person[] | null>(null);

export function PeopleProvider({ people, children }: { people: Person[]; children: ReactNode }) {
  // Stable identity per list, so the memoised map below survives re-renders of
  // whatever this wraps — which, in the layout, is every page in the app.
  const value = useMemo(() => people, [people]);
  return <PeopleContext.Provider value={value}>{children}</PeopleContext.Provider>;
}

/** Everyone assignable, in display order. The prototype's fixture when there is
 * no provider — see this file's header. */
export function usePeople(): Person[] {
  return useContext(PeopleContext) ?? PROTOTYPE_PEOPLE;
}

export function usePeopleById(): Map<string, Person> {
  const people = usePeople();
  return useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
}

/** What to draw for one id. Never null: an id nobody knows about still gets a
 * person, marked `unknown`, because a member of this field silently vanishing
 * from a record is the failure this exists to prevent. */
export type ResolvedPerson = Person & { unknown: boolean };

export function resolvePerson(id: string, byId: Map<string, Person>): ResolvedPerson {
  const found = byId.get(id);
  if (found) return { ...found, unknown: false };
  return { id, name: 'Unknown user', email: '', suspended: false, unknown: true };
}

/** The prototype's `Avatar`, for a real person: same circle of initials, with
 * the hue derived from the id instead of read off a fixture row. */
export function PersonAvatar({
  person,
  size = 22,
}: {
  person: ResolvedPerson;
  size?: number;
}) {
  const title = person.unknown
    ? `Unknown user — no profile for ${person.id}`
    : [person.name, person.email].filter(Boolean).join(' · ');
  return (
    <span
      title={title}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        // A neutral grey for an id with no profile behind it — a coloured
        // circle would read as a real person.
        background: person.unknown ? '#9aa8b2' : `hsl(${hueForId(person.id)} 52% 42%)`,
      }}
    >
      {person.unknown ? '?' : initialsFor(person.name)}
    </span>
  );
}
