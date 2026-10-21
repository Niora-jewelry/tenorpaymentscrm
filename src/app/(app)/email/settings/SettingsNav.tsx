'use client';

/**
 * Section links for Email settings. Sticky beside the content on wide
 * screens, a scrolling strip above it on narrow ones; the section in view
 * is marked as the person scrolls.
 */
import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '@/proto/ui/icons';

export type SettingsSection = { id: string; label: string; icon: IconName };

export function SettingsNav({ sections }: { sections: SettingsSection[] }) {
  const [active, setActive] = useState(sections[0]?.id ?? '');
  // After a click, the clicked section stays marked while the page scrolls to it.
  const pinnedUntil = useRef(0);

  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.id)).filter((e): e is HTMLElement => Boolean(e));
    if (!els.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top && Date.now() > pinnedUntil.current) setActive(top.target.id);
      },
      { rootMargin: '-10% 0px -70% 0px' },
    );
    els.forEach((e) => io.observe(e));
    return () => io.disconnect();
  }, [sections]);

  return (
    <nav aria-label="Email settings sections" className="lg:sticky lg:top-6 lg:self-start">
      <ul className="flex gap-1 overflow-x-auto lg:flex-col lg:overflow-visible">
        {sections.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              aria-current={active === s.id ? 'true' : undefined}
              onClick={() => {
                pinnedUntil.current = Date.now() + 1200;
                setActive(s.id);
              }}
              className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
                active === s.id ? 'bg-white text-ink-900 shadow-[0_1px_2px_rgba(8,32,47,.08)] ring-1 ring-line' : 'text-ink-500 hover:bg-white/70 hover:text-ink-900'
              }`}
            >
              <Icon name={s.icon} size={14} className={active === s.id ? 'text-brand-700' : 'text-ink-400'} />
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
