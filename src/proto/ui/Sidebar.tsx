'use client';

/**
 * PROTOTYPE — the primary navigation.
 *
 * A sidebar rather than a top bar, for three reasons that only became clear
 * once there was something to navigate:
 *
 *   1. The modules are not a flat list. The Records List is the store and the
 *      other five are projections of it — a hierarchy a row of equal tabs
 *      actively hides. Here it is a labelled group of its own.
 *   2. Admin has five sub-screens. In a top bar they had nowhere to live except
 *      inside the page; here they are addressable from anywhere.
 *   3. The spec says new modules get added over time. A sidebar takes a
 *      seventh and an eighth without rearranging; a top bar starts eating the
 *      account menu.
 *
 * The cost — horizontal room on a 26-column table — is paid off by the collapse
 * toggle: 236px of labels drops to a 60px icon rail without leaving the page.
 */
import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { MODULES } from '../modules';
import { useStore } from '../store';
import { Icon, MODULE_ICON, type IconName } from './icons';
import { USER_BY_ID } from '../data';
import { Avatar, Popover } from './kit';
import { VIEWERS } from '../store';

const ADMIN_TABS: { id: string; label: string; icon: IconName }[] = [
  { id: 'Users', label: 'Users', icon: 'users' },
  { id: 'Presets', label: 'Presets', icon: 'sliders' },
  { id: 'Integrations', label: 'Integrations', icon: 'link' },
  { id: 'Automations', label: 'Automations', icon: 'route' },
  { id: 'Recycle bin', label: 'Recycle bin', icon: 'trash' },
];

export function Sidebar() {
  const { visibleModules, viewer, setViewerId, navCollapsed, toggleNav, rowsFor, records } =
    useStore();
  const pathname = usePathname();
  const search = useSearchParams();
  const collapsed = navCollapsed;

  const onAdmin = pathname.startsWith('/prototype/admin');
  const [adminOpen, setAdminOpen] = useState(true);
  const activeAdminTab = search.get('tab') ?? 'Presets';

  const storage = visibleModules.filter((m) => m.kind === 'storage');
  const display = visibleModules.filter((m) => m.kind === 'display');

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const m of MODULES) out[m.slug] = rowsFor(m.slug).length;
    return out;
  }, [rowsFor]);

  const user = USER_BY_ID.get(viewer.userId)!;
  const binCount = records.filter((r) => r.deleted).length;

  return (
    <aside
      className={`relative z-20 flex shrink-0 flex-col border-r border-line bg-white transition-[width] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] ${
        collapsed ? 'w-[60px]' : 'w-[236px]'
      }`}
    >
      {/* ---------------- brand ---------------- */}
      <div className={`flex items-center gap-2.5 px-3 py-3 ${collapsed ? 'justify-center' : ''}`}>
        <Link
          href="/prototype"
          title="TapDash CRM — overview"
          className="brand-gradient grid size-8 shrink-0 place-items-center rounded-lg text-[14px] font-bold text-white shadow-[0_1px_3px_rgba(8,32,47,.2)]"
        >
          T
        </Link>
        {!collapsed ? (
          <Link href="/prototype" className="min-w-0 flex-1">
            <span className="block truncate text-[14.5px] font-semibold leading-tight tracking-[-.01em] text-ink-900">
              TapDash
            </span>
            <span className="block truncate text-[11px] leading-tight text-ink-400">
              Merchant services CRM
            </span>
          </Link>
        ) : null}
      </div>

      {/* ---------------- nav ---------------- */}
      <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2 pb-2">
        <NavItem
          href="/prototype"
          icon="layout-list"
          label="Overview"
          active={pathname === '/prototype'}
          collapsed={collapsed}
        />

        {storage.length ? (
          <>
            <GroupLabel collapsed={collapsed}>Storage</GroupLabel>
            {storage.map((m) => (
              <NavItem
                key={m.slug}
                href={`/prototype/${m.slug}`}
                icon={MODULE_ICON[m.slug] ?? 'database'}
                label={m.label}
                count={counts[m.slug]}
                active={pathname === `/prototype/${m.slug}`}
                collapsed={collapsed}
              />
            ))}
          </>
        ) : null}

        {display.length ? (
          <>
            <GroupLabel collapsed={collapsed}>Display modules</GroupLabel>
            {display.map((m) => (
              <NavItem
                key={m.slug}
                href={`/prototype/${m.slug}`}
                icon={MODULE_ICON[m.slug] ?? 'briefcase'}
                label={m.label}
                count={counts[m.slug]}
                active={pathname === `/prototype/${m.slug}`}
                collapsed={collapsed}
              />
            ))}
          </>
        ) : null}

        {viewer.isAdmin ? (
          <>
            <GroupLabel collapsed={collapsed}>Configure</GroupLabel>
            {collapsed ? (
              <NavItem
                href="/prototype/admin"
                icon="cog"
                label="Admin"
                active={onAdmin}
                collapsed
              />
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setAdminOpen((o) => !o)}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors duration-150 ${
                    onAdmin ? 'text-brand-700' : 'text-ink-500 hover:bg-canvas hover:text-ink-900'
                  }`}
                >
                  <Icon name="cog" size={16} />
                  <span className="flex-1 text-left">Admin</span>
                  <Icon
                    name="chevron-down"
                    size={13}
                    className={`transition-transform duration-200 ${adminOpen ? '' : '-rotate-90'}`}
                  />
                </button>

                {adminOpen ? (
                  <div className="ml-[19px] border-l border-line pl-2">
                    {ADMIN_TABS.map((t) => {
                      const active = onAdmin && activeAdminTab === t.id;
                      return (
                        <Link
                          key={t.id}
                          href={`/prototype/admin?tab=${encodeURIComponent(t.id)}`}
                          className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] transition-colors duration-150 ${
                            active
                              ? 'bg-brand-50 font-semibold text-brand-700'
                              : 'text-ink-500 hover:bg-canvas hover:text-ink-900'
                          }`}
                        >
                          <Icon name={t.icon} size={14} className="opacity-70" />
                          <span className="flex-1 truncate">{t.label}</span>
                          {t.id === 'Recycle bin' && binCount ? (
                            <span className="rounded-full bg-canvas px-1.5 text-[11px] font-semibold text-ink-400 tabular">
                              {binCount}
                            </span>
                          ) : null}
                        </Link>
                      );
                    })}
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : null}
      </nav>

      {/* ---------------- footer ---------------- */}
      <div className="border-t border-line p-2">
        {/* Opens to the RIGHT: this trigger sits at the bottom of the viewport,
            so a dropdown would fall off the bottom of the screen. */}
        <Popover
          side="right"
          width={280}
          trigger={() => (
            <span
              className={`flex w-full items-center gap-2.5 rounded-lg px-2 py-2 transition-colors duration-150 hover:bg-canvas ${
                collapsed ? 'justify-center' : ''
              }`}
              title={`${user.name} — ${viewer.label}`}
            >
              <Avatar user={user} size={26} />
              {!collapsed ? (
                <>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[13px] font-semibold leading-tight text-ink-900">
                      {user.name}
                    </span>
                    <span className="block truncate text-[11px] leading-tight text-ink-400">
                      {viewer.label}
                    </span>
                  </span>
                  <Icon name="chevron-up" size={13} className="text-ink-400" />
                </>
              ) : null}
            </span>
          )}
        >
          {(close) => (
            <div>
              <p className="px-2 py-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-ink-400">
                View the CRM as
              </p>
              {VIEWERS.map((v) => {
                const u = USER_BY_ID.get(v.userId)!;
                const active = v.userId === viewer.userId;
                return (
                  <button
                    key={v.userId}
                    type="button"
                    onClick={() => {
                      setViewerId(v.userId);
                      close();
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors hover:bg-canvas ${
                      active ? 'bg-brand-50' : ''
                    }`}
                  >
                    <Avatar user={u} size={26} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-ink-900">
                        {u.name}
                      </span>
                      <span className="block text-[11.5px] text-ink-400">
                        {v.label} · {v.modules.length} modules
                        {v.ownRecordsOnly ? ' · own records' : ''}
                      </span>
                    </span>
                    {active ? <Icon name="check" size={14} className="text-brand-700" /> : null}
                  </button>
                );
              })}
              <p className="border-t border-line px-2 pt-2 text-[11.5px] leading-relaxed text-ink-400">
                Switching changes this navigation, the rows, <strong>and</strong> the columns. A
                field you cannot see produces an absent column, never a blank cell.
              </p>
            </div>
          )}
        </Popover>

        <button
          type="button"
          onClick={toggleNav}
          title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          className={`mt-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12.5px] font-medium text-ink-400 transition-colors duration-150 hover:bg-canvas hover:text-ink-700 ${
            collapsed ? 'justify-center' : ''
          }`}
        >
          <Icon name={collapsed ? 'panel-left-open' : 'panel-left'} size={16} />
          {!collapsed ? 'Collapse' : null}
        </button>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */

function GroupLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  if (collapsed) {
    // A hairline stands in for the label, so the grouping survives the collapse.
    return <div aria-hidden className="mx-auto my-2 h-px w-6 bg-line" />;
  }
  return (
    <p className="px-2.5 pb-1 pt-4 text-[10.5px] font-semibold uppercase tracking-[.1em] text-ink-400/80">
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
      className={`group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-medium transition-colors duration-150 ${
        active ? 'bg-brand-50 text-brand-700' : 'text-ink-500 hover:bg-canvas hover:text-ink-900'
      } ${collapsed ? 'justify-center' : ''}`}
    >
      {/* The active marker survives the collapse, where the tint alone is subtle. */}
      {active ? (
        <span
          aria-hidden
          className="absolute inset-y-1.5 -left-2 w-[3px] rounded-r-full bg-brand-600"
        />
      ) : null}
      <Icon name={icon} size={16} strokeWidth={active ? 2 : 1.75} />
      {!collapsed ? (
        <>
          <span className="flex-1 truncate">{label}</span>
          {count != null ? (
            <span
              className={`text-[11.5px] tabular transition-colors ${
                active ? 'text-brand-700/70' : 'text-ink-400'
              }`}
            >
              {count}
            </span>
          ) : null}
        </>
      ) : null}
    </Link>
  );
}
