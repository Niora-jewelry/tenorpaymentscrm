/**
 * Is the engine behind? Everything an automation does after its first click
 * moves on the one-minute tick, and a tick that stops says nothing: on 4 and 5
 * Nov 2026 the cron was down for twenty hours, and all anyone could see was
 * "Last run: Never". So the pages count what should have moved by now.
 *
 * Five minutes, so one slow or missed tick never raises the alarm.
 */
export const BEHIND_AFTER_MS = 5 * 60_000;

export type Backlog = { count: number; since: string };

type Late = { count: number; oldest: string | null };

/** What is overdue, or null when nothing is. */
export function backlogOf(queued: Late, waits: Late): Backlog | null {
  const count = queued.count + waits.count;
  const dates = [queued.oldest, waits.oldest].filter((d): d is string => Boolean(d)).sort((a, b) => Date.parse(a) - Date.parse(b));
  return count > 0 && dates[0] ? { count, since: dates[0] } : null;
}
