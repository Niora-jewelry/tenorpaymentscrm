import { FLAG_CODES, type Flag, type FlagColor } from '../types';

type Section = keyof typeof FLAG_CODES;

/** A flag whose colour always comes from FLAG_CODES. */
export function flag<S extends Section>(
  section: S,
  code: keyof (typeof FLAG_CODES)[S] & string,
  message: string,
  field?: string,
): Flag {
  const color = (FLAG_CODES[section] as Record<string, FlagColor | null>)[code];
  return field === undefined ? { code, color, message } : { code, color, message, field };
}

const PRIORITY: FlagColor[] = ['red', 'orange', 'light_red', 'light_green', 'green'];

/** The colour a row shows: the highest-priority colour among its flags. */
export function rowColor(flags: Flag[]): FlagColor | null {
  for (const c of PRIORITY) if (flags.some((f) => f.color === c)) return c;
  return null;
}
