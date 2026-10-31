'use client';

import { useRouter } from 'next/navigation';

const selectClass = 'rounded-lg border border-line bg-white px-3 py-2 text-[13px] text-ink-900 outline-none transition-colors hover:border-ink-300 focus-field';

export function RunFilters({
  automations,
  statuses,
  automation,
  status,
}: {
  automations: { value: string; label: string }[];
  statuses: { value: string; label: string }[];
  automation: string;
  status: string;
}) {
  const router = useRouter();
  const go = (next: { automation?: string; status?: string }) => {
    const q = new URLSearchParams();
    const a = next.automation ?? automation;
    const s = next.status ?? status;
    if (a) q.set('automation', a);
    if (s) q.set('status', s);
    const text = q.toString();
    router.push(`/admin/automations/runs${text ? `?${text}` : ''}`);
  };

  return (
    <div className="flex flex-wrap gap-2">
      <select aria-label="Automation" value={automation} onChange={(e) => go({ automation: e.target.value })} className={selectClass}>
        <option value="">All automations</option>
        {automations.map((a) => (
          <option key={a.value} value={a.value}>{a.label}</option>
        ))}
      </select>
      <select aria-label="Status" value={status} onChange={(e) => go({ status: e.target.value })} className={selectClass}>
        <option value="">All runs</option>
        {statuses.map((s) => (
          <option key={s.value} value={s.value}>{s.label}</option>
        ))}
      </select>
    </div>
  );
}
