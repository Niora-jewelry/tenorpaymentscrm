/**
 * What a field is to the application and to the agreement, and which of the two
 * a record is waiting on (Field Highlight Glows spec). Pure and safe in the
 * browser: the drawer asks these questions as staff type, with no reload.
 *
 * Nothing here names a field or a module. The lists are `fields` rows an admin
 * changes in Presets.
 */

/** 'none' is the spec's "irrelevant": on neither list, never glows, never blocks. */
export type Need = 'required' | 'optional' | 'none';

export const NEEDS: readonly Need[] = ['required', 'optional', 'none'];

/** When a field's note is needed, read against the field's value. */
export type NoteWhen = { in?: string[]; not_in?: string[] } | null;

/**
 * Which set of glows a record shows: orange and blue while the application is
 * yet to go, red and purple once it has, nothing once the agreement has gone.
 */
export type GlowStage = 'application' | 'agreement' | 'none';

/** An application in one of these has gone out. Voided or expired takes the record back. */
const APPLICATION_OUT = new Set(['sent', 'opened', 'submitted', 'pdf_uploaded', 'reviewed']);

/**
 * The stage, from the status of the record's most recent application and of its
 * most recent agreement of the kind that sets the stage (null when there is
 * none). Only a voided agreement lets the glows come back; where they come back
 * to is whatever the application says.
 */
export function glowStageFrom(latestApplicationStatus: string | null, latestStageAgreementStatus: string | null): GlowStage {
  if (latestStageAgreementStatus !== null && latestStageAgreementStatus !== 'voided') return 'none';
  return latestApplicationStatus !== null && APPLICATION_OUT.has(latestApplicationStatus) ? 'agreement' : 'application';
}

/**
 * Whether a field's value makes its note needed. Strings and arrays both work,
 * since a dropdown stores one key and a months field stores a list. An array
 * matches when any of its items does. An empty field never matches: there is
 * nothing yet for the note to explain.
 */
export function noteIsNeeded(when: NoteWhen | undefined, value: unknown): boolean {
  if (!when) return false;
  const values = (Array.isArray(value) ? value : [value])
    .filter((v) => v !== null && v !== undefined)
    .map((v) => String(v).trim())
    .filter((v) => v !== '');
  if (!values.length) return false;
  if (when.in) return values.some((v) => when.in!.includes(v));
  if (when.not_in) return values.some((v) => !when.not_in!.includes(v));
  return false;
}
