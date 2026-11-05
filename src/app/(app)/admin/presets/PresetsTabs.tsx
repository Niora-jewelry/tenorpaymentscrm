'use client';

/**
 * The section navigation for Admin → Presets.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 * All the editors were once stacked on one page. Fields alone is 844 lines of
 * UI, so the page ran to several screens of scrolling and the section you wanted
 * was never where you left it. One section at a time fixes that.
 *
 * ── WHY GROUPS ────────────────────────────────────────────────────────────
 * The strip grew to ten sections and wrapped onto a second line, with one tab
 * stranded under the first. They are really three different jobs: what a record
 * is made of, how its values are listed and offered, and what gets sent out. The
 * groups say so, and they break cleanly on a narrow screen instead of wrapping
 * mid-thought. Inside a group the order follows the hierarchy: a tab holds
 * subtabs, and subtabs hold fields.
 *
 * ── WHY THE SECTIONS ARE PASSED AS RENDERED NODES ────────────────────────
 * Each section is a Server Component holding data the page already fetched.
 * Passing them in as `content` keeps that: the page stays one server render
 * with one set of queries, and this component only decides which of the
 * already-rendered subtrees is visible.
 *
 * ── WHY `hidden` RATHER THAN UNMOUNTING ──────────────────────────────────
 * Every section owns local state: a half-typed new field name, an expanded
 * row, a pending edit. Unmounting the inactive ones would throw that away on
 * every switch. `hidden` keeps them mounted and costs nothing at this size.
 *
 * ── WHY THE ACTIVE SECTION IS IN THE URL ─────────────────────────────────
 * An admin editing fields reloads the page constantly to check a change landed.
 * Without this they would land on Tabs every time. `replace` rather than `push`
 * so the browser Back button leaves Presets instead of walking back through
 * every click.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Icon, type IconName } from '@/proto/ui/icons';

export const PRESET_GROUPS = ['Record structure', 'Lists & options', 'Sending'] as const;
export type PresetGroup = (typeof PRESET_GROUPS)[number];

export type PresetSection = {
  key: string;
  label: string;
  icon: IconName;
  group: PresetGroup;
  /** How many things this section manages, so an admin can see where the configuration lives. */
  count?: number;
  /** One line saying what this section decides. */
  description: string;
  content: ReactNode;
};

export function PresetsTabs({ sections }: { sections: PresetSection[] }) {
  const router = useRouter();
  const params = useSearchParams();

  const requested = params.get('section');
  const active = sections.find((s) => s.key === requested) ?? sections[0]!;

  const select = (key: string) => {
    const next = new URLSearchParams(Array.from(params.entries()));
    if (key === sections[0]!.key) next.delete('section');
    else next.set('section', key);
    router.replace(`/admin/presets${next.toString() ? `?${next}` : ''}`, { scroll: false });
  };

  return (
    <div>
      <nav
        aria-label="Preset sections"
        data-presets-nav
        className="grid gap-y-3 rounded-xl border border-line bg-white p-2.5 xl:grid-cols-[auto_auto_auto] xl:justify-between"
      >
        {PRESET_GROUPS.map((group, i) => {
          const members = sections.filter((s) => s.group === group);
          if (!members.length) return null;
          const headingId = `preset-group-${i}`;
          return (
            <div
              key={group}
              role="group"
              aria-labelledby={headingId}
              className={`min-w-0 ${i > 0 ? 'border-t border-line-faint pt-3 xl:border-l xl:border-t-0 xl:pl-2 xl:pt-0' : ''}`}
            >
              <div id={headingId} className="px-1.5 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-ink-400">
                {group}
              </div>
              <div className="flex flex-wrap gap-0.5 xl:flex-nowrap">
                {members.map((s) => {
                  const isActive = s.key === active.key;
                  return (
                    <button
                      key={s.key}
                      type="button"
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => select(s.key)}
                      className={`flex h-8 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[12.5px] font-medium outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-brand-600 ${
                        isActive ? 'bg-brand-50 text-brand-700' : 'text-ink-600 hover:bg-canvas hover:text-ink-900'
                      }`}
                    >
                      <Icon name={s.icon} size={13} className={isActive ? 'text-brand-600' : 'text-ink-400'} />
                      {s.label}
                      {s.count != null ? (
                        <span
                          className={`min-w-[18px] rounded-full px-1 text-center text-[11px] font-semibold tabular-nums ${
                            isActive ? 'bg-brand-100 text-brand-700' : 'bg-canvas text-ink-400'
                          }`}
                        >
                          {s.count}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      {/*
        All stay mounted; only the active one is shown. The `hidden` attribute
        hides it, and unlike a conditional render it preserves each section's
        in-progress local state. None of these wrappers carries a `display`
        utility class, which is the one thing that would override it.
      */}
      {sections.map((s) => (
        <div key={s.key} hidden={s.key !== active.key} className="pt-5">
          <p className="mb-4 max-w-3xl text-[12.5px] leading-relaxed text-ink-500">{s.description}</p>
          {s.content}
        </div>
      ))}
    </div>
  );
}
