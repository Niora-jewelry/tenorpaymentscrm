'use client';

/**
 * Files tab — same condensed row layout as `src/proto/ui/tabs.tsx`'s
 * `FilesTab`/`FileRowView` ("multiple files on one row, shrunk to name, not
 * a new row per file" — the client's own instruction), wired to real
 * Supabase Storage uploads instead of a static fixture list.
 */
import { useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/proto/ui/icons';
import { Button, CompletenessBadge, SectionLabel, Spinner } from '@/proto/ui/kit';
import {
  uploadFileAction,
  deleteFileAction,
  addFileRowAction,
  getFileUrlAction,
  getFileDownloadUrlAction,
} from './actions';
import type { FileRow, FileEntry } from '@/lib/records/files';
import { FLASH_CLASS, targetId, useFlashTarget } from './mentionTarget';

export function FilesPanel({
  moduleSlug,
  recordId,
  kind,
  rows,
  filesByRow,
  editable,
  focusRowId = null,
}: {
  moduleSlug: string;
  recordId: string;
  kind: 'application' | 'other';
  rows: FileRow[];
  filesByRow: Record<string, FileEntry[]>;
  editable: boolean;
  /** A row the drawer's search landed on: scroll to it and flash. */
  focusRowId?: string | null;
}) {
  const complete = rows.filter((r) => (filesByRow[r.id]?.length ?? 0) > 0).length;
  const [addingRow, setAddingRow] = useState(false);

  return (
    <div className="space-y-3">
      {kind === 'application' ? (
        <div className="flex flex-wrap items-center gap-3">
          <SectionLabel>Application documents</SectionLabel>
          <CompletenessBadge have={complete} need={rows.length} />
          <span className="text-[12px] text-ink-400">Locked rows — defined as a system structure</span>
        </div>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-[minmax(130px,.8fr)_2.4fr_minmax(130px,.9fr)] gap-3 border-b border-line-soft bg-canvas px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
          <span>File name</span>
          <span>File upload</span>
          <span>File notes</span>
        </div>
        {rows.length === 0 ? (
          <p className="px-3 py-6 text-center text-[12.5px] text-ink-400">No files in this section.</p>
        ) : (
          <div className="divide-y divide-[#f0f4f8]">
            {rows.map((r) => (
              <FileRowView
                key={r.id}
                moduleSlug={moduleSlug}
                recordId={recordId}
                row={r}
                files={filesByRow[r.id] ?? []}
                editable={editable}
                flash={focusRowId === r.id}
              />
            ))}
          </div>
        )}
      </div>

      {/*
        BOTH sections take a new row now. This was `kind === 'other'`, so the
        Application section was fixed at the five rows the system seeds and the
        client had no way to add the sixth they asked for.

        The seeded rows stay locked — they are the structure other people read
        — and a row added here is an ordinary unlocked one that happens to sit
        in the same list. See `addFileRow`.
      */}
      {editable ? (
        addingRow ? (
          <AddRowForm
            moduleSlug={moduleSlug}
            recordId={recordId}
            kind={kind}
            onDone={() => setAddingRow(false)}
          />
        ) : (
          <Button size="sm" variant="ghost" icon="plus" onClick={() => setAddingRow(true)}>
            Add another file row
          </Button>
        )
      ) : null}

      <p className="text-[11.5px] text-ink-400">
        Up to 5 files per row, 25MB each. Replacing a file keeps the previous version. Deleting a
        file is a soft delete to the Recycle Bin.
      </p>
    </div>
  );
}

function AddRowForm({
  moduleSlug,
  recordId,
  kind,
  onDone,
}: {
  moduleSlug: string;
  recordId: string;
  kind: 'application' | 'other';
  onDone: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    if (!name.trim()) return;
    const formData = new FormData();
    formData.set('name', name.trim());
    formData.set('kind', kind);
    startTransition(async () => {
      /*
       * `addFileRowAction` returns void and throws on refusal
       * (`requireTabEdit`). Unguarded, the throw skipped both `router.refresh`
       * and `onDone`, so the form stayed open with the typed name still in it
       * and nothing said why — which looks like the Add button not working.
       */
      try {
        setError(null);
        await addFileRowAction(moduleSlug, recordId, formData);
        router.refresh();
        onDone();
      } catch {
        setError('Could not add that row.');
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
          if (e.key === 'Escape') onDone();
        }}
        placeholder="Row name…"
        disabled={pending}
        className="w-56 rounded-lg border border-line px-2.5 py-1.5 text-[13px] text-ink-900 outline-none focus:border-brand-400"
      />
      <Button size="sm" variant="primary" loading={pending} loadingLabel="Saving…" disabled={!name.trim()} onClick={submit}>
        Add
      </Button>
      <Button size="sm" variant="ghost" disabled={pending} onClick={onDone}>
        Cancel
      </Button>
      {error ? (
        <p role="alert" className="text-[11.5px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function FileRowView({
  moduleSlug,
  recordId,
  row,
  files,
  editable,
  flash,
}: {
  moduleSlug: string;
  recordId: string;
  row: FileRow;
  files: FileEntry[];
  editable: boolean;
  flash: boolean;
}) {
  const flashing = useFlashTarget(targetId.field(row.id), flash);
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  /* Its own flag, not `pending`: that one is also true while a DELETE runs,
     and labelling a delete "Uploading…" is worse than labelling it nothing. */
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  /**
   * Mint a short-lived signed URL and open it in a new tab.
   *
   * `window.open` is called BEFORE the await deliberately: a popup opened
   * inside an async continuation has lost the user-gesture context and every
   * browser blocks it. The blank tab is opened synchronously on the click and
   * then pointed at the URL once it arrives — and closed again if the request
   * fails, rather than being left as a stranded about:blank.
   *
   * ⚠️ NO FEATURES STRING, AND THAT IS THE WHOLE BUG THIS FIXES.
   *
   * This read `window.open('', '_blank', 'noopener,noreferrer')`. Passing
   * `noopener` in the FEATURES argument makes `window.open` return **null by
   * specification** — the opener link is what the handle is, so asking for no
   * opener is asking for no handle. The return value was therefore null on
   * every click, in every browser, and the code read that as "the popup was
   * blocked".
   *
   * So the tab opened and the message said it had been blocked, which is why
   * allowing pop-ups changed nothing: nothing was ever blocking them.
   *
   * The opener is still severed, just on the handle instead of through the
   * features string — and `Cross-Origin-Opener-Policy: same-origin` in
   * `next.config.ts` already severs it at the browser level for good measure.
   */
  const openFile = async (fileId: string) => {
    setError(null);
    setOpening(fileId);
    const tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    try {
      const url = await getFileUrlAction(fileId);
      if (tab) tab.location.assign(url);
      // Now a genuine popup block is the only way `tab` is null, so the
      // message is finally true when it appears. Navigating this tab instead
      // would throw away whatever the user has half-typed in the drawer, so
      // it says what happened rather than deciding for them.
      else setError('Your browser blocked the new tab. Allow pop-ups for this site to open files.');
    } catch {
      tab?.close();
      setError('Could not open that file. It may have been removed.');
    } finally {
      setOpening(null);
    }
  };

  /**
   * Save the file, as itself.
   *
   * No tab and no popup: the signed URL carries `Content-Disposition:
   * attachment` with the file's original name, so assigning it to a hidden
   * anchor downloads without navigating away from the drawer. Nothing here
   * can be popup-blocked, which is the point — opening was the fragile path
   * and saving is the one people actually asked for.
   */
  const downloadFile = async (fileId: string) => {
    setError(null);
    setSaving(fileId);
    try {
      const url = await getFileDownloadUrlAction(fileId);
      const a = document.createElement('a');
      a.href = url;
      /* The header names the file; this only has to not fight it. */
      a.download = '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setError('Could not download that file. It may have been removed.');
    } finally {
      setSaving(null);
    }
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    const formData = new FormData();
    formData.set('file', file);
    startTransition(async () => {
      try {
        const result = await uploadFileAction(moduleSlug, recordId, row.id, row.kind, formData);
        if (!result.ok) setError(result.message ?? 'Upload failed.');
        else router.refresh();
      } finally {
        /* In a finally so a thrown action cannot leave the control spinning
           for the rest of the session with no way back. */
        setUploading(false);
        if (inputRef.current) inputRef.current.value = '';
      }
    });
  };

  const remove = (fileId: string) => {
    startTransition(async () => {
      /*
       * Wrapped because these actions return void and THROW on refusal —
       * `requireTabEdit` raises for a viewer without Edit on this tab. Left
       * unguarded, the click did nothing at all: the throw skipped
       * `router.refresh()`, the row stayed on screen, and no message appeared.
       * A delete that silently does nothing is indistinguishable from a broken
       * button.
       */
      try {
        setError(null);
        await deleteFileAction(moduleSlug, fileId);
        router.refresh();
      } catch {
        setError('Could not delete that file.');
      }
    });
  };

  return (
    <div id={targetId.field(row.id)} className={`grid grid-cols-[minmax(130px,.8fr)_2.4fr_minmax(130px,.9fr)] items-start gap-3 px-3 py-2 ${flashing ? `relative z-10 ${FLASH_CLASS}` : ''}`}>
      <div className="flex flex-wrap items-center gap-1.5 pt-1">
        <span className="text-[13px] font-medium text-ink-900">{row.name}</span>
        {row.locked ? <Icon name="lock" size={10} className="text-ink-400" /> : null}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {files.map((file) => (
            <span
              key={file.id}
              title={`${file.name} · v${file.version}`}
              className="group inline-flex max-w-[220px] items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-[3px] text-[11.5px] transition-colors hover:border-ink-400 hover:bg-white"
            >
              <Icon name="file-text" size={11} className="text-ink-400 shrink-0" />
              {/*
                Opening an uploaded file was simply not wired: every file
                rendered as dead text, and the ONLY thing anyone could do with
                one was delete it. `getFileUrlAction` and the whole signed-URL
                path already existed and worked — nothing called them.

                The URL is minted on click rather than up front: a signed URL
                lasts 60 seconds, so one created at render time is expired
                before most people click it, and pre-signing every file on
                every drawer open would be a storage round trip per file for
                links nobody may use.
              */}
              <button
                type="button"
                title={`Open ${file.name}`}
                disabled={opening === file.id}
                onClick={() => openFile(file.id)}
                className="truncate text-left text-ink-700 underline decoration-line underline-offset-2 transition-colors hover:text-brand-700 hover:decoration-brand-600 disabled:opacity-60"
              >
                {opening === file.id ? 'Opening…' : file.name}
              </button>
              {file.version > 1 ? (
                <span className="shrink-0 rounded bg-white px-1 text-[10px] font-semibold text-ink-500">
                  v{file.version}
                </span>
              ) : null}
              {/*
                Download is available to anyone who can SEE the file, not only
                to an editor — reading a document is not an edit, and the
                grant underneath is the Files (or Cases) tab's View. It sits
                outside the `editable` branch below for that reason.
              */}
              <button
                type="button"
                title={`Download ${file.name}`}
                aria-label={`Download ${file.name}`}
                disabled={saving === file.id}
                onClick={() => downloadFile(file.id)}
                className="shrink-0 rounded text-ink-400 transition-colors hover:text-brand-700 disabled:opacity-60"
              >
                {saving === file.id ? (
                  <span className="inline-block text-[11px] leading-none">
                    <Spinner />
                  </span>
                ) : (
                  <Icon name="download" size={11} />
                )}
              </button>
              {editable ? (
                <button
                  type="button"
                  title="Delete"
                  disabled={pending}
                  onClick={() => remove(file.id)}
                  className="shrink-0 rounded text-ink-400 opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger disabled:opacity-60"
                >
                  <Icon name="x" size={10} />
                </button>
              ) : null}
            </span>
          ))}
          {editable && files.length < 5 ? (
            /*
              An upload is a round trip through a Server Action with the bytes
              in the body, so it is the slowest thing on this tab by a wide
              margin — and it showed nothing at all while it ran. The control
              simply sat there, so the natural thing to do was click it again.
              `pending` was already tracked and nothing rendered it.
            */
            <label
              title={uploading ? 'Uploading…' : `${files.length} of 5 files`}
              aria-busy={uploading}
              className={`inline-flex items-center gap-1 rounded-md border border-dashed px-1.5 py-[3px] text-[11.5px] font-semibold transition-colors ${
                uploading
                  ? 'cursor-progress border-brand-600 bg-brand-50 text-brand-700'
                  : 'cursor-pointer border-line text-brand-700 hover:border-brand-600 hover:bg-brand-50'
              }`}
            >
              {uploading ? (
                <>
                  <span className="inline-block text-[10px] leading-none">
                    <Spinner />
                  </span>
                  Uploading…
                </>
              ) : (
                <>
                  <Icon name="plus" size={10} />
                  {files.length}/5
                </>
              )}
              <input
                ref={inputRef}
                type="file"
                className="hidden"
                /* Disabled while one is in flight, so a second pick cannot
                   race the first and leave the row showing the wrong count. */
                disabled={pending}
                onChange={(e) => upload(e.target.files?.[0])}
              />
            </label>
          ) : null}
          {!editable && files.length === 0 ? <span className="text-ink-400/70">—</span> : null}
        </div>
        {error ? <p className="text-[11px] text-danger">{error}</p> : null}
      </div>

      <p className="pt-1 text-[12px] leading-snug text-ink-500">
        {row.note ?? <span className="text-ink-400/70">—</span>}
      </p>
    </div>
  );
}
