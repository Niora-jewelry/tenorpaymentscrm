'use client';

/**
 * The tab strip for Admin → Presets.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────
 * All six editors — Tabs, Subtabs, Fields, Columns, Choices, Pipelines — were
 * stacked on one page. Fields alone is 844 lines of UI over 129 rows, so the
 * page ran to several screens of scrolling and the section you wanted was
 * never where you left it. Worse, they read as one undifferentiated wall when
 * they are in fact six independent things with a real hierarchy: a tab
 * contains subtabs, which contain fields; columns, choices and pipelines then
 * refer back to those fields.
 *
 * One section at a time, in that order, makes the hierarchy the navigation.
 *
 * ── WHY THE SECTIONS ARE PASSED AS RENDERED NODES ────────────────────────
 * Each section is a Server Component holding data the page already fetched.
 * Passing them in as `content` keeps that: the page stays one server render
 * with one set of queries, and this component only decides which of the
 * already-rendered subtrees is visible. Fetching per tab instead would turn
 * every click into a round trip on a screen whose whole data set is small.
 *
 * ── WHY `hidden` RATHER THAN UNMOUNTING ──────────────────────────────────
 * Every section owns local state — a half-typed new field name, an expanded
 * row, a pending edit. Unmounting the inactive ones would throw that away on
 * every tab switch, which is precisely the bug this session just fixed in the
 * record drawer. `hidden` keeps them mounted and costs nothing at this size.
 *
 * ── WHY THE ACTIVE TAB IS IN THE URL ─────────────────────────────────────
 * An admin editing fields reloads the page constantly to check a change landed
 * (the page header says to verify on a real module route, which means
 * navigating away and back). Without this they would land on Tabs every time.
 * `replace` rather than `push` so the browser Back button leaves Presets
 * instead of walking back through six tab clicks.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { CountPill } from '@/proto/ui/kit';
import { Icon, type IconName } from '@/proto/ui/icons';

export type PresetSection = {
  key: string;
  label: string;
  icon: IconName;
  /** Shown as a pill in the strip. The number of things this section manages,
   *  so an admin can see at a glance where the configuration actually lives. */
  count?: number;
  /** One line under the heading saying what this section decides. */
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
        className="-mb-px flex gap-0.5 overflow-x-auto border-b border-line"
      >
        {sections.map((s) => {
          const isActive = s.key === active.key;
          return (
            <button
              key={s.key}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => select(s.key)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors duration-150 ${
                isActive
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-ink-500 hover:border-line hover:text-ink-900'
              }`}
            >
              <Icon name={s.icon} size={13} className={isActive ? 'text-brand-600' : 'text-ink-400'} />
              {s.label}
              {s.count != null ? <CountPill n={s.count} active={isActive} /> : null}
            </button>
          );
        })}
      </nav>

      {/*
        All six stay mounted; only the active one is shown. The `hidden`
        attribute hides it (Tailwind's preflight keeps the browser default), and
        unlike a conditional render it preserves each section's in-progress
        local state. None of these wrappers carries a `display` utility class,
        which is the one thing that would override it.
      */}
      {sections.map((s) => (
        <div key={s.key} hidden={s.key !== active.key} className="pt-5">
          {/* Description only — no heading. The strip above already names the
              section and each section's own card repeats it in its header, so a
              third copy would just be noise. What is genuinely missing from
              both is a sentence saying what the section DECIDES, which is the
              thing an admin has to get right. */}
          <p className="mb-4 max-w-3xl text-[12.5px] leading-relaxed text-ink-500">{s.description}</p>
          {s.content}
        </div>
      ))}
    </div>
  );
}
