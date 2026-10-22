/**
 * PROTOTYPE — the 12 fixed Status swatches.
 *
 * Admins pick a Status colour from THIS list, never from a colour picker.
 * Every triple is checked to read on white. The point of a fixed set is that
 * nobody can create a red that means "good", or a yellow nobody can read.
 */
import type { Swatch } from '../schema';

export type SwatchStyle = { bg: string; text: string; border: string; dot: string };

export const SWATCHES: Record<Swatch, SwatchStyle> = {
  slate: { bg: '#eef2f6', text: '#46596b', border: '#d5dfe8', dot: '#7b8fa1' },
  blue: { bg: '#e3edfd', text: '#1d4ed8', border: '#c7dcfb', dot: '#2563eb' },
  indigo: { bg: '#e8e7fd', text: '#4338ca', border: '#d3d1fa', dot: '#4f46e5' },
  teal: { bg: '#e0f5f1', text: '#0b7466', border: '#c2e9e1', dot: '#0f9c8b' },
  green: { bg: '#e3f6e8', text: '#1a7a3c', border: '#c5ecd0', dot: '#22a04f' },
  lime: { bg: '#eefac9', text: '#46660a', border: '#dcf29a', dot: '#7fa30f' },
  amber: { bg: '#fdf1d8', text: '#8a5a09', border: '#f7e0af', dot: '#c07714' },
  orange: { bg: '#fdeadd', text: '#9a4a12', border: '#fad4bb', dot: '#d1651c' },
  red: { bg: '#fce9ea', text: '#b02a30', border: '#f7cfd1', dot: '#d33b41' },
  pink: { bg: '#fce8f0', text: '#a92a63', border: '#f8cede', dot: '#d3428a' },
  purple: { bg: '#f2e9fb', text: '#6b28ac', border: '#e6d5f7', dot: '#8b3fd0' },
  brown: { bg: '#f2ece5', text: '#6d5340', border: '#e4d8c9', dot: '#96775c' },
};

export const SWATCH_NAMES = Object.keys(SWATCHES) as Swatch[];

/** Fallback for a choice with no swatch assigned. */
export const NEUTRAL: SwatchStyle = SWATCHES.slate;

/* -------------------------------------------------------------------------- */
/* Value formatting — one place, so a currency looks the same everywhere       */
/* -------------------------------------------------------------------------- */

const USD = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});
const USD0 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

export function formatCurrency(n: number): string {
  // Whole dollars for volumes, cents for per-transaction fees.
  return Number.isInteger(n) && Math.abs(n) >= 100 ? USD0.format(n) : USD.format(n);
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function formatDate(iso: string): string {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(iso)} · ${hh}:${mm}`;
}

/** "3 hours ago" — for feeds, where the exact minute is noise. */
export function relative(iso: string, now: Date): string {
  const diff = now.getTime() - new Date(iso).getTime();
  const mins = Math.round(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function monthLabel(period: string): string {
  const [y, m] = period.split('-');
  return `${MONTHS[Number(m) - 1]} ${y}`;
}

export const MONTH_NAMES = MONTHS;

/**
 * "Not seasonal" for a `months` field. Stored in the same array as the
 * months (`['No']`), so every reader — chips, filters, exports — keeps
 * working unchanged; the editor keeps it exclusive. Asked for by the client
 * on 22 Oct 2026: an empty Seasonal could not tell "not seasonal" from "not
 * filled in".
 */
export const MONTHS_NONE = 'No';

/** One click on a chip in the months editor: `No` clears the months, a month clears `No`. */
export function toggleMonth(current: readonly string[], pick: string): string[] {
  const on = current.includes(pick);
  if (pick === MONTHS_NONE) return on ? [] : [MONTHS_NONE];
  const months = current.filter((m) => m !== MONTHS_NONE);
  return on ? months.filter((m) => m !== pick) : [...months, pick];
}
