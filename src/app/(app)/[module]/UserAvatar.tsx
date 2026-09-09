/**
 * Real-build equivalent of `src/proto/ui/kit.tsx`'s `Avatar` — same visual
 * design (a colored circle of initials), but sourced from a real user id +
 * display name instead of the prototype's fixed `USER_BY_ID` fixture, so it
 * has no `role`/`hue` fields to depend on. Not `'use client'` — it's a pure
 * presentational function, usable from both server and client components.
 *
 * The hue/initials helpers moved to `@/proto/ui/identity` once `AvatarStack`
 * needed the same two functions to draw a team-member field's real people: one
 * copy, imported by both, rather than the same deterministic colour computed two
 * ways and drifting.
 */
import { hueForId, initialsFor } from '@/proto/ui/identity';

export function UserAvatar({ userId, name, size = 22 }: { userId: string; name: string; size?: number }) {
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white ring-2 ring-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `hsl(${hueForId(userId)} 52% 42%)`,
      }}
    >
      {initialsFor(name)}
    </span>
  );
}
