'use client';

/** A repeating event: which of them does this change apply to? */
import { useState } from 'react';
import { Dialog } from '@/proto/ui/kit';
import type { SeriesScope } from '@/lib/msteams/types';

const OPTIONS: { value: SeriesScope; label: string }[] = [
  { value: 'this', label: 'This event' },
  { value: 'following', label: 'This and following' },
  { value: 'all', label: 'All events' },
];

export function ScopeDialog({ verb, tone, onPick, onCancel }: { verb: string; tone?: 'danger'; onPick: (scope: SeriesScope) => void; onCancel: () => void }) {
  const [scope, setScope] = useState<SeriesScope>('this');
  return (
    <Dialog title={`${verb} repeating event`} tone={tone ?? 'neutral'} confirmLabel={verb} onConfirm={() => onPick(scope)} onClose={onCancel}>
      <fieldset className="space-y-1.5">
        <legend className="sr-only">Which events</legend>
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-800">
            <input type="radio" name="scope" value={o.value} checked={scope === o.value} onChange={() => setScope(o.value)} />
            {o.label}
          </label>
        ))}
      </fieldset>
    </Dialog>
  );
}
