'use client';

/**
 * Add or edit one contact.
 *
 * One component for both, because "edit" and "add" differ only in what the
 * fields start as and which action runs. Two components would have been two
 * places to change the validation the next time a field moves.
 *
 * ── THE NUMBER IS ECHOED BACK, ALWAYS ────────────────────────────────────
 * Beside each number field sits the number as it will actually be stored, in
 * E.164. Matching a call or a text to a contact is an exact string comparison,
 * so a mistyped number produces a contact that looks perfect and that nothing
 * ever matches. Showing `+1 (732) 724-1779` while they type is what turns that
 * silent failure into an obvious one.
 */
import { useState, useTransition } from 'react';
import { Icon } from '@/proto/ui/icons';
import { Button } from '@/proto/ui/kit';
import { formatPhoneDisplay, normalizePhone } from '@/lib/phone/normalize';
import type { Contact } from '@/lib/phone/contacts';
import { createContactAction, updateContactAction, type ContactState } from './contactActions';

const MAX_NUMBERS = 5;

type NumberField = { raw: string; label: string };

export function ContactForm({
  contact,
  onDone,
  onCancel,
}: {
  /** Absent when adding. */
  contact?: Contact;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [displayName, setDisplayName] = useState(contact?.displayName ?? '');
  const [company, setCompany] = useState(contact?.company ?? '');
  const [email, setEmail] = useState(contact?.email ?? '');
  const [notes, setNotes] = useState(contact?.notes ?? '');
  const [numbers, setNumbers] = useState<NumberField[]>(
    contact?.numbers.length
      ? contact.numbers.map((n) => ({ raw: n.e164, label: n.label ?? '' }))
      : [{ raw: '', label: '' }],
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const setNumber = (i: number, patch: Partial<NumberField>) =>
    setNumbers((prev) => prev.map((n, j) => (j === i ? { ...n, ...patch } : n)));

  const addNumber = () =>
    setNumbers((prev) => (prev.length >= MAX_NUMBERS ? prev : [...prev, { raw: '', label: '' }]));

  const removeNumber = (i: number) =>
    setNumbers((prev) => (prev.length === 1 ? prev : prev.filter((_, j) => j !== i)));

  const filled = numbers.filter((n) => n.raw.trim().length > 0);
  const canSave = displayName.trim().length > 0 && filled.length > 0 && !pending;

  const save = () => {
    setError(null);
    const input = {
      displayName: displayName.trim(),
      company: company.trim(),
      email: email.trim(),
      notes: notes.trim(),
      numbers: filled.map((n) => ({ raw: n.raw.trim(), label: n.label.trim() })),
    };

    startTransition(async () => {
      const result: ContactState = contact
        ? await updateContactAction(contact.id, input)
        : await createContactAction(input);

      if (result.ok) {
        onDone(contact ? 'Contact updated.' : `${input.displayName} added to your contacts.`);
      } else {
        setError(result.message ?? 'That contact could not be saved.');
      }
    });
  };

  const field =
    'mt-1 w-full rounded-lg border border-line bg-white px-2.5 py-2 text-[13.5px] text-ink-900 outline-none focus-field';
  const label = 'text-[11.5px] font-semibold uppercase tracking-wide text-ink-400';

  return (
    <div className="rounded-xl border border-line bg-canvas/40 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-ink-900">
          <Icon name={contact ? 'pencil' : 'plus'} size={13} className="text-ink-400" />
          {contact ? `Edit ${contact.displayName}` : 'New contact'}
        </h3>
        <button
          type="button"
          aria-label="Close"
          onClick={onCancel}
          className="grid size-6 place-items-center rounded-md text-ink-400 transition-colors hover:bg-white hover:text-ink-900"
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="c-name" className={label}>
            Name
          </label>
          <input
            id="c-name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            disabled={pending}
            maxLength={120}
            placeholder="Jane Cohen"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="c-company" className={label}>
            Company <span className="font-normal normal-case text-ink-300">optional</span>
          </label>
          <input
            id="c-company"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            disabled={pending}
            maxLength={160}
            placeholder="Cohen Hardware"
            className={field}
          />
        </div>
      </div>

      {/* ── numbers ──────────────────────────────────────────────────── */}
      <div className="mt-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className={label}>Phone numbers</span>
          <span className="text-[11.5px] text-ink-400">
            {filled.length} of {MAX_NUMBERS}
          </span>
        </div>

        <div className="mt-1 space-y-2">
          {numbers.map((n, i) => {
            const parsed = normalizePhone(n.raw);
            const typed = n.raw.trim().length > 0;
            return (
              <div key={i} className="rounded-lg border border-line bg-white p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={n.raw}
                    onChange={(e) => setNumber(i, { raw: e.target.value })}
                    disabled={pending}
                    type="tel"
                    maxLength={32}
                    placeholder="(732) 724-1779"
                    aria-label={`Phone number ${i + 1}`}
                    className="min-w-0 flex-1 rounded-md border border-line px-2 py-1.5 text-[13px] tabular text-ink-900 outline-none focus-field"
                  />
                  <input
                    value={n.label}
                    onChange={(e) => setNumber(i, { label: e.target.value })}
                    disabled={pending}
                    maxLength={40}
                    placeholder="Mobile"
                    aria-label={`Label for number ${i + 1}`}
                    className="w-[110px] shrink-0 rounded-md border border-line px-2 py-1.5 text-[12.5px] text-ink-700 outline-none focus-field"
                  />
                  {i === 0 ? (
                    <span className="shrink-0 rounded-md bg-brand-50 px-1.5 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-brand-700">
                      Primary
                    </span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove number ${i + 1}`}
                      disabled={pending}
                      onClick={() => removeNumber(i)}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-ink-400 transition-colors hover:bg-danger-bg hover:text-danger"
                    >
                      <Icon name="trash" size={12} />
                    </button>
                  )}
                </div>

                {/* What will actually be stored — or why it cannot be. */}
                {typed ? (
                  parsed.ok ? (
                    <p className="mt-1 flex items-center gap-1 text-[11.5px] text-ok tabular">
                      <Icon name="check" size={11} strokeWidth={2.5} />
                      Saved as {formatPhoneDisplay(parsed.e164)}
                    </p>
                  ) : (
                    <p className="mt-1 text-[11.5px] font-medium text-danger">
                      {parsed.reason === 'too_short'
                        ? 'Too short to be a phone number.'
                        : parsed.reason === 'too_long'
                          ? 'Too long to be a phone number.'
                          : 'Enter a phone number.'}
                    </p>
                  )
                ) : null}
              </div>
            );
          })}
        </div>

        {numbers.length < MAX_NUMBERS ? (
          <button
            type="button"
            disabled={pending}
            onClick={addNumber}
            className="mt-2 inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[12px] font-medium text-brand-700 transition-colors hover:bg-brand-50"
          >
            <Icon name="plus" size={11} />
            Add another number
          </button>
        ) : null}

        <p className="mt-1.5 text-[11.5px] leading-relaxed text-ink-400">
          Calls, texts and recordings for any of these numbers appear on this contact — including
          ones from before it existed.
        </p>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="c-email" className={label}>
            Email <span className="font-normal normal-case text-ink-300">optional</span>
          </label>
          <input
            id="c-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={pending}
            maxLength={200}
            placeholder="jane@cohenhardware.com"
            className={field}
          />
        </div>
        <div>
          <label htmlFor="c-notes" className={label}>
            Notes <span className="font-normal normal-case text-ink-300">optional</span>
          </label>
          <input
            id="c-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={pending}
            maxLength={2000}
            placeholder="Prefers texts after 4pm"
            className={field}
          />
        </div>
      </div>

      {error ? (
        <p role="alert" className="mt-3 flex items-start gap-1.5 text-[12px] text-danger">
          <Icon name="alert-triangle" size={12} className="mt-[2px] shrink-0" />
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={pending} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" icon="check" disabled={!canSave} onClick={save}>
          {pending ? 'Saving…' : contact ? 'Save changes' : 'Add contact'}
        </Button>
      </div>
    </div>
  );
}
