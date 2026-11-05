'use client';

/**
 * Broadcast and group texts on /phone. They share a panel because they answer the
 * same question, "how do I text more than one person?", and the difference between
 * them is the one thing a user has to choose: do people see each other, or not?
 */
import { useId, useMemo, useState } from 'react';
import type { Contact } from '@/lib/phone/contacts';
import type { BroadcastView } from '@/lib/phone/broadcasts';
import type { GroupView } from '@/lib/phone/groups';
import { BroadcastPanel } from './BroadcastPanel';
import { GroupTexts } from './GroupTexts';

type Tab = 'broadcast' | 'groups';

const TABS: { key: Tab; label: string; blurb: string }[] = [
  { key: 'broadcast', label: 'Broadcast', blurb: 'One message to many people. Each person gets their own text, and replies come back privately.' },
  { key: 'groups', label: 'Group texts', blurb: 'One shared conversation. Everyone sees everyone’s messages and numbers.' },
];

export function TextMany({
  allowed,
  myNumber,
  contacts,
  broadcasts,
  groups,
}: {
  allowed: boolean;
  myNumber: string | null;
  contacts: Contact[];
  broadcasts: BroadcastView[];
  groups: GroupView[];
}) {
  const [tab, setTab] = useState<Tab>(groups.length > 0 ? 'groups' : 'broadcast');
  const baseId = useId();
  const active = useMemo(() => TABS.find((t) => t.key === tab)!, [tab]);

  return (
    <section id="text-many" className="scroll-mt-4 rounded-2xl border border-line bg-white p-4" data-text-many>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[13.5px] font-semibold text-ink-900">Text many people</h2>
        <div role="tablist" aria-label="Ways to text many people" className="flex gap-0.5 rounded-lg bg-canvas p-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              id={`${baseId}-${t.key}`}
              type="button"
              role="tab"
              aria-selected={t.key === tab}
              aria-controls={`${baseId}-panel`}
              onClick={() => setTab(t.key)}
              className={`h-7 rounded-md px-3 text-[12.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand-600 ${
                t.key === tab ? 'bg-white text-ink-900 shadow-sm' : 'text-ink-500 hover:text-ink-900'
              }`}
            >
              {t.label}
              {t.key === 'groups' && groups.length > 0 ? <span className="ml-1.5 text-[11px] tabular text-ink-400">{groups.length}</span> : null}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-500">{active.blurb}</p>

      <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-${tab}`} className="mt-4">
        {/* Both stay mounted, so a half-written message survives a look at the other tab. */}
        <div hidden={tab !== 'broadcast'}>
          <BroadcastPanel allowed={allowed} myNumber={myNumber} contacts={contacts} broadcasts={broadcasts} />
        </div>
        <div hidden={tab !== 'groups'}>
          <GroupTexts allowed={allowed} myNumber={myNumber} contacts={contacts} groups={groups} />
        </div>
      </div>
    </section>
  );
}
