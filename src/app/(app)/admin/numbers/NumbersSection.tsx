'use client';

/**
 * The Phone numbers table — assign, deactivate, add.
 *
 * ── THE CARRIER WARNING IS THE POINT OF THIS SCREEN ──────────────────────
 * Assigning a number here is application authorization and nothing more. A US
 * number cannot TEXT US numbers until A2P 10DLC or toll-free verification
 * completes in the Twilio console, per number, and no API reports that state
 * ahead of time. Without the notice below, the failure mode is: an admin
 * assigns a number, the rep's texts fail with a Twilio error code, and someone
 * spends an afternoon looking for a bug in the CRM. Calling is unaffected, and
 * so is INBOUND texting — which is exactly why this is confusing enough to
 * need saying out loud.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button, EmptyState, SpecNote, StatusPill } from '@/proto/ui/kit';
import { formatPhoneDisplay } from '@/lib/phone/normalize';
import type { AdminPhoneNumber } from '@/lib/records/adminNumbers';
import { addNumberAction, assignNumberAction, setNumberActiveAction } from './actions';

type UserOption = { id: string; label: string };

export function NumbersSection({
  numbers,
  users,
}: {
  numbers: AdminPhoneNumber[];
  users: UserOption[];
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const assign = (numberId: string, userId: string) =>
    startTransition(async () => {
      setError(null);
      const result = await assignNumberAction(numberId, userId);
      if (!result.ok) setError(result.message);
    });

  const toggleActive = (numberId: string, isActive: boolean) =>
    startTransition(async () => {
      /*
       * Deactivating a number takes telephony away from whoever holds it. The
       * action returns void and throws on refusal, so unguarded the row's
       * Active pill simply stayed as it was with nothing said — and an admin
       * who thinks they have switched a number off, but has not, is a billing
       * problem rather than a cosmetic one.
       */
      try {
        setError(null);
        await setNumberActiveAction(numberId, isActive);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not change that number.');
      }
    });

  return (
    <div className="space-y-4">
      <SpecNote>
        <strong>Assigning a number is not the same as being allowed to text from it.</strong> A US
        number must complete <strong>A2P 10DLC</strong> (local numbers) or{' '}
        <strong>toll-free verification</strong> in the Twilio console before outbound SMS to US
        numbers will leave Twilio — and that registration is per number, so a newly provisioned one
        does not inherit an existing clearance. Calling works regardless, and so does{' '}
        <em>receiving</em> texts, which is why an inbound thread is not evidence that sending works.
      </SpecNote>

      {error ? (
        <p className="inline-flex items-center gap-1.5 rounded-lg bg-red-50 px-3 py-2 text-[12.5px] text-red-700">
          <Icon name="alert-triangle" size={13} />
          {error}
        </p>
      ) : null}

      {numbers.length === 0 ? (
        <EmptyState
          icon="phone"
          title="No numbers yet"
          body="Add a Twilio number below, then assign it to someone."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-[13px]">
              <thead>
                <tr>
                  {['Number', 'Kind', 'Assigned to', 'Status', ''].map((h) => (
                    <th
                      key={h}
                      className="whitespace-nowrap border-b border-line-soft bg-canvas/50 px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[.04em] text-ink-400"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {numbers.map((n) => (
                  <tr key={n.id}>
                    <td className="whitespace-nowrap border-b border-line-faint px-3 py-2 font-medium text-ink-900 tabular">
                      {formatPhoneDisplay(n.e164)}
                      {n.label ? (
                        <span className="ml-2 text-[11.5px] font-normal text-ink-400">{n.label}</span>
                      ) : null}
                    </td>
                    <td className="border-b border-line-faint px-3 py-2 text-ink-500">{n.kind}</td>
                    <td className="border-b border-line-faint px-3 py-2">
                      {/* A campaign number has no owning user by construction —
                          the phone_numbers_kind_shape check enforces it — so it
                          gets no picker rather than a disabled one. */}
                      {n.kind === 'campaign' ? (
                        <span className="text-ink-400">—</span>
                      ) : (
                        <select
                          value={n.userId ?? ''}
                          disabled={pending}
                          onChange={(e) => assign(n.id, e.target.value)}
                          className="rounded-lg border border-line bg-white px-2 py-1 text-[12.5px] text-ink-900 focus-field"
                        >
                          <option value="">Unassigned</option>
                          {users.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="border-b border-line-faint px-3 py-2">
                      <StatusPill
                        label={n.isActive ? 'Active' : 'Inactive'}
                        swatch={n.isActive ? 'teal' : 'amber'}
                        dot={false}
                      />
                    </td>
                    <td className="border-b border-line-faint px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={pending}
                        onClick={() => toggleActive(n.id, !n.isActive)}
                      >
                        {n.isActive ? 'Deactivate' : 'Activate'}
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <AddNumberForm onError={setError} />
    </div>
  );
}

function AddNumberForm({ onError }: { onError: (message: string | null) => void }) {
  const [pending, startTransition] = useTransition();

  return (
    <form
      action={(formData) =>
        startTransition(async () => {
          onError(null);
          const result = await addNumberAction(formData);
          if (!result.ok) onError(result.message);
        })
      }
      className="flex flex-wrap items-end gap-2 rounded-xl border border-line bg-white p-3"
    >
      <div>
        <label htmlFor="e164" className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
          Twilio number
        </label>
        <input
          id="e164"
          name="e164"
          required
          placeholder="+1 732 724 1779"
          className="mt-1 block rounded-lg border border-line bg-canvas/40 px-2.5 py-1.5 text-[13px] text-ink-900 focus-field"
        />
      </div>
      <div>
        <label htmlFor="label" className="text-[11px] font-semibold uppercase tracking-[.06em] text-ink-400">
          Label (optional)
        </label>
        <input
          id="label"
          name="label"
          placeholder="Sales line"
          className="mt-1 block rounded-lg border border-line bg-canvas/40 px-2.5 py-1.5 text-[13px] text-ink-900 focus-field"
        />
      </div>
      <Button type="submit" size="sm" icon="plus" disabled={pending}>
        {pending ? 'Adding…' : 'Add number'}
      </Button>
    </form>
  );
}
