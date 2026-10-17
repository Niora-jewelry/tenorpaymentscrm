/**
 * How long to wait before trying Microsoft again.
 *
 * Three different clocks, kept apart on purpose:
 *   - `retryDelayMs`   — between attempts INSIDE one run (seconds).
 *   - `nextSyncDelayMinutes` — between runs for a mailbox that keeps failing.
 *   - `breakerOpen`    — a mailbox that keeps getting 429s is left alone
 *                        for a while, instead of being retried into a ban.
 *
 * Pure; `random` is injectable so the jitter is testable.
 */

/** Full-jitter exponential backoff: uniform in [0, min(cap, base·2^attempt)]. */
export function retryDelayMs(attempt: number, random: () => number = Math.random, baseMs = 2_000, capMs = 60_000): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.floor(random() * ceiling);
}

/** Minutes until the next sync of a mailbox with `consecutiveErrors` failures in a row. */
export function nextSyncDelayMinutes(consecutiveErrors: number): number {
  const schedule = [1, 2, 4, 8, 16, 30];
  if (consecutiveErrors <= 0) return 0;
  return schedule[Math.min(consecutiveErrors - 1, schedule.length - 1)];
}

/** Five 429s inside ten minutes opens the breaker for fifteen. */
export const BREAKER = { threshold: 5, windowMs: 10 * 60_000, openMs: 15 * 60_000 } as const;

export function breakerOpen(throttleTimestamps: number[], now: number): boolean {
  const recent = throttleTimestamps.filter((t) => now - t <= BREAKER.windowMs);
  if (recent.length < BREAKER.threshold) return false;
  return now - Math.max(...recent) < BREAKER.openMs;
}
