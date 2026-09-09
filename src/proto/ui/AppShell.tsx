'use client';

/**
 * PROTOTYPE — the application shell.
 *
 * Sidebar on the left for navigation and identity; a slim top bar for where you
 * are and what has happened. The top bar deliberately holds nothing you need to
 * navigate with — that all lives in the sidebar — so it can stay 52px tall and
 * give the table its vertical room back.
 */
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { NOTIFICATIONS } from '../data';
import { moduleBySlug } from '../modules';
import { useStore } from '../store';
import { Icon } from './icons';
import { Popover } from './kit';
import { Sidebar } from './Sidebar';
import { relative } from './tokens';

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas">
      <PrototypeBanner />
      <div className="flex min-h-0 flex-1">
        <Suspense fallback={<div className="w-[236px] shrink-0 border-r border-line bg-white" />}>
          <Sidebar />
        </Suspense>
        <div className="flex min-w-0 flex-1 flex-col">
          <Suspense fallback={<div className="h-[52px] shrink-0 border-b border-line bg-white" />}>
            <TopBar />
          </Suspense>
          <main className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</main>
        </div>
      </div>
    </div>
  );
}

/** Never let anyone mistake this for live data. */
function PrototypeBanner() {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-brand-950 px-4 py-1.5 text-center text-[12px] text-white/75">
      <span className="inline-flex items-center gap-1.5 font-semibold text-accent">
        <Icon name="info" size={12} strokeWidth={2} />
        Prototype
      </span>
      <span>Sample data only — nothing is saved, and no database is connected.</span>
      <Link
        href="/prototype"
        className="font-semibold text-white underline decoration-white/40 underline-offset-2 hover:decoration-white"
      >
        What am I looking at?
      </Link>
    </div>
  );
}

function TopBar() {
  const { now, viewer } = useStore();
  const pathname = usePathname();
  const search = useSearchParams();
  const unread = NOTIFICATIONS.filter((n) => !n.read).length;

  const slug = pathname.split('/')[2];
  const mod = slug ? moduleBySlug(slug) : undefined;
  const adminTab = search.get('tab') ?? 'Presets';

  const crumbs: string[] =
    pathname === '/prototype'
      ? ['Overview']
      : slug === 'admin'
        ? ['Admin', adminTab]
        : mod
          ? [mod.kind === 'storage' ? 'Storage' : 'Display modules', mod.label]
          : ['Not found'];

  return (
    <header className="flex h-[52px] shrink-0 items-center gap-3 border-b border-line bg-white px-4">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
        {crumbs.map((c, i) => (
          <span key={c} className="flex min-w-0 items-center gap-1.5">
            {i > 0 ? (
              <Icon name="chevron-right" size={13} className="shrink-0 text-ink-400/60" />
            ) : null}
            <span
              className={`truncate text-[13.5px] ${
                i === crumbs.length - 1 ? 'font-semibold text-ink-900' : 'text-ink-400'
              }`}
            >
              {c}
            </span>
          </span>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {/* Search is explicitly out of scope for v1 — shown disabled rather than
            omitted, so its absence is a decision on screen instead of a gap. */}
        <label
          title="Module and global search are on the deferred register — not built in v1"
          className="hidden items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-ink-400 md:flex"
        >
          <Icon name="search" size={14} />
          <input
            disabled
            placeholder="Search — deferred to a later phase"
            className="w-[210px] cursor-not-allowed bg-transparent text-[12.5px] outline-none placeholder:text-ink-400/70"
          />
        </label>

        <Popover
          align="right"
          width={330}
          trigger={() => (
            <span className="relative grid size-8 place-items-center rounded-lg text-ink-500 transition-colors hover:bg-canvas hover:text-ink-900">
              <Icon name="bell" size={17} />
              {unread ? (
                <span className="absolute right-0.5 top-0.5 grid min-w-[15px] place-items-center rounded-full bg-accent px-1 text-[10px] font-bold leading-[15px] text-accent-ink">
                  {unread}
                </span>
              ) : null}
            </span>
          )}
        >
          {() => (
            <div>
              <p className="px-2 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
                Notifications
              </p>
              <ul className="max-h-72 space-y-px overflow-y-auto">
                {NOTIFICATIONS.map((n) => (
                  <li
                    key={n.id}
                    className={`flex gap-2 rounded-md px-2 py-2 text-[13px] transition-colors hover:bg-canvas ${
                      n.read ? 'text-ink-400' : 'text-ink-700'
                    }`}
                  >
                    <span className="mt-1.5 shrink-0">
                      {!n.read ? (
                        <span className="block size-1.5 rounded-full bg-brand-600" />
                      ) : (
                        <span className="block size-1.5" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      {n.body}
                      <span className="ml-1 text-[11.5px] text-ink-400">{relative(n.at, now)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-line px-2 pt-2 text-[11.5px] leading-relaxed text-ink-400">
                @mentions in Updates seed these. The notification primitive is generic — recipient,
                source, read state — not Updates-specific.
              </p>
            </div>
          )}
        </Popover>

        <span
          title={`Row visibility: ${viewer.ownRecordsOnly ? 'own records only' : 'all records'}`}
          className="hidden items-center gap-1.5 rounded-full border border-line bg-canvas px-2.5 py-1 text-[11.5px] font-semibold text-ink-500 lg:inline-flex"
        >
          <Icon name={viewer.isAdmin ? 'key' : 'user'} size={12} />
          {viewer.label}
        </span>
      </div>
    </header>
  );
}
