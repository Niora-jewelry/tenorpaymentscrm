'use client';

import { useEffect, useState } from 'react';
import { Icon } from '@/proto/ui/icons';

/**
 * What someone on Add only sees after a save (Add only spec, Confirmation). What
 * they saved has left their view, so this is the only sign it went through.
 *
 * Keyed by the caller on a count of saves, so a second save starts it afresh.
 */
export function SavedNotice() {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const t = setTimeout(() => setVisible(false), 8000);
    return () => clearTimeout(t);
  }, []);

  if (!visible) return null;
  return (
    <p role="status" className="flex items-center gap-2 rounded-lg border border-[#c6e7d3] bg-[#ecf8f1] px-3 py-2 text-[12.5px] font-medium text-[#1b7a45]">
      <Icon name="check" size={13} className="shrink-0" />
      Saved. You won&apos;t be able to view this item.
    </p>
  );
}
