/**
 * What a viewer may know about a record's team assignments. Shared with the
 * client, so it imports nothing. Everything hidden is already absent: the
 * database never sends a team or a person this viewer may not see.
 */

export type TeamEntry = {
  teamId: string;
  label: string;
  /** True = the "Open" tag. Null = this viewer gets no indication either way. */
  open: boolean | null;
  /** User ids, the taker first. Empty when this viewer may not see them. */
  people: string[];
  /** "Assign to me". */
  canTake: boolean;
  /** "Unassign this team": removes the team, or a member of it. */
  canUnassign: boolean;
  /** "Assign a specific member", on a team that is still open. */
  canNameMember: boolean;
};

export type RecordTeams = {
  /** In this viewer's list, but they cannot open it until they take it. */
  locked: boolean;
  /** False while this viewer can only read the record until they take it. */
  writable: boolean;
  teams: TeamEntry[];
};

/** A team in the assign picker. `members` is empty without "Assign a specific member". */
export type AssignableTeam = { id: string; label: string; own: boolean; members: string[] };

export type TeamResult = { ok: true } | { ok: false; message: string };
