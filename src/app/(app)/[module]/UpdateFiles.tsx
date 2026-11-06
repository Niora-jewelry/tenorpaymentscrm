'use client';

/**
 * Under an Update: its files, each one click from opening. Pictures show as a
 * small preview once opened; the list itself stays light (a signed link per file
 * is only made when someone asks for it).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Spinner } from '@/proto/ui/kit';
import { deleteFileAction, getFileUrlAction } from './actions';
import type { FileEntry } from '@/lib/records/files';

export const formatSize = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function UpdateFiles({ moduleSlug, files, canRemove }: { moduleSlug: string; files: FileEntry[]; canRemove: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!files.length) return null;

  /* The tab opens on the click: a browser blocks one opened after an await. */
  const open = (id: string) => {
    setBusy(id);
    setError(null);
    // Not `noopener`: with it the browser returns null, and the tab could never be
    // pointed at the file. The opener is cut by hand instead.
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    start(async () => {
      try {
        const url = await getFileUrlAction(id);
        if (tab) tab.location.assign(url);
        else setError('Your browser blocked the new tab. Allow pop-ups for this site to open files.');
      } catch {
        tab?.close();
        setError('Could not open that file.');
      } finally {
        setBusy(null);
      }
    });
  };

  const remove = (id: string) => {
    setBusy(id);
    setError(null);
    start(async () => {
      try {
        await deleteFileAction(moduleSlug, id);
        router.refresh();
      } catch {
        setError('Could not remove that file.');
      } finally {
        setBusy(null);
      }
    });
  };

  return (
    <div className="mt-2">
      <ul className="flex flex-wrap gap-1.5">
        {files.map((f) => (
          <li key={f.id} className="inline-flex max-w-full items-center rounded-lg border border-line bg-canvas/60 text-[12.5px]">
            <button
              type="button"
              disabled={pending}
              title={`Open ${f.name}`}
              onClick={() => open(f.id)}
              className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 px-2 py-1 text-brand-700 hover:underline disabled:cursor-wait"
            >
              {busy === f.id ? <Spinner /> : <Icon name="paperclip" size={12} className="shrink-0 text-ink-400" />}
              <span className="min-w-0 truncate">{f.name}</span>
              <span className="shrink-0 text-[11px] text-ink-400">{formatSize(f.sizeBytes)}</span>
            </button>
            {canRemove ? (
              <button
                type="button"
                disabled={pending}
                aria-label={`Remove ${f.name}`}
                title="Remove this file"
                onClick={() => remove(f.id)}
                className="grid size-6 cursor-pointer place-items-center rounded-r-lg text-ink-400 hover:bg-white hover:text-ink-900 disabled:cursor-wait"
              >
                <Icon name="x" size={11} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="mt-1 text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
