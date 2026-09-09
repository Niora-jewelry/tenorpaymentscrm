/**
 * Uniform response timing.
 *
 * The spec makes login and password reset deliberately neutral: they must never
 * reveal whether an email has an account. A generic MESSAGE alone does not
 * achieve that — if "no such user" returns in 20ms while "wrong password" takes
 * 200ms, the delay itself answers the question.
 *
 * Every neutral path is therefore held to a fixed floor, so the response time
 * carries no signal.
 */
import 'server-only';

/** Comfortably above a real Supabase verify round trip. */
export const NEUTRAL_RESPONSE_FLOOR_MS = 450;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `work` and does not resolve before `floorMs` has elapsed.
 * Rejections are held to the floor too — an error path that returns instantly
 * is its own side channel.
 */
export async function withMinimumDuration<T>(
  work: () => Promise<T>,
  floorMs: number = NEUTRAL_RESPONSE_FLOOR_MS,
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    const remaining = floorMs - (Date.now() - started);
    if (remaining > 0) await sleep(remaining);
  }
}
