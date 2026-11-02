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
  getFileVersionUrlAction,
  fileVersionsAction,
  setFileRowRequiredAction,
  renameFileRowAction,
  deleteFileRowAction,
  moveFileAction,
  replaceFileAction,
} from './actions';
import type { FileRow, FileEntry, FileRowForAdding, FileVersion } from '@/lib/records/files';
import { FLASH_CLASS, targetId, useFlashTarget } from './mentionTarget';
import { SavedNotice } from './SavedNotice';
import { RestrictionMarks, useDownloadAllowed, useRestrictions } from './Restrictions';

/**
 * The Files tab on Add only: row names, an upload on each, and Add another file
 * row. A file sent here leaves the viewer's sight at once, so the row shows only
 * the check a preset row gets once it holds something.
 */
export function AddOnlyFilesPanel({
  moduleSlug,
  recordId,
  rows,
  focusRowId = null,
}: {
  moduleSlug: string;
  recordId: string;
  rows: FileRowForAdding[];
  focusRowId?: string | null;
}) {
  const [addingRow, setAddingRow] = useState(false);
  const [saved, setSaved] = useState(0);

  return (
    <div className="space-y-3">
      {saved ? <SavedNotice key={saved} /> : null}

      <div className="overflow-hidden rounded-xl border border-line bg-white">
        <div className="grid grid-cols-[1fr_auto] gap-3 border-b border-line-soft bg-canvas px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400">
          <span>File name</span>
          <span>File upload</span>
        </div>
        <div className="divide-y divide-[#f0f4f8]">
          {rows.map((r) => (
            <AddOnlyFileRow key={r.id} moduleSlug={moduleSlug} recordId={recordId} row={r} flash={focusRowId === r.id} onSaved={() => setSaved((n) => n + 1)} />
          ))}
        </div>
      </div>

      {addingRow ? (
        <AddRowForm moduleSlug={moduleSlug} recordId={recordId} kind="application" onDone={() => setAddingRow(false)} />
      ) : (
        <Button size="sm" variant="ghost" icon="plus" onClick={() => setAddingRow(true)}>
          Add another file row
        </Button>
      )}

      <p className="text-[11.5px] text-ink-400">Up to 25MB each.</p>
    </div>
  );
}

function AddOnlyFileRow({
  moduleSlug,
  recordId,
  row,
  flash,
  onSaved,
}: {
  moduleSlug: string;
  recordId: string;
  row: FileRowForAdding;
  flash: boolean;
  onSaved: () => void;
}) {
  const flashing = useFlashTarget(targetId.field(row.id), flash);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUploading(true);
    const formData = new FormData();
    formData.set('file', file);
    try {
      const result = await uploadFileAction(moduleSlug, recordId, row.id, row.kind, formData);
      if (!result.ok) {
        setError(result.message ?? 'Upload failed.');
        return;
      }
      onSaved();
    } catch {
      setError('Could not upload that file.');
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div id={targetId.field(row.id)} className={`grid grid-cols-[1fr_auto] items-center gap-3 px-3 py-2 ${flashing ? `relative z-10 ${FLASH_CLASS}` : ''}`}>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[13px] font-medium text-ink-900">{row.name}</span>
          {row.hasFile ? (
            <span title="This row has a file" className="grid size-4 shrink-0 place-items-center rounded-full bg-[#e3f4ea] text-[#1b7a45]">
              <Icon name="check" size={10} aria-label="This row has a file" />
            </span>
          ) : null}
        </div>
        {error ? <p role="alert" className="mt-0.5 text-[11px] text-danger">{error}</p> : null}
      </div>
      <label
        aria-busy={uploading}
        className={`inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-[11.5px] font-semibold transition-colors ${
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
            Upload
          </>
        )}
        <input
          ref={inputRef}
          type="file"
          aria-label={`Upload to ${row.name}`}
          className="hidden"
          disabled={uploading}
          onChange={(e) => void upload(e.target.files?.[0])}
        />
      </label>
    </div>
  );
}

/** Marks a drag as one of our files, so a row isn't a target for anything else. */
const FILE_DRAG = 'application/x-tapdash-file';
const GRID = 'grid grid-cols-[minmax(130px,.8fr)_2.2fr_minmax(150px,auto)_minmax(100px,.7fr)] gap-3';
const CHIP_ACTION = 'shrink-0 rounded text-ink-400 opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 disabled:opacity-60';

export function FilesPanel({
  moduleSlug,
  recordId,
  kind,
  rows,
  filesByRow,
  editable,
  canAdd = editable,
  hiddenRows = [],
  canMark,
  focusRowId = null,
}: {
  moduleSlug: string;
  recordId: string;
  kind: 'application' | 'other';
  rows: FileRow[];
  filesByRow: Record<string, FileEntry[]>;
  editable: boolean;
  /** Mark files required: its own permission, apart from `editable`. */
  canMark: boolean;
  /** Adding files and rows, which a lock leaves open (spec). */
  canAdd?: boolean;
  /** Rows an automation hid from this viewer: named, so they can still add to them. */
  hiddenRows?: FileRowForAdding[];
  /** A row the drawer's search landed on: scroll to it and flash. */
  focusRowId?: string | null;
}) {
  const complete = rows.filter((r) => (filesByRow[r.id]?.length ?? 0) > 0).length;
  const [addingRow, setAddingRow] = useState(false);
  const [saved, setSaved] = useState(0);
  const { effects } = useRestrictions();
  const rowLocked = (id: string) => effects[`row:${id}`] === 'lock';

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
        <div className={`${GRID} border-b border-line-soft bg-canvas px-3 py-2 text-[11px] font-semibold uppercase tracking-[.05em] text-ink-400`}>
          <span>File name</span>
          <span>File upload</span>
          <span>Required</span>
          <span>File notes</span>
        </div>
        {rows.length === 0 && hiddenRows.length === 0 ? (
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
                editable={editable && !rowLocked(r.id)}
                canAdd={canAdd}
                canMark={canMark}
                otherRows={rows.filter((x) => x.id !== r.id && !rowLocked(x.id))}
                flash={focusRowId === r.id}
              />
            ))}
            {hiddenRows.map((r) => (
              <AddOnlyFileRow key={r.id} moduleSlug={moduleSlug} recordId={recordId} row={r} flash={focusRowId === r.id} onSaved={() => setSaved((n) => n + 1)} />
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
      {saved ? <SavedNotice key={saved} /> : null}
      {canAdd ? (
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
      try {
        setError(null);
        const result = await addFileRowAction(moduleSlug, recordId, formData);
        if (!result.ok) {
          setError(result.message ?? 'Could not add that row.');
          return;
        }
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

/** Required, how many, and how far along. Kept per row so a tick shows at once. */
function RequiredCell({ moduleSlug, row, have, canMark }: { moduleSlug: string; row: FileRow; have: number; canMark: boolean }) {
  const [saving, setSaving] = useState(false);
  const [required, setRequired] = useState(row.required);
  const [needed, setNeeded] = useState(row.filesNeeded);
  const [error, setError] = useState<string | null>(null);

  /* Not a transition: that would hold these controls until the whole drawer had
     re-rendered, long after the save itself was done. The action's response
     brings the new page, so this asks for no second one. */
  const save = async (nextRequired: boolean, nextNeeded: number) => {
    setRequired(nextRequired);
    setNeeded(nextNeeded);
    setError(null);
    setSaving(true);
    const result = await setFileRowRequiredAction(moduleSlug, { rowId: row.id, required: nextRequired, needed: nextNeeded }).catch(() => ({ ok: false, message: undefined }));
    setSaving(false);
    if (!result.ok) {
      setRequired(row.required);
      setNeeded(row.filesNeeded);
      setError(result.message ?? 'Could not change that row.');
    }
  };

  return (
    <div className="flex min-h-[30px] flex-col justify-center gap-0.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <input
          type="checkbox"
          aria-label={`${row.name} is required`}
          checked={required}
          disabled={!canMark || saving}
          onChange={(e) => void save(e.target.checked, needed)}
          className="size-3.5 accent-[#1d4ed8] disabled:opacity-60"
        />
        {required ? (
          <>
            <input
              type="number"
              min={1}
              max={5}
              aria-label={`Files needed on ${row.name}`}
              value={needed}
              disabled={!canMark}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 5) void save(true, n);
              }}
              className="w-10 rounded-md border border-line px-1 py-0.5 text-center text-[12px] text-ink-900 outline-none focus:border-brand-400 disabled:bg-canvas disabled:text-ink-500"
            />
            <span className="whitespace-nowrap text-[11.5px] text-ink-500">{have} of {needed}</span>
            {row.received ? (
              <span className="rounded-md bg-[#e3f4ea] px-1.5 py-[1px] text-[11px] font-semibold text-[#1b7a45]">Received</span>
            ) : null}
          </>
        ) : null}
      </div>
      {error ? <p role="alert" className="text-[11px] text-danger">{error}</p> : null}
    </div>
  );
}

function FileRowView({
  moduleSlug,
  recordId,
  row,
  files,
  editable,
  canAdd,
  canMark,
  otherRows,
  flash,
}: {
  moduleSlug: string;
  recordId: string;
  row: FileRow;
  files: FileEntry[];
  editable: boolean;
  canAdd: boolean;
  canMark: boolean;
  otherRows: FileRow[];
  flash: boolean;
}) {
  const flashing = useFlashTarget(targetId.field(row.id), flash);
  const canDownload = useDownloadAllowed([`row:${row.id}`, 'tab:files']);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dropping, setDropping] = useState(false);
  const [moving, setMoving] = useState<FileEntry | null>(null);
  const [moveTo, setMoveTo] = useState('');
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [versions, setVersions] = useState<{ fileId: string; list: FileVersion[] } | null>(null);
  const replaceInput = useRef<HTMLInputElement>(null);
  const replacing = useRef<string | null>(null);
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
    const formData = new FormData();
    formData.set('file', file);
    setUploading(true);
    void run(() => uploadFileAction(moduleSlug, recordId, row.id, row.kind, formData), 'Upload failed.').finally(() => {
      /* In a finally so a thrown action cannot leave the control spinning for the
         rest of the session with no way back. */
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    });
  };

  /* Not a transition, for the reason `RequiredCell` gives. */
  const run = async (act: () => Promise<{ ok: boolean; message?: string }>, fallback: string, done?: () => void) => {
    setError(null);
    setBusy(true);
    try {
      const result = await act();
      if (!result.ok) {
        setError(result.message ?? fallback);
        return;
      }
      done?.();
    } catch {
      setError(fallback);
    } finally {
      setBusy(false);
    }
  };

  const move = (fileId: string, toRowId: string) =>
    void run(() => moveFileAction(moduleSlug, { fileId, toRowId }), 'Could not move that file.', () => {
      setMoving(null);
      setMoveTo('');
    });

  const replace = (file: File | undefined) => {
    const fileId = replacing.current;
    if (!file || !fileId) return;
    const formData = new FormData();
    formData.set('file', file);
    void run(() => replaceFileAction(moduleSlug, fileId, formData), 'Could not replace that file.');
    if (replaceInput.current) replaceInput.current.value = '';
  };

  const showVersions = (fileId: string) => {
    if (versions?.fileId === fileId) {
      setVersions(null);
      return;
    }
    void fileVersionsAction(fileId)
      .then((list) => setVersions({ fileId, list }))
      .catch(() => setError('Could not load the earlier versions.'));
  };

  const downloadVersion = async (versionId: string) => {
    setError(null);
    try {
      const a = document.createElement('a');
      a.href = await getFileVersionUrlAction(versionId);
      a.download = '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      setError('Could not download that version.');
    }
  };

  const remove = (fileId: string) =>
    void run(async () => {
      await deleteFileAction(moduleSlug, fileId);
      return { ok: true };
    }, 'Could not delete that file.');

  return (
    <div
      id={targetId.field(row.id)}
      onDragOver={(e) => {
        if (!editable || !e.dataTransfer.types.includes(FILE_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDropping(true);
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(e) => {
        const fileId = e.dataTransfer.getData(FILE_DRAG);
        setDropping(false);
        if (!editable || !fileId) return;
        e.preventDefault();
        if (!files.some((f) => f.id === fileId)) move(fileId, row.id);
      }}
      className={`group/row ${GRID} items-start px-3 py-2 transition-colors ${dropping ? 'bg-brand-50 ring-2 ring-inset ring-brand-400' : ''} ${flashing ? `relative z-10 ${FLASH_CLASS}` : ''}`}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-1">
        {renaming !== null ? (
          <input
            autoFocus
            value={renaming}
            aria-label="Row name"
            disabled={busy}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setRenaming(null);
              if (e.key === 'Enter' && renaming.trim()) {
                void run(() => renameFileRowAction(moduleSlug, { rowId: row.id, name: renaming.trim() }), 'Could not rename that row.', () => setRenaming(null));
              }
            }}
            onBlur={() => setRenaming(null)}
            className="w-full rounded-md border border-line px-1.5 py-0.5 text-[13px] text-ink-900 outline-none focus:border-brand-400"
          />
        ) : (
          <span className="text-[13px] font-medium text-ink-900">{row.name}</span>
        )}
        {row.locked ? <Icon name="lock" size={10} className="text-ink-400" /> : null}
        <RestrictionMarks item={`row:${row.id}`} />
        {editable && !row.locked && renaming === null ? (
          <span className="flex items-center gap-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover/row:opacity-100">
            <button type="button" title={`Rename ${row.name}`} aria-label={`Rename ${row.name}`} onClick={() => setRenaming(row.name)} className="rounded text-ink-400 hover:text-brand-700">
              <Icon name="pencil" size={11} />
            </button>
            <button type="button" title={`Delete ${row.name}`} aria-label={`Delete ${row.name}`} onClick={() => setConfirmingDelete(true)} className="rounded text-ink-400 hover:text-danger">
              <Icon name="trash" size={11} />
            </button>
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {files.map((file) => (
            <span
              key={file.id}
              title={`${file.name} · v${file.version}`}
              draggable={editable}
              onDragStart={(e) => {
                e.dataTransfer.setData(FILE_DRAG, file.id);
                e.dataTransfer.effectAllowed = 'move';
              }}
              className={`group inline-flex max-w-[260px] items-center gap-1 rounded-md border border-line bg-canvas px-1.5 py-[3px] text-[11.5px] transition-colors hover:border-ink-400 hover:bg-white ${editable ? 'cursor-grab active:cursor-grabbing' : ''}`}
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
                title={canDownload ? `Open ${file.name}` : 'Download is off for this row'}
                disabled={opening === file.id || !canDownload}
                onClick={() => openFile(file.id)}
                className="truncate text-left text-ink-700 underline decoration-line underline-offset-2 transition-colors hover:text-brand-700 hover:decoration-brand-600 disabled:opacity-60"
              >
                {opening === file.id ? 'Opening…' : file.name}
              </button>
              {file.version > 1 && canDownload ? (
                <button
                  type="button"
                  title="Earlier versions"
                  aria-expanded={versions?.fileId === file.id}
                  onClick={() => showVersions(file.id)}
                  className="shrink-0 rounded bg-white px-1 text-[10px] font-semibold text-ink-500 hover:text-brand-700"
                >
                  v{file.version}
                </button>
              ) : null}
              {/*
                Download is available to anyone who can SEE the file, not only
                to an editor — reading a document is not an edit, and the
                grant underneath is the Files (or Cases) tab's View. It sits
                outside the `editable` branch below for that reason.
              */}
              {canDownload ? <button
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
              </button> : null}
              {editable && otherRows.length ? (
                <button
                  type="button"
                  title={`Move ${file.name}`}
                  aria-label={`Move ${file.name}`}
                  disabled={busy}
                  onClick={() => setMoving(file)}
                  className={`${CHIP_ACTION} hover:text-brand-700`}
                >
                  <Icon name="arrow-right" size={11} />
                </button>
              ) : null}
              {editable ? (
                <button
                  type="button"
                  title={`Replace ${file.name}`}
                  aria-label={`Replace ${file.name}`}
                  disabled={busy}
                  onClick={() => {
                    replacing.current = file.id;
                    replaceInput.current?.click();
                  }}
                  className={`${CHIP_ACTION} hover:text-brand-700`}
                >
                  <Icon name="refresh-cw" size={10} />
                </button>
              ) : null}
              {editable ? (
                <button
                  type="button"
                  title="Delete"
                  disabled={busy}
                  onClick={() => remove(file.id)}
                  className={`${CHIP_ACTION} hover:text-danger`}
                >
                  <Icon name="x" size={10} />
                </button>
              ) : null}
            </span>
          ))}
          {canAdd && files.length < 5 ? (
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
                aria-label={`Upload to ${row.name}`}
                className="hidden"
                /* Disabled while one is in flight, so a second pick cannot
                   race the first and leave the row showing the wrong count. */
                disabled={busy}
                onChange={(e) => upload(e.target.files?.[0])}
              />
            </label>
          ) : null}
          {!editable && files.length === 0 ? <span className="text-ink-400/70">—</span> : null}
        </div>
        {editable ? <input ref={replaceInput} type="file" aria-label={`Replace a file on ${row.name}`} className="hidden" onChange={(e) => replace(e.target.files?.[0])} /> : null}
        {moving ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas/60 px-2 py-1.5">
            <span className="min-w-0 truncate text-[12px] text-ink-700">Move {moving.name} to</span>
            <select
              autoFocus
              aria-label={`Move ${moving.name} to`}
              value={moveTo}
              onChange={(e) => setMoveTo(e.target.value)}
              className="rounded-md border border-line bg-white px-1.5 py-1 text-[12.5px] text-ink-900 outline-none focus:border-brand-400"
            >
              <option value="">Choose a row…</option>
              {otherRows.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <Button size="sm" variant="primary" loading={busy} loadingLabel="Moving…" disabled={!moveTo} onClick={() => move(moving.id, moveTo)}>
              Move
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMoving(null)}>
              Cancel
            </Button>
          </div>
        ) : null}
        {versions ? (
          <div className="mt-1 rounded-lg border border-line bg-canvas/60 px-2 py-1.5 text-[12px]">
            <p className="mb-0.5 font-semibold text-ink-500">Earlier versions</p>
            {versions.list.length === 0 ? <p className="text-ink-400">None to show.</p> : null}
            {versions.list.map((v) => (
              <button key={v.id} type="button" onClick={() => void downloadVersion(v.id)} className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-ink-700 hover:bg-white hover:text-brand-700">
                <Icon name="download" size={11} className="shrink-0 text-ink-400" />
                <span className="truncate">v{v.version} · {v.name}</span>
              </button>
            ))}
          </div>
        ) : null}
        {confirmingDelete ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-canvas/60 px-2 py-1.5">
            <span className="text-[12px] text-ink-700">Delete this row and its files? They go to the Recycle Bin.</span>
            <Button
              size="sm"
              variant="primary"
              loading={busy}
              loadingLabel="Deleting…"
              onClick={() => void run(() => deleteFileRowAction(moduleSlug, row.id), 'Could not delete that row.', () => setConfirmingDelete(false))}
            >
              Delete
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmingDelete(false)}>
              Cancel
            </Button>
          </div>
        ) : null}
        {error ? <p role="alert" className="text-[11px] text-danger">{error}</p> : null}
      </div>

      <RequiredCell key={`${row.id}:${row.required}:${row.filesNeeded}`} moduleSlug={moduleSlug} row={row} have={files.length} canMark={canMark} />

      <p className="pt-1 text-[12px] leading-snug text-ink-500">
        {row.note ?? <span className="text-ink-400/70">—</span>}
      </p>
    </div>
  );
}
