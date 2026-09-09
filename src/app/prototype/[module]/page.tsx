'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { ModuleView } from '@/proto/ui/ModuleView';

/**
 * ONE route renders all six modules.
 *
 * There is no `/leads/page.tsx`, no `/deals/page.tsx`. The slug is looked up in
 * the modules configuration and everything — columns, tabs, pipelines, the
 * drawer — follows from that. A seventh module needs no new route.
 */
export default function ModulePage() {
  const params = useParams<{ module: string }>();
  return (
    <Suspense fallback={<div className="p-8 text-[13px] text-ink-400">Loading…</div>}>
      <ModuleView slug={params.module} />
    </Suspense>
  );
}
