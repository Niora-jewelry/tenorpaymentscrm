/**
 * How the mail list talks about time: the group a conversation falls under
 * ("Today", "Yesterday", "Tuesday", "Last week" …) and the short stamp on
 * its row. Local time, Monday-start weeks, 24-hour clock — the same clock
 * the rest of the CRM shows.
 *
 * Pure (the "now" is passed in), unit-tested.
 */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const SHORT = MONTHS.map((m) => m.slice(0, 3));

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const startOfWeek = (d: Date) => {
  const s = startOfDay(d);
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
};
const pad = (n: number) => String(n).padStart(2, '0');

export function dateGroup(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Older';
  const today = startOfDay(now);
  const day = startOfDay(d);
  const diffDays = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  const thisWeek = startOfWeek(now);
  if (day >= thisWeek) return DAYS[d.getDay()];
  const lastWeek = new Date(thisWeek);
  lastWeek.setDate(lastWeek.getDate() - 7);
  if (day >= lastWeek) return 'Last week';
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()) return 'Earlier this month';
  return d.getFullYear() === now.getFullYear() ? MONTHS[d.getMonth()] : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** The stamp on a row: "10:42" today, "Tue 10:42" this week, "12 Oct", "12 Oct 2025". */
export function rowStamp(iso: string, now: Date): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const day = startOfDay(d);
  if (day.getTime() === startOfDay(now).getTime()) return time;
  if (day >= startOfWeek(now) && day < startOfDay(now)) return `${DAYS[d.getDay()].slice(0, 3)} ${time}`;
  if (d.getFullYear() === now.getFullYear()) return `${d.getDate()} ${SHORT[d.getMonth()]}`;
  return `${d.getDate()} ${SHORT[d.getMonth()]} ${d.getFullYear()}`;
}

/** The full stamp in a message header: "Mon 19 Oct 2026, 10:42". */
export function fullStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${DAYS[d.getDay()].slice(0, 3)} ${d.getDate()} ${SHORT[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** "84 KB", "2.4 MB". */
export function fileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
