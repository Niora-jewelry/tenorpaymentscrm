'use client';

/**
 * The Recycle Bin's section strip.
 *
 * Admin §6 lists six kinds of thing in one bin: records, files, updates and
 * replies, login rows, cases, and users. Stacked on one page they run to
 * several screens and the thing being looked for is never where it was left —
 * the same problem, and the same fix, as Presets.
 *
 * Sections are passed in as already-rendered nodes so the page stays ONE server
 * render with one set of queries; this component only decides which subtree is
 * visible. `hidden` rather than unmounting, so a half-typed confirmation or an
 * error message on a row survives a tab switch.
 *
 * A section with nothing in it is still shown, with its zero — "no deleted
 * files" is information, and a strip whose tabs come and go is one an admin
 * cannot learn.
 */
import { useState, type ReactNode } from 'react';
import { CountPill } from '@/proto/ui/kit';
import { Icon, type IconName } from '@/proto/ui/icons';

export type BinSection = {
  key: string;
  label: string;
  icon: IconName;
  count: number;
  /** One line saying what restoring something in this section does. */
  description: string;
  content: ReactNode;
};

export function BinSections({ sections }: { sections: BinSection[] }) {
  const [activeKey, setActiveKey] = useState(sections[0]?.key ?? '');
  const active = sections.find((s) => s.key === activeKey) ?? sections[0];

  return (
    <div>
      <nav aria-label="Recycle Bin sections" className="-mb-px flex gap-0.5 overflow-x-auto border-b border-line">
        {sections.map((s) => {
          const isActive = s.key === active?.key;
          return (
            <button
              key={s.key}
              type="button"
              aria-current={isActive ? 'page' : undefined}
              onClick={() => setActiveKey(s.key)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium transition-colors duration-150 ${
                isActive
                  ? 'border-brand-600 text-brand-700'
                  : 'border-transparent text-ink-500 hover:border-line hover:text-ink-900'
              }`}
            >
              <Icon name={s.icon} size={13} className={isActive ? 'text-brand-600' : 'text-ink-400'} />
              {s.label}
              <CountPill n={s.count} active={isActive} />
            </button>
          );
        })}
      </nav>

      {sections.map((s) => (
        <div key={s.key} hidden={s.key !== active?.key} className="pt-4">
          <p className="mb-3 max-w-2xl text-[12.5px] leading-relaxed text-ink-500">{s.description}</p>
          {s.count === 0 ? (
            <p className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-[13px] text-ink-400">
              Nothing here.
            </p>
          ) : (
            s.content
          )}
        </div>
      ))}
    </div>
  );
}
