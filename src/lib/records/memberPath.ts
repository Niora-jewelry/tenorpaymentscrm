/**
 * A repeat-group row member, addressed like a field: `contact[0].email`.
 *
 * Used where a contact's or an owner's Email, Phone or Name needs the same
 * @mention, History and Notes as any other field (client, 6 Nov 2026). The
 * group key in front of the bracket is what permissions are checked against;
 * the database helpers read it the same way (migration 9918).
 */
export type MemberPath = { group: string; index: number; member: string };

const PATH = /^([a-z0-9_]{1,80})\[(\d{1,2})\]\.([a-z0-9_]{1,64})$/;

/** A field key, or a member path. */
export const FIELD_OR_MEMBER = /^[a-z0-9_]{1,80}(\[\d{1,2}\]\.[a-z0-9_]{1,64})?$/;

export function parseMemberPath(key: string): MemberPath | null {
  const m = PATH.exec(key);
  return m ? { group: m[1]!, index: Number(m[2]), member: m[3]! } : null;
}

export const memberPath = (group: string, index: number, member: string): string => `${group}[${index}].${member}`;

/** The field a key belongs to: itself, or the group of a member path. */
export const baseFieldKey = (key: string): string => key.split('[')[0]!;
