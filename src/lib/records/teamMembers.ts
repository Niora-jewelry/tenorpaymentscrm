/**
 * The one field type whose value is a permission.
 *
 * `team_member` stores user ids, `sync_record_team_members()` turns them into
 * `record_team_members` rows on every write, and `can_see_record()` reads that
 * table on every row of every query. So a write to a field of this type is a
 * change to who can read the record — which is why it is validated here, in the
 * service layer, rather than being trusted to arrive well-formed:
 *
 *   - **Shape.** A value that is not a JSON array makes the trigger raise
 *     (migration 40 hardened the message), so the failure is loud either way —
 *     but it arrives as a 500 from three layers down instead of a sentence.
 *   - **Real people.** An id with no profile behind it violates
 *     `record_team_members`' foreign key, same story. A typo'd uuid should read
 *     as "that is not someone here", not as `23503`.
 *   - **Duplicates.** Harmless in the database (`on conflict do nothing`) and
 *     not harmless on screen: the same avatar twice in a stack reads as two
 *     people with the same name.
 *
 * Keyed off the field's TYPE, never off its key. `team_members_assigned` happens
 * to be the only field of this type in the seed, but the type is what the
 * behaviour belongs to — a second one added through Admin → Presets tomorrow
 * gets the same treatment with no edit here, and no code names a field.
 */
import 'server-only';
import type { AuthContext } from './permissions';
import { teamDirectory } from './directory';

export type TeamMemberValue =
  | { ok: true; ids: string[] }
  | { ok: false; message: string };

/** Postgres will reject anything else as a uuid cast inside the trigger; this
 * just gets there first, with a sentence. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse a submitted team-member value into the id list that may be stored.
 *
 * An EMPTY list is valid, deliberately. "Ability to add & remove" is the
 * client's own wording for this field, and a record with nobody assigned is a
 * real state — it is visible to admins, and it is the state every record reaches
 * the moment its last member leaves. The UI says what emptying it costs before
 * it happens; refusing it here would be inventing a rule the specification does
 * not have.
 */
export async function parseTeamMembers(ctx: AuthContext, value: unknown): Promise<TeamMemberValue> {
  if (value == null) return { ok: true, ids: [] };
  if (!Array.isArray(value)) {
    return { ok: false, message: 'Team members must be a list of people.' };
  }

  const ids: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string' || !UUID.test(raw)) {
      return { ok: false, message: 'That is not a valid team member.' };
    }
    if (!ids.includes(raw)) ids.push(raw);
  }
  if (!ids.length) return { ok: true, ids: [] };

  const directory = await teamDirectory(ctx);
  const known = new Map(directory.map((p) => [p.id, p]));
  const missing = ids.filter((id) => !known.has(id));
  if (missing.length) {
    return {
      ok: false,
      message:
        missing.length === 1
          ? 'One of those people no longer has an account here.'
          : `${missing.length} of those people no longer have accounts here.`,
    };
  }

  // A SUSPENDED account is accepted, and the picker does not offer one. That is
  // not an inconsistency: a pause is temporary and reversible (`pauseUser`
  // flips one column), so refusing to keep an already-assigned paused colleague
  // on a record would quietly drop them off it the first time anything else on
  // that field was edited. Not offering a paused account for a NEW assignment is
  // a UI judgement about what is useful; refusing it here would be a rule about
  // what is permitted, and there isn't one.
  return { ok: true, ids };
}
