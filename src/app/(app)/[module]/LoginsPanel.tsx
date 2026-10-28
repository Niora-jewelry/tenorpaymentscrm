'use client';

/**
 * Logins tab — same layout as `src/proto/ui/tabs.tsx`'s `LoginsTab`/
 * `CredentialRow`, wired to real envelope-encrypted passwords
 * (`lib/records/logins.ts` → `store_login_password`/`reveal_password`).
 * The password never lands in this component's state until the user clicks
 * reveal, and every reveal is server-audited before the plaintext comes back.
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, IconButton, SpecNote } from '@/proto/ui/kit';
import { addLoginAction, revealPasswordAction } from './actions';
import type { LoginRow } from '@/lib/records/logins';

export function LoginsPanel({
  moduleSlug,
  recordId,
  logins,
  editable,
}: {
  moduleSlug: string;
  recordId: string;
  logins: LoginRow[];
  editable: boolean;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <div className="space-y-3">
      <SpecNote>
        Passwords are stored with <strong>envelope encryption</strong> and are never recoverable by
        reading the database. Every reveal is written to the audit log with user, credential and
        timestamp. Credentials are excluded from every export and reporting surface.
      </SpecNote>

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-[1fr_1.4fr_1.4fr_1.1fr_1fr] gap-3 border-b border-line-soft bg-canvas px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
          <span>Login type</span>
          <span>Login link</span>
          <span>Login user</span>
          <span>Login pass</span>
          <span>Login notes</span>
        </div>
        {logins.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-ink-400">
            No credentials stored on this record.
          </p>
        ) : (
          <div className="divide-y divide-[#f0f4f8]">
            {logins.map((row) => (
              <CredentialRow key={row.id} row={row} />
            ))}
          </div>
        )}
      </div>

      {editable ? (
        adding ? (
          <AddLoginForm moduleSlug={moduleSlug} recordId={recordId} onDone={() => setAdding(false)} />
        ) : (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setAdding(true)}>
            Add a login
          </Button>
        )
      ) : null}
    </div>
  );
}

function CredentialRow({ row }: { row: LoginRow }) {
  const [pending, startTransition] = useTransition();
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /*
   * A SENTENCE, not a boolean.
   *
   * This was `useState(false)` rendering the single word "Failed" in place of
   * the note — so a revealed-password refusal and a clipboard rejection looked
   * identical, and neither said what to do. On a credential that matters: one
   * means "you are not allowed to see this", the other means "it is on your
   * screen but not on your clipboard", and pasting after the second gets you
   * whatever was there before.
   */
  const [error, setError] = useState<string | null>(null);

  const reveal = () => {
    if (revealed) {
      setRevealed(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await revealPasswordAction(row.id);
      if (result.ok && result.password != null) setRevealed(result.password);
      else setError('Could not reveal — you may not have permission.');
    });
  };

  const copy = () => {
    startTransition(async () => {
      // Every copy is its own logged event — even of a password already shown.
      const result = await revealPasswordAction(row.id, 'copy');
      if (result.ok && result.password != null) {
        /*
         * ⚠ AWAITED, AND ONLY THEN REPORTED AS COPIED.
         *
         * `void navigator.clipboard?.writeText(...)` swallows the rejection,
         * so the UI said "Copied" whether or not anything reached the
         * clipboard. For a PASSWORD that is the worst possible lie: the user
         * pastes with confidence and gets silence, or worse, whatever was
         * there before.
         *
         * It rejects more often than you would think — a non-secure context, a
         * browser clipboard policy, or the document not being focused are all
         * enough.
         */
        try {
          await navigator.clipboard.writeText(result.password);
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        } catch {
          setError('Shown, but the browser blocked the copy. Select it and copy manually.');
        }
      } else {
        setError('Could not reveal — you may not have permission.');
      }
    });
  };

  return (
    <div className="grid grid-cols-[1fr_1.4fr_1.4fr_1.1fr_1fr] items-center gap-3 px-3 py-2 text-[13px]">
      <span className="flex items-center gap-1.5 font-medium text-ink-900">
        <Icon name="key" size={12} className="text-ink-400" />
        {row.loginType}
      </span>
      {row.link ? (
        <a
          href={row.link}
          target="_blank"
          rel="noreferrer"
          className="inline-flex min-w-0 items-center gap-1 text-brand-700 hover:underline"
        >
          <span className="truncate">{row.link.replace(/^https:\/\//, '')}</span>
          <Icon name="external-link" size={10} className="shrink-0 opacity-60" />
        </a>
      ) : (
        <span className="text-ink-400/70">—</span>
      )}
      <span className="truncate text-ink-700">{row.username ?? <span className="text-ink-400/70">—</span>}</span>
      <span className="flex items-center gap-1">
        <span className="font-mono text-[12px] tabular">{revealed ? revealed : '••••••••'}</span>
        <IconButton
          icon={revealed ? 'eye-off' : 'eye'}
          size={22}
          title={revealed ? 'Hide password' : 'Reveal password — this is audit-logged'}
          onClick={reveal}
        />
        <IconButton icon={copied ? 'check' : 'copy'} size={22} title="Copy without revealing" onClick={copy} />
      </span>
      <span className="truncate text-[12px] text-ink-500">
        {error ? (
          <span role="alert" className="text-[11.5px] text-danger">
            {error}
          </span>
        ) : (
          row.note ?? <span className="text-ink-400/70">—</span>
        )}
      </span>
      {pending ? null : null}
    </div>
  );
}

function AddLoginForm({
  moduleSlug,
  recordId,
  onDone,
}: {
  moduleSlug: string;
  recordId: string;
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const submit = (formData: FormData) => {
    setError(null);
    startTransition(async () => {
      const result = await addLoginAction(moduleSlug, recordId, { ok: true }, formData);
      if (!result.ok) {
        setError(result.message ?? 'Could not add login.');
        return;
      }
      router.refresh();
      onDone();
    });
  };

  return (
    <form action={submit} className="grid grid-cols-2 gap-2 rounded-lg border border-line bg-canvas/50 p-3">
      <input
        name="loginType"
        placeholder="Login type (e.g. Gateway)"
        required
        disabled={pending}
        className="rounded-lg border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-400"
      />
      <input
        name="link"
        placeholder="Link"
        disabled={pending}
        className="rounded-lg border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-400"
      />
      <input
        name="username"
        placeholder="Username"
        disabled={pending}
        className="rounded-lg border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-400"
      />
      <input
        name="password"
        type="password"
        placeholder="Password"
        disabled={pending}
        className="rounded-lg border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-400"
      />
      <input
        name="note"
        placeholder="Notes"
        disabled={pending}
        className="col-span-2 rounded-lg border border-line px-2.5 py-1.5 text-[13px] outline-none focus:border-brand-400"
      />
      {error ? <p className="col-span-2 text-[11.5px] text-danger">{error}</p> : null}
      <div className="col-span-2 flex items-center gap-2">
        <Button size="sm" variant="primary" type="submit" loading={pending} loadingLabel="Saving…">
          Add login
        </Button>
        <Button size="sm" variant="ghost" type="button" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
