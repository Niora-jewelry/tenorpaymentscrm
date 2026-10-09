'use client';

/**
 * "Reload configuration" — the manual half of the config cache.
 *
 * `loadConfig()` is cached across every request and user with no expiry, and
 * dropped only by `revalidateConfig()`. Every action on this screen calls it,
 * so anything an admin changes here appears at once.
 *
 * What this is for is the other writer: configuration that arrives in a
 * MIGRATION. SQL cannot call into Next, so a migration that adds a column or
 * changes which subtabs a module shows lands in the database correct and
 * stays invisible — `adminConfigCache.ts` calls that its own nightmare
 * scenario, and it happened twice in one afternoon before this existed.
 *
 * Deliberately undramatic: it is in the corner of the screen that owns
 * configuration, it says what it does, and it is harmless to press. The worst
 * case is one slower page load while the config is read again.
 */
import { useState, useTransition } from 'react';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { reloadConfigCacheAction } from './actions';

export function ReloadConfigButton() {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="flex items-center gap-2">
      {done ? (
        <span className="flex items-center gap-1.5 text-[12px] text-ok">
          <Icon name="check" size={12} />
          Reloaded
        </span>
      ) : error ? (
        <span className="flex items-center gap-1.5 text-[12px] text-[#b02a30]">
          <Icon name="alert-triangle" size={12} />
          {error}
        </span>
      ) : null}
      <Button
        size="sm"
        variant="ghost"
        icon="rotate-ccw"
        loading={pending}
        loadingLabel="Reloading…"
        title="Re-read tabs, fields, columns and pipelines from the database. Needed only after configuration arrives in a migration rather than through this screen."
        onClick={() =>
          startTransition(async () => {
            setError(null);
            setDone(false);
            const result = await reloadConfigCacheAction();
            if (result.ok) setDone(true);
            else setError(result.message ?? 'Could not reload.');
          })
        }
      >
        Reload configuration
      </Button>
    </span>
  );
}
