/** Small display helpers for Chat. Pure. */

export function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0]!.charAt(0) + (parts.length > 1 ? parts[parts.length - 1]!.charAt(0) : '')).toUpperCase();
}

/** Today: the time. This year: the date. Older: with the year. */
export function listTime(iso: string | null, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' });
  return d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: '2-digit' });
}

export function messageTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return time;
  return `${d.toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: '2-digit' }) })} ${time}`;
}

export function fileSize(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const COLORS = ['#2752a3', '#0b6b5d', '#8a5a09', '#7c3aed', '#a12a20', '#0e7490', '#be185d', '#4d7c0f'];
export function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}
