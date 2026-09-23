/**
 * "You are not you right now."
 *
 * ── WHY IT IS THIS LOUD ──────────────────────────────────────────────────
 * While impersonating, actions really are performed BY the target — anything
 * written carries their id. The single worst outcome of this feature is an
 * admin forgetting they are someone else and doing real work as them, so the
 * banner is a full-width bar at the very top of every page, in a colour used
 * nowhere else in the app, and it cannot be dismissed. Getting out is the only
 * button on it.
 *
 * ── IT SAYS WHOSE ACCOUNT, NOT JUST "IMPERSONATING" ──────────────────────
 * The admin is usually testing several people in a row. A bar that only says
 * "you are impersonating" answers the wrong question; the one that matters is
 * WHICH person, because that is what tells them whether the screen in front of
 * them is the one they meant to check.
 *
 * Rendered from the layout, above everything, so no page can cover it.
 */
import { currentImpersonation } from '@/lib/auth/impersonation';
import { StopImpersonating } from './StopImpersonating';

export async function ImpersonationBanner() {
  const state = await currentImpersonation();
  if (!state) return null;

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1.5 bg-warn px-4 py-2 text-white"
    >
      <span className="text-[13px] font-semibold">
        Signed in as {state.targetEmail}
      </span>
      <span className="text-[12.5px] text-white/85">
        You are seeing exactly what they see. Anything you change is recorded as them.
      </span>
      <span className="ml-auto flex items-center gap-2">
        <span className="hidden text-[12px] text-white/70 sm:inline">
          Your account: {state.adminEmail}
        </span>
        <StopImpersonating />
      </span>
    </div>
  );
}
