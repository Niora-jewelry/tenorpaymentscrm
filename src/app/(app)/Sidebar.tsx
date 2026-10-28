'use client';

/**
 * Real primary navigation — same information architecture as the prototype's
 * `Sidebar.tsx` (storage/display grouping, collapse rail, active-item marker),
 * built against real data instead of `useStore()`: there is one real signed-in
 * user here, not a switchable roster of fake viewers, and the module list comes
 * from the database, not an in-memory array.
 *
 * ── THE 2026-09-07 REDESIGN ──────────────────────────────────────────────
 * The brand mark, product name and tagline stay. This is the product's own
 * front door, and the top-left corner is where a person looks to know where
 * they are. What changed is everything around them.
 *
 * The header is its own banded row with a fixed height and a hairline under it,
 * so the identity reads as a header rather than as the first item in the
 * navigation list. The mark keeps its gradient, because that is the brand, but
 * gains an inner highlight and a soft shadow so it reads as a raised object
 * rather than a flat swatch, and it drops a size so the eye lands on the name
 * rather than on the box.
 *
 * The collapse control moved OUT of the footer and onto the panel's own edge.
 * It used to be a full-width labelled row directly under the navigation, which
 * gave a control used once a week the same weight as a module, and put it
 * exactly where a mis-aimed click on the last nav item lands. Sign out had the
 * same problem and is now an icon on the account row it belongs to.
 *
 * The rest is rhythm and hierarchy rather than decoration: one consistent
 * indent, section labels that separate without shouting, an active state that
 * reads at a glance, and counts that sit quietly on the right.
 *
 * ── THE DARK RAIL ────────────────────────────────────────────────────────
 * The panel carries the brand gradient rather than white. Two things follow
 * from that, and both are deliberate:
 *
 * ⚠️ EVERY COLOUR IN HERE IS NOW WHITE-WITH-ALPHA, NOT AN INK TOKEN. `ink-400`
 * on `#1d4ed8` is 1.9:1 and effectively invisible. Alpha over the gradient
 * keeps one hue and lets the gradient show through, which a flat opaque tint
 * would kill. Anything added to this file has to follow the same rule.
 *
 * The surface is `rail-glass`, carrying the same petrol gradient as TapSync so
 * the two products read as one company — and closer to this app's own
 * `brand-950` than the blue-violet ramp that had drifted in. `globals.css`
 * carries the full reasoning.
 *
 * ── THE TYPOGRAPHIC LADDER, DIMMEST TO BRIGHTEST ─────────────────────────
 * Everything in here is white-with-alpha, so hierarchy is carried entirely by
 * how much of it there is. Four steps, and they are deliberate:
 *
 *     45%   group labels, counts       — present, never read on purpose
 *     55%   the tagline, the email     — supporting detail
 *     72%   resting item labels        — the list itself
 *    100%   hover, and the wordmark    — what you are pointing at
 *
 * The active row leaves the ladder entirely: dark ink on lime. That is the
 * point of an accent, and it is why there is only one of them.
 *
 * THE ACTIVE ITEM IS THE LIME. `globals.css` says lime is only ever a fill
 * carrying dark text, or text on a dark ground — a navy rail is exactly that
 * ground, and lime on it is 14.8:1. It also breaks the "one accent per screen"
 * habit on purpose: the other lime is the primary button, which lives on the
 * white canvas. They are in different planes and read as "where you are" and
 * "the thing to do", never as two competing calls to action.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, MODULE_ICON, type IconName } from '@/proto/ui/icons';
import { logoutAction } from '@/app/(auth)/actions';
import type { Module } from '@/lib/records/config';
import type { UnreadCounts } from '@/lib/records/notifications';
import { useLiveCounts } from './useLiveCounts';

/** The identity in the sidebar header. Two constants, one place to change them
 *  for a rebrand or a white-label deployment. */
const BRAND_NAME = 'TapDash';
const BRAND_TAGLINE = 'Merchant services CRM';

/**
 * The Configure group, in its long-standing order: Users and Permissions
 * together (who a user is, and what they may see), then Presets, then the two
 * things an admin operates (Phone numbers, Residuals admin), then the status
 * pages, then the Recycle bin. "Permissions" is the user's word for the
 * template screen; "Residuals admin", because the Residuals MODULE owns the
 * plain name.
 */
const CONFIGURE_ITEMS: { page: string; href: string; icon: IconName; label: string; exact?: boolean }[] = [
  { page: 'users', href: '/admin/users', icon: 'users', label: 'Users', exact: true },
  { page: 'permissions', href: '/admin/templates', icon: 'key', label: 'Permissions' },
  { page: 'presets', href: '/admin/presets', icon: 'sliders', label: 'Presets', exact: true },
  { page: 'numbers', href: '/admin/numbers', icon: 'phone', label: 'Phone numbers', exact: true },
  { page: 'residuals', href: '/admin/residuals', icon: 'percent', label: 'Residuals admin' },
  { page: 'integrations', href: '/admin/integrations', icon: 'link', label: 'Integrations', exact: true },
  { page: 'automations', href: '/admin/automations', icon: 'route', label: 'Automations', exact: true },
  { page: 'recycle_bin', href: '/admin/recycle-bin', icon: 'trash', label: 'Recycle bin', exact: true },
];

export function Sidebar({
  storageModules,
  displayModules,
  counts,
  binCount,
  userName,
  userEmail,
  adminPages = [],
  userId,
  initialCounts,
  emailUnread,
}: {
  /** Admin pages this person has Full access to (Permissions spec). */
  adminPages?: string[];
  storageModules: Module[];
  displayModules: Module[];
  counts: Record<string, number>;
  binCount: number;
  userName: string;
  userEmail: string;
  /** For the live-count subscription: a person only ever receives their own rows. */
  userId: string;
  initialCounts: UnreadCounts;
  /** null = Email is not available to this person (no nav item at all). */
  emailUnread: number | null;
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Starts from the server's count; the Email page's polls keep it current
  // while it is open (`tapdash:email-unread`).
  const [mailUnread, setMailUnread] = useState(emailUnread ?? 0);
  // Mentions and phone alerts: pushed by the database the moment one lands,
  // polled as a fallback — see `useLiveCounts`.
  const alerts = useLiveCounts(userId, initialCounts);
  useEffect(() => {
    const on = (e: Event) => {
      const n = (e as CustomEvent<number>).detail;
      if (typeof n === 'number' && Number.isFinite(n)) setMailUnread(n);
    };
    window.addEventListener('tapdash:email-unread', on);
    return () => window.removeEventListener('tapdash:email-unread', on);
  }, []);
  const pathname = usePathname();
  const initial = (userName.trim().charAt(0) || '?').toUpperCase();

  return (
    /*
     * ⚠️ `z-40`, and the number matters.
     *
     * THE LAYERS, bottom to top:
     *    10  table cells (the frozen first column)
     *    20  column headers
     *    30  the sticky header row and its corner cell
     *    40  THIS PANEL
     *    60  the record drawer's sheet and backdrop
     *    80  dialogs and popovers
     *
     * `relative z-N` makes this element a STACKING CONTEXT, so everything
     * inside it — including the notification panel's own `z-50` — is confined
     * to this number when compared against anything outside. At `z-20` the
     * dashboard's sticky header (`z-30`, a sibling at the root level) painted
     * straight over the open notification panel: the panel is 320px wide and
     * the sidebar is 244px, so the part that overhung the table simply
     * disappeared behind the column headers.
     *
     * Raising the panel's own z-index could never have fixed that — a child
     * cannot escape its parent's stacking context. The container is what has
     * to win, which is why this is 40 and not 20.
     */
    <aside
      className={`group/sidebar rail-glass relative z-40 flex shrink-0 flex-col border-r border-brand-950/50 text-white transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        collapsed ? 'w-[64px]' : 'w-[244px]'
      }`}
    >
      {/* ── Brand ───────────────────────────────────────────────────────────
          A banded row with its own height and a hairline under it, so the
          identity reads as a header rather than as the first thing in the
          navigation list. */}
      <div
        className={`rail-band flex h-[58px] shrink-0 items-center gap-2.5 border-b border-white/10 px-3 ${
          collapsed ? 'justify-center' : ''
        }`}
      >
        {/* The mark. An inset highlight plus a soft shadow give the gradient a
            top edge, so it reads as a raised object instead of a flat swatch.
            It is the one piece of ornament on the whole panel, which is exactly
            why it can afford to be there. */}
        <span
          aria-hidden
          className="grid size-[30px] shrink-0 place-items-center rounded-[9px] bg-white/[.14] text-[13px] font-bold text-white ring-1 ring-inset ring-white/30 shadow-[inset_0_1px_0_rgba(255,255,255,.40),0_2px_8px_-3px_rgba(0,0,0,.5)]"
        >
          {BRAND_NAME.charAt(0)}
        </span>

        {!collapsed ? (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold leading-tight tracking-[-.01em] text-white">
                {BRAND_NAME}
              </span>
              {/* Sentence case, no letter-spacing. Uppercase plus .07em
                  tracking made this ~30% wider than the panel could give it, so
                  it truncated to "MERCHANT SERVICES C…" — a tagline that gets
                  cut off is worse than no tagline. */}
              <span className="block truncate text-[11px] leading-[1.35] text-white/55">
                {BRAND_TAGLINE}
              </span>
            </span>
          </>
        ) : null}
      </div>

      {/* ── Collapse ────────────────────────────────────────────────────────
          On the panel's own edge, straddling the border it moves. Costs no room
          inside the panel, and sits where this control now lives in every dense
          application UI. Revealed on hover so it is not permanently on screen,
          and on keyboard focus so it is not mouse-only. */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
        aria-expanded={!collapsed}
        className={`absolute -right-[11px] top-[72px] z-30 grid size-[22px] place-items-center rounded-full border border-white/20 bg-[#06314d] text-white/70 shadow-[0_2px_8px_-2px_rgba(1,20,40,.7)] transition-[opacity,color,border-color,background-color] duration-150 hover:border-accent/60 hover:bg-[#024774] hover:text-accent focus-visible:opacity-100 group-hover/sidebar:opacity-100 ${
          /* ALWAYS visible while collapsed. Hover-reveal is right when the panel
             is open and its labels already say what everything is — but a
             collapsed rail whose only way back is an invisible button is a dead
             end for anyone who does not think to hover the edge. */
          collapsed ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={13} strokeWidth={2.2} />
      </button>

      <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 py-2">
        {storageModules.length ? (
          <>
            <GroupLabel collapsed={collapsed}>Storage</GroupLabel>
            {storageModules.map((m) => (
              <NavItem
                key={m.slug}
                href={`/${m.slug}`}
                icon={MODULE_ICON[m.slug] ?? 'database'}
                label={m.label}
                count={counts[m.slug]}
                active={pathname === `/${m.slug}`}
                collapsed={collapsed}
              />
            ))}
          </>
        ) : null}

        {displayModules.length ? (
          <>
            <GroupLabel collapsed={collapsed}>Modules</GroupLabel>
            {displayModules.map((m) => (
              <NavItem
                key={m.slug}
                href={`/${m.slug}`}
                icon={MODULE_ICON[m.slug] ?? 'briefcase'}
                label={m.label}
                count={counts[m.slug]}
                active={pathname === `/${m.slug}`}
                collapsed={collapsed}
              />
            ))}
          </>
        ) : null}

        {/*
          Phone is not a module — it has no records — so it sits on its own
          rather than in the Modules group. Shown to everyone: the page itself
          redirects anyone whose `communication/phone` grant is hidden, and
          hiding the link as well would leave someone who HAS the grant unable
          to find it after an admin turns it on.
        */}
        {/*
          Email, like Phone, is not a module. Unlike Phone it is listed only
          when this person may use it: the module can be switched off
          entirely, and a link that always bounces would be noise.
        */}
        {/* Every @mention this person received, newest first — and the live
            count the client asked for. Replaces the bell that used to sit in
            the brand row. */}
        <NavItem
          href="/notifications"
          icon="bell"
          label="Notifications"
          count={alerts.mentions > 0 ? alerts.mentions : undefined}
          active={pathname === '/notifications'}
          collapsed={collapsed}
        />
        {emailUnread !== null ? (
          <NavItem
            href="/email"
            icon="mail"
            label="Email"
            count={mailUnread > 0 ? mailUnread : undefined}
            active={pathname === '/email' || pathname.startsWith('/email/')}
            collapsed={collapsed}
          />
        ) : null}
        {/* Missed calls, voicemails and recordings not yet looked at. The bell
            used to carry these; opening the Phone page clears them. */}
        <NavItem
          href="/phone"
          icon="phone"
          label="Phone"
          count={alerts.phone > 0 ? alerts.phone : undefined}
          active={pathname === '/phone'}
          collapsed={collapsed}
        />

        {/*
          Configure: each admin page appears for whoever has Full access to it
          (Permissions spec — "Each page is set separately"); the group label
          only when at least one does. Email settings is no longer here: it is
          the Email module's own gear, for everyone (spec: "Moving Email
          settings into the Email module").
        */}
        {adminPages.length ? (
          <>
            <GroupLabel collapsed={collapsed}>Configure</GroupLabel>
            {CONFIGURE_ITEMS.filter((it) => adminPages.includes(it.page)).map((it) => (
              <NavItem
                key={it.page}
                href={it.href}
                icon={it.icon}
                label={it.label}
                count={it.page === 'recycle_bin' ? binCount || undefined : undefined}
                active={it.exact ? pathname === it.href : pathname.startsWith(it.href)}
                collapsed={collapsed}
              />
            ))}
          </>
        ) : null}
      </nav>

      {/* ── Account ───────────────────────────────────────────────────────
          The identity and its one destructive action on a single row. Sign out
          was a full-width labelled button, which gave a rarely-used action the
          same visual weight as a module — and put it directly under the nav
          list where a mis-aimed click lands. */}
      <div className="rail-band shrink-0 border-t border-white/10 p-2">
        <div
          className={`flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 ${collapsed ? 'justify-center' : ''}`}
          title={collapsed ? `${userName} · ${userEmail}` : undefined}
        >
          <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-[11.5px] font-bold text-accent-ink shadow-[0_2px_8px_-3px_rgba(213,255,74,.6)]">
            {initial}
          </span>
          {!collapsed ? (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-semibold leading-tight text-white">
                  {userName}
                </span>
                {/* Only when it adds something. `userName` falls back to the
                    address when there is no display name, and printing it twice
                    was the sidebar's least useful line. */}
                {userEmail && userEmail !== userName ? (
                  <span className="block truncate text-[11px] leading-tight text-white/55">{userEmail}</span>
                ) : null}
              </span>
              <form action={logoutAction} className="shrink-0">
                <button
                  type="submit"
                  title="Sign out"
                  aria-label="Sign out"
                  className="grid size-7 place-items-center rounded-md text-white/55 transition-colors hover:bg-white/10 hover:text-white"
                >
                  <Icon name="external-link" size={15} />
                </button>
              </form>
            </>
          ) : null}
        </div>

        {collapsed ? (
          <form action={logoutAction}>
            <button
              type="submit"
              title="Sign out"
              aria-label="Sign out"
              className="mt-1 grid h-8 w-full place-items-center rounded-lg text-white/55 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Icon name="external-link" size={15} />
            </button>
          </form>
        ) : null}
      </div>
    </aside>
  );
}

function GroupLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  // Collapsed, a hairline does the same job the words did: it separates the
  // groups without needing a width the rail does not have.
  if (collapsed) return <div aria-hidden className="mx-auto my-2.5 h-px w-5 bg-white/20" />;
  return (
    <p className="px-2.5 pb-1.5 pt-5 text-[9.5px] font-semibold uppercase tracking-[.14em] text-white/40 first:pt-1.5">
      {children}
    </p>
  );
}

function NavItem({
  href,
  icon,
  label,
  count,
  active,
  collapsed,
}: {
  href: string;
  icon: IconName;
  label: string;
  count?: number;
  active: boolean;
  collapsed: boolean;
}) {
  return (
    <Link
      href={href}
      title={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      className={`group relative mb-px flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[13px] font-medium transition-[background-color,color] duration-150 ${
        active
          ? 'rail-active'
          : 'text-white/72 hover:bg-white/[.09] hover:text-white hover:shadow-[inset_0_1px_0_rgba(255,255,255,.09)]'
      } ${collapsed ? 'justify-center' : ''}`}
    >
      {/* No colour of its own on an active row: the pill sets `accent-ink` and
          the icon inherits it. A lime icon on a lime fill is invisible, which is
          what the edge-marker version needed it to be and this one does not. */}
      <Icon
        name={icon}
        size={16}
        strokeWidth={active ? 2.1 : 1.75}
        className={`shrink-0 transition-transform duration-150 ${
          active ? '' : 'group-hover:translate-x-px'
        }`}
      />
      {!collapsed ? (
        <>
          <span className="flex-1 truncate">{label}</span>
          {count != null ? (
            /* The count rides the row's own colour rather than carrying its
               own. On the lime pill it is the dark ink at reduced weight; on a
               resting row it is the same white, dimmer. Either way it never
               competes with the label beside it. */
            <span
              className={`w-7 shrink-0 text-right text-[11.5px] tabular ${
                active ? 'font-semibold text-accent-ink/70' : 'text-white/45'
              }`}
            >
              {count > 99 ? '99+' : count}
            </span>
          ) : null}
        </>
      ) : null}
    </Link>
  );
}
