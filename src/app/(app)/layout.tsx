/**
 * Shared chrome for every real (non-prototype) authenticated screen — the
 * sidebar and the frame around it. Every `(app)` route was rendering
 * standalone before this, with no way to get from one module to another
 * except typing the URL. Server Component: the module list and admin status
 * are real, fetched once per request, same as every other real page here.
 */
import { authorize, moduleGrant } from '@/lib/records/permissions';
import { loadConfig } from '@/lib/records/config';
import { moduleRecordCounts, deletedRecordCount } from '@/lib/records/records';
import { getSessionUser } from '@/lib/auth/session';
import { notificationsFor, unreadNotificationCount } from '@/lib/records/notifications';
import { teamDirectory } from '@/lib/records/directory';
import { PeopleProvider } from '@/proto/ui/people';
import { Sidebar } from './Sidebar';
import { PhoneProvider } from './phone/PhoneProvider';
import { CallBar } from './phone/CallBar';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await authorize();
  const config = await loadConfig();
  const user = await getSessionUser();
  // The people directory is fetched HERE, once, for the same reason the module
  // list is: every real screen that draws a person needs it, and none of them
  // are in a position to fetch it — `AvatarStack`, the drawer's team-member
  // picker and the create dialog are all Client Components several levels down.
  // Added to this existing batch rather than awaited separately, so it costs one
  // more round trip in parallel and no extra latency.
  const [notifications, unreadCount, people] = await Promise.all([
    notificationsFor(ctx),
    unreadNotificationCount(ctx),
    teamDirectory(ctx),
  ]);

  // The nav is filtered by the SAME gate the module page itself uses, rather
  // than by `kind`/`adminOnly` alone. `[module]/page.tsx` has always redirected
  // a Hidden module to the dashboard, so this was never a data leak — but it
  // listed every module in the sidebar regardless, and a template that hid four
  // of six left the member looking at all six and bouncing off four of them.
  // Filtering here rather than inside `Sidebar` keeps the check on the server:
  // a hidden module's label and slug never reach the browser at all.
  //
  // `moduleGrant` applies the `adminOnly` floor itself, which is why the old
  // `(ctx.isAdmin || !m.adminOnly)` test on storage modules is gone rather than
  // kept alongside — two places deciding the same thing is how they drift.
  const grants = new Map(
    await Promise.all(
      config.modules.map(async (m) => [m.id, await moduleGrant(ctx, m.id, m.adminOnly)] as const),
    ),
  );
  const visible = config.modules.filter((m) => grants.get(m.id) !== 'hidden');
  const displayModules = visible.filter((m) => m.kind === 'display');
  const storageModules = visible.filter((m) => m.kind === 'storage');
  const [counts, binCount] = await Promise.all([
    moduleRecordCounts([...storageModules, ...displayModules]),
    deletedRecordCount(ctx),
  ]);

  return (
    <PeopleProvider people={people}>
    {/*
      The phone Device is built here, app-wide, because a lazily-created one
      cannot RECEIVE calls — to ring when a merchant calls back it has to exist
      and be registered before anything happens, on every page.

      Everything inside fails silent by design: a Twilio outage, a missing
      environment variable or a user with no assigned number degrades CALLING
      and nothing else. `CallBar` renders null unless a call is actually in
      progress, so the cost on every other page is one null check.
    */}
    <PhoneProvider>
    <div className="flex h-screen overflow-hidden bg-canvas">
      <Sidebar
        storageModules={storageModules}
        displayModules={displayModules}
        counts={counts}
        binCount={binCount}
        userName={user?.name ?? user?.email ?? 'You'}
        userEmail={user?.email ?? ''}
        isAdmin={ctx.isAdmin}
        initialNotifications={notifications}
        initialUnreadCount={unreadCount}
      />
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      <CallBar />
    </div>
    </PhoneProvider>
    </PeopleProvider>
  );
}
