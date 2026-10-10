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
import { useCallback, useEffect, useState, useTransition } from 'react';
import { Button, Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { GrantMatrix, type GrantWriter } from '../GrantMatrix';
import type { GrantResult } from '@/lib/records/adminGrants';
import { ModuleScopePicker, type ModuleOption } from '../ModuleScopePicker';
import {
  inviteMatrixAction,
  setInviteGrantAction,
  clearInviteGrantAction,
  sendInviteEmailAction,
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

  /*
   * ── SENDING IS THE LAST THING THAT HAPPENS ────────────────────────────
   * The invite row already exists — it has to, or the matrix above would
   * have nothing to write against. What has NOT happened yet is telling the
   * person, and that is deliberate: the client asked to assign a template
   * and adjust permissions "before sending invite", so the email goes out
   * from here, once, when the admin says they are finished.
   */
  const [sending, startSending] = useTransition();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const sendInvitation = () => {
    setSendError(null);
    startSending(async () => {
      try {
        const result = await sendInviteEmailAction(inviteId);
        if (result.ok) setSentTo(result.email ?? email);
        else setSendError(result.message ?? 'The invitation email could not be sent.');
      } catch {
        setSendError('The invitation email could not be sent. The invite itself is saved.');
      }
    });
  };

  /*
   * Refetched whenever the module changes, because the matrix IS per module —
   * the values shown and the values written have to agree, and the server is
   * the only thing that knows how a scope resolves in a given module.
   *
   * Also refetched after every successful write. On a page a write calls
   * `revalidatePath` and fresh props arrive on their own; inside this dialog
   * there is no navigation to revalidate, so without this the screen ran on
   * its optimistic overlay alone and never heard back from the database. The
   * overlay stays up until the fresh matrix agrees with it, so this converges
   * quietly rather than flashing.
   */
  const reload = useCallback(() => {
    startLoading(async () => {
      setMatrix(await inviteMatrixAction(inviteId, moduleId));
    });
  }, [inviteId, moduleId]);

  useEffect(() => {
    reload();
  }, [reload]);

  /*
   * Every write is confirmed out loud. The matrix draws the new value
   * immediately, which tells you the CLICK registered but not that the SAVE
   * did -- and on an invite the difference matters, because nothing here is
   * visible again until the person signs up. A refusal from the server
   * replaces it with the reason.
   */
  const [saved, setSaved] = useState<string | null>(null);

  const announce = (result: GrantResult, what: string): GrantResult => {
    setSaved(result.ok ? what : result.message);
    /* Only on success: a refusal leaves the database as it was, so there is
       nothing new to read, and refetching would only discard the message. */
    if (result.ok) reload();
    return result;
  };

  const writer: GrantWriter = {
    column: 'user',
    set: async (scopeKind, scopeId, level) =>
      announce(
        await setInviteGrantAction(inviteId, scopeKind, scopeId, level, moduleId),
        `Saved \u2014 set to ${level}.`,
      ),
    clear: async (scopeKind, scopeId) =>
      announce(
        await clearInviteGrantAction(inviteId, scopeKind, scopeId, moduleId),
        'Saved \u2014 back to the template value.',
      ),
  };

  /*
   * Sent. The matrix is deliberately replaced rather than left on screen
   * under a banner: the invitation has gone, so a still-editable permission
   * grid invites changes that the person has already been emailed about.
   * Anything further belongs on the Permissions screen, which this says.
   */
  if (sentTo) {
    return (
      <div className="mt-4">
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-ok/25 bg-ok-bg px-4 py-4"
        >
          <p className="flex items-center gap-2 text-[14px] font-semibold text-ink-900">
            <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ok text-white">
              <Icon name="check" size={13} strokeWidth={3} />
            </span>
            Invitation email sent
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-700">
            <strong className="font-semibold text-ink-900">{sentTo}</strong> has been emailed an
            invitation to TapDash with a link to create their account. The permissions you set
            apply the moment they finish signing up.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-ink-500">
            Nothing else is needed. If it does not arrive, Resend is available on the invite in
            the list below.
          </p>
        </div>

        <div className="mt-5 flex justify-end">
          <Button type="button" variant="primary" onClick={onDone}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line-soft bg-ok-bg px-3 py-2">
        <Icon name="check" size={14} strokeWidth={2.5} className="text-ok" />
        <span className="text-[13px] font-medium text-ink-800">
          Invite created for {email}
        </span>
        <span className="text-[12px] text-ink-500">
          Nothing has been emailed yet &mdash; set permissions, then send.
        </span>
      </div>

      <ModuleScopePicker
        modules={modules}
        activeModuleId={moduleId}
        onSelect={(id) => {
          setModuleId(id);
          setSaved(null);
        }}
      />

      {saved ? (
        <p
          aria-live="polite"
          className="flex items-center gap-1.5 rounded-lg bg-ok-bg px-3 py-1.5 text-[12.5px] font-medium text-ink-800"
        >
          <Icon name="check" size={13} strokeWidth={2.5} className="text-ok" />
          {saved}
        </p>
      ) : null}

      {matrix ? (
        /*
          ── A REFETCH HAS TO SAY SO, BECAUSE THE OLD MATRIX IS STILL HERE ──
          Switching module refetches, and until that lands `matrix` still
          holds the PREVIOUS module's values. Rendered plainly, those read as
          the new module's — the screen looks settled and is showing the wrong
          thing, which on a permission screen is the worst kind of wrong.

          So while a refetch is in flight the grid is dimmed, made
          non-interactive, and overlaid with a label naming what is being
          loaded. Dimming alone would not be enough: it has to be unclickable,
          or a click lands on a row belonging to the module you just left.

          The first load still gets the plain message below — there is nothing
          to dim yet.
        */
        <div className="relative">
          <div
            className={`max-h-[52vh] overflow-y-auto pr-1 transition-opacity ${
              loading ? 'pointer-events-none opacity-40' : ''
            }`}
            aria-busy={loading}
          >
            <GrantMatrix matrix={matrix} writer={writer} />
          </div>
          {loading ? (
            <div className="pointer-events-none absolute inset-0 flex items-start justify-center pt-10">
              <span
                role="status"
                className="inline-flex items-center gap-2 rounded-full border border-line bg-white px-3 py-1.5 text-[12.5px] font-medium text-ink-700 shadow-[0_4px_16px_-6px_rgba(8,32,47,.3)]"
              >
                <span aria-hidden className="inline-block text-[12px] leading-none">
                  <Spinner />
                </span>
                Loading permissions for{' '}
                {moduleId ? (modules.find((m) => m.id === moduleId)?.label ?? 'this module') : 'all modules'}…
              </span>
            </div>
          ) : null}
        </div>
      ) : (
        <p className="flex items-center justify-center gap-2 py-8 text-center text-[13px] text-ink-400">
          {loading ? (
            <>
              <span aria-hidden className="inline-block text-[13px] leading-none">
                <Spinner />
              </span>
              Loading permissions…
            </>
          ) : (
            'Those permissions could not be loaded.'
          )}
        </p>
      )}

      {sendError ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg bg-danger-bg px-3 py-2 text-[12.5px] leading-relaxed text-danger"
        >
          <Icon name="alert-triangle" size={13} className="mt-[2px] shrink-0" />
          <span>
            {sendError} The invite itself is saved &mdash; use Resend on it rather than inviting
            this address again.
          </span>
        </p>
      ) : null}

      <div className="flex items-center justify-between gap-3 border-t border-line-soft pt-3">
        <p className="text-[12px] text-ink-400">
          Leaving this as it is invites them on the template alone, which is the usual case.
        </p>
        <div className="flex shrink-0 items-center gap-2">
          {/* Closing without sending is a real choice: the invite exists and
              still works, and Resend can announce it later. Named so it does
              not read as Cancel, which would imply the invite was discarded. */}
          <Button type="button" variant="ghost" disabled={sending} onClick={onDone}>
            Close without sending
          </Button>
          <Button
            type="button"
            variant="primary"
            icon="mail"
            loading={sending}
            loadingLabel="Sending…"
            onClick={sendInvitation}
          >
            Send invitation
          </Button>
        </div>
      </div>
    </div>
  );
}
