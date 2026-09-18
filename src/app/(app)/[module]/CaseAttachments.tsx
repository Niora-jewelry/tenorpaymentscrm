'use client';

/**
 * The attachment strip under a case's Issue, Solution or one reply —
 * Modules §3.7.
 *
 * "Files can be attached to the Issue, to the Solution, and to individual
 * replies. Standard file limits apply (up to 5 files per attachment point, 25MB
 * per file), stored and versioned like all files."
 *
 * ── ONE COMPONENT FOR ALL THREE POINTS ───────────────────────────────────
 * The three places differ only in which point they name. Everything else — the
 * five-file cap, the size ceiling, the download, the delete — is identical
 * because underneath they are the same `file_rows`/`files` pair the Files tab
 * uses. Three near-copies would be three places for the cap to drift.
 *
 * ── WHY IT SHOWS THE COUNT EVEN AT ZERO ──────────────────────────────────
 * It does not: an empty point renders only its Attach button, and only when the
 * viewer can edit. A row of "0 files" under every reply would be noise on the
 * common case, which is a thread with no attachments anywhere.
 *
 * ── DOWNLOADS GO THROUGH A SIGNED URL, NEVER A STORAGE PATH ──────────────
 * `getFileUrlAction` mints a 60-second signed URL server-side. The bucket is
 * private and the path alone opens nothing, so the click has to make a round
 * trip — which is why the button shows its own pending state rather than
 * behaving like an ordinary link.
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Spinner } from '@/proto/ui/kit';
import { Icon } from '@/proto/ui/icons';
import { attachToCaseAction, deleteFileAction, getFileUrlAction } from './actions';
import type { FileEntry } from '@/lib/records/files';

const MAX_PER_POINT = 5;

export function CaseAttachments({
  moduleSlug,
  caseId,
  point,
  replyId = null,
  files,
  editable,
}: {
  moduleSlug: string;
  caseId: string;
  point: 'issue' | 'solution' | 'reply';
  replyId?: string | null;
  files: FileEntry[];
  /** The Cases tab resolved to Edit. False leaves the list readable and takes
   *  away Attach and Remove — the matching refusals live in the data layer;
   *  this only stops an honest click from reaching one. */
  editable: boolean;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const full = files.length >= MAX_PER_POINT;

  const upload = (file: File) => {
    setError(null);
    const formData = new FormData();
    formData.set('file', file);
    startTransition(async () => {
      const result = await attachToCaseAction(moduleSlug, caseId, point, replyId, formData);
      if (!result.ok) setError(result.message ?? 'Could not attach that file.');
      else router.refresh();
      // The input keeps the chosen file otherwise, so picking the SAME file
      // again after a failure fires no change event and looks like a dead click.
      if (inputRef.current) inputRef.current.value = '';
    });
  };

  const remove = (fileId: string) => {
    setError(null);
    setBusyId(fileId);
    startTransition(async () => {
      try {
        await deleteFileAction(moduleSlug, fileId);
        router.refresh();
      } catch {
        setError('Could not remove that file.');
      } finally {
        setBusyId(null);
      }
    });
  };

  /**
   * ⚠ THE TAB IS OPENED BEFORE THE AWAIT, NOT AFTER.
   *
   * A browser only allows `window.open` while it can still see the user's
   * click. After an `await` that gesture is gone, so the popup is BLOCKED —
   * and blocked silently: no exception, so the `catch` below never fires and
   * the attachment simply never opens. `FilesPanel` and `StatementsPanel`
   * already did it this way; this one did not, so case attachments were the
   * one download in the CRM that quietly did nothing.
   *
   * So: open a blank tab on the click, point it at the signed URL when that
   * arrives, and close it again if the request fails rather than leaving a
   * stranded about:blank.
   */
  const download = (id: string) => {
    setBusyId(id);
    const tab = window.open('', '_blank', 'noopener,noreferrer');
    startTransition(async () => {
      try {
        const url = await getFileUrlAction(id);
        if (tab) tab.location.assign(url);
        // A blocked popup is the only way `tab` is null. Say so — the previous
        // behaviour was indistinguishable from a broken button.
        else setError('Your browser blocked the new tab. Allow pop-ups for this site to open attachments.');
      } catch {
        tab?.close();
        setError('Could not open that file.');
      } finally {
        setBusyId(null);
      }
    });
  };

  if (!files.length && !editable) return null;

  return (
    <div className="mt-1.5">
      {files.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f) => (
            <li
              key={f.id}
              className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line-soft bg-canvas/60 py-1 pl-2 pr-1.5 text-[11.5px]"
            >
              <Icon name="paperclip" size={11} className="shrink-0 text-ink-400" />
              <button
                type="button"
                onClick={() => download(f.id)}
                disabled={pending}
                title={`${f.name} — ${Math.max(1, Math.round(f.sizeBytes / 1024))} KB`}
                className="max-w-[180px] truncate font-medium text-ink-700 transition-colors hover:text-brand-700 hover:underline"
              >
                {f.name}
              </button>
              {busyId === f.id ? (
                <Spinner />
              ) : editable ? (
                <button
                  type="button"
                  onClick={() => remove(f.id)}
                  aria-label={`Remove ${f.name}`}
                  title="Remove"
                  className="grid size-4 shrink-0 place-items-center rounded text-ink-300 transition-colors hover:bg-white hover:text-[#b02a30]"
                >
                  <Icon name="x" size={10} strokeWidth={2.2} />
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {editable ? (
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) upload(file);
            }}
          />
          <button
            type="button"
            disabled={pending || full}
            onClick={() => inputRef.current?.click()}
            className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-brand-700 transition-colors hover:underline disabled:text-ink-300 disabled:no-underline"
          >
            {pending ? <Spinner /> : <Icon name="paperclip" size={11} />}
            {pending ? 'Attaching…' : full ? `${MAX_PER_POINT} files — the limit here` : 'Attach a file'}
          </button>
          {files.length && !full ? (
            <span className="text-[11px] text-ink-300">
              {files.length} of {MAX_PER_POINT}
            </span>
          ) : null}
        </div>
      ) : null}

      {error ? (
        <p className="mt-1 flex items-center gap-1.5 text-[11.5px] text-[#b02a30]">
          <Icon name="alert-triangle" size={11} />
          {error}
        </p>
      ) : null}
    </div>
  );
}
