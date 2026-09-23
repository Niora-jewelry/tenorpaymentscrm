'use client';

/**
 * Step two of the invite dialog: the permission matrix, in place.
 *
 * ── WHY IT IS HERE AND NOT ON ANOTHER PAGE ───────────────────────────────
 * The client's words were "assign a template and also adjust permissions
 * BEFORE sending invite". The first attempt put a link on the success panel,
 * which meant leaving the dialog — technically before the person signs up, but
 * not what was asked, and it loses the flow he described.
 *
 * So the invite is created when the admin presses Continue, and this step
 * swaps into the same dialog against that invite. Nothing closes, nothing
 * navigates, and the invite already exists — which is what makes the matrix
 * writable at all, since `invite_grants` needs an invite to point at.
 *
 * ── SAME MATRIX AS EVERY OTHER PERMISSION SCREEN ─────────────────────────
 * `GrantMatrix` unchanged, the real `setInviteGrantAction`/`clearInviteGrantAction`
 * behind it, and the module picker in its non-navigating mode. An admin who
 * has used the Users screen already knows this one.
 */
import { useEffect, useState, useTransition } from 'react';
import { Button } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { GrantMatrix, type GrantWriter } from '../GrantMatrix';
import { ModuleScopePicker, type ModuleOption } from '../ModuleScopePicker';
import {
  inviteMatrixAction,
  setInviteGrantAction,
  clearInviteGrantAction,
} from './actions';
import type { GrantMatrix as GrantMatrixData } from '@/lib/records/adminGrants';

export function InvitePermissionsStep({
  inviteId,
  email,
  modules,
  onDone,
}: {
  inviteId: string;
  email: string;
  modules: ModuleOption[];
  onDone: () => void;
}) {
  const [moduleId, setModuleId] = useState<string | null>(null);
  const [matrix, setMatrix] = useState<GrantMatrixData | null>(null);
  const [loading, startLoading] = useTransition();

  // Refetched whenever the module changes, because the matrix IS per module —
  // the values shown and the values written have to agree, and the server is
  // the only thing that knows how a scope resolves in a given module.
  useEffect(() => {
    startLoading(async () => {
      setMatrix(await inviteMatrixAction(inviteId, moduleId));
    });
  }, [inviteId, moduleId]);

  const writer: GrantWriter = {
    column: 'user',
    set: (scopeKind, scopeId, level) =>
      setInviteGrantAction(inviteId, scopeKind, scopeId, level, moduleId),
    clear: (scopeKind, scopeId) =>
      clearInviteGrantAction(inviteId, scopeKind, scopeId, moduleId),
  };

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-ok-bg px-3 py-2">
        <Icon name="check" size={14} strokeWidth={2.5} className="text-ok" />
        <span className="text-[13px] font-medium text-ink-800">
          Invite created for {email}
        </span>
        <span className="text-[12px] text-ink-500">
          Anything you change below applies the moment they finish signing up.
        </span>
      </div>

      <ModuleScopePicker
        modules={modules}
        activeModuleId={moduleId}
        onSelect={setModuleId}
      />

      {matrix ? (
        <div className="max-h-[52vh] overflow-y-auto pr-1">
          <GrantMatrix matrix={matrix} writer={writer} />
        </div>
      ) : (
        <p className="py-8 text-center text-[13px] text-ink-400">
          {loading ? 'Loading permissions…' : 'Those permissions could not be loaded.'}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-line-soft pt-3">
        <p className="text-[12px] text-ink-400">
          Leaving this as it is invites them on the template alone, which is the usual case.
        </p>
        <Button type="button" variant="primary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
