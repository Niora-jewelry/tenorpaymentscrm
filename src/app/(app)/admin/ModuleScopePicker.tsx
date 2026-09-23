'use client';

/**
 * "Which module am I setting permissions for?"
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
 * Admin-Module-Plan §2.2 says granularity is PER MODULE at all three levels —
 * module, tab/subtab, and field. Until this, tab and field grants were global:
 * hiding Pricing hid it in Leads AND Deals AND Contacts AND Tickets AND
 * Residuals, because every tab in this build is attached to all six modules.
 *
 * ── "ALL MODULES" IS A REAL CHOICE, NOT AN EMPTY ONE ─────────────────────
 * It is the default, it is what every existing grant already means, and it is
 * what an admin wants the overwhelming majority of the time: "this person
 * cannot see Statements" is nearly always true everywhere. Per-module is the
 * exception, so it is one click away rather than the starting point.
 *
 * That also keeps the screen honest. Landing on a module would show one
 * module's values while the admin believed they were editing the person, and
 * the difference is invisible until someone checks another module.
 *
 * ── A LINK, NOT A CLIENT CONTROL ─────────────────────────────────────────
 * The matrix is built on the server for the chosen module — the values shown
 * and the values written have to agree, and the only way to guarantee that is
 * to rebuild it. So this is navigation, and the URL carries the state: an
 * admin can link someone straight to "Sales Rep, in Deals".
 */
import Link from 'next/link';

export type ModuleOption = { id: string; label: string };

export function ModuleScopePicker({
  modules,
  activeModuleId,
  basePath,
  onSelect,
}: {
  modules: ModuleOption[];
  /** Null = the "All modules" view. */
  activeModuleId: string | null;
  /** The page this picker sits on, without a query string. Ignored when
   *  `onSelect` is given. */
  basePath?: string;
  /**
   * Switch modules WITHOUT navigating.
   *
   * On a page the URL is the right place for this state — it makes the view
   * linkable and survives a reload. Inside the invite dialog it is not: a
   * navigation would close the dialog and lose the half-finished invite, which
   * is exactly what the client asked us to avoid. When this is supplied the
   * picker renders buttons and hands the choice back instead.
   */
  onSelect?: (moduleId: string | null) => void;
}) {
  const options: { id: string | null; label: string }[] = [
    { id: null, label: 'All modules' },
    ...modules.map((m) => ({ id: m.id as string | null, label: m.label })),
  ];

  return (
    <div className="rounded-xl border border-line bg-white p-3">
      <p className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
        Setting permissions for
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {options.map((o) => {
          const active = o.id === activeModuleId;
          const className = `rounded-full px-3 py-1.5 text-[12.5px] font-semibold transition-colors ${
            active
              ? 'bg-brand-950 text-white'
              : 'border border-line bg-white text-ink-600 hover:border-brand-200 hover:bg-brand-50'
          }`;

          if (onSelect) {
            return (
              <button
                key={o.id ?? 'all'}
                type="button"
                onClick={() => onSelect(o.id)}
                className={className}
              >
                {o.label}
              </button>
            );
          }

          return (
            <Link
              key={o.id ?? 'all'}
              href={o.id ? `${basePath}?module=${o.id}` : (basePath ?? '')}
              scroll={false}
              className={className}
            >
              {o.label}
            </Link>
          );
        })}
      </div>

      <p className="mt-2 text-[11.5px] leading-relaxed text-ink-500">
        {activeModuleId ? (
          <>
            Changes below apply to <strong>this module only</strong>. Anything not set here falls
            back to the <strong>All modules</strong> value.
          </>
        ) : (
          <>
            Changes below apply <strong>everywhere</strong>. Pick a module to override just that one
            — useful when someone should see a tab in Leads but not in Deals.
          </>
        )}
      </p>
    </div>
  );
}
