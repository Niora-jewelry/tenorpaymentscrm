'use client';

/**
 * Gives every Files field in this record's drawer its real operations — see
 * `proto/ui/fieldFiles.tsx`. Uploads and removals go through the same server
 * actions and file storage as the Files tab; what a viewer may do is decided
 * by the field's own grant, in the database (migration 9807).
 */
import { useMemo, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { FieldFilesProvider, type FieldFiles } from '@/proto/ui/fieldFiles';
import type { FileEntry } from '@/lib/records/files';
import { deleteFileAction, getFileUrlAction, uploadFieldFileAction } from './actions';

export function DrawerFieldFiles({
  moduleSlug,
  recordId,
  filesByField,
  children,
}: {
  moduleSlug: string;
  recordId: string;
  filesByField: Record<string, FileEntry[]>;
  children: ReactNode;
}) {
  const router = useRouter();
  const value = useMemo<FieldFiles>(
    () => ({
      list: (fieldKey) =>
        (filesByField[fieldKey] ?? []).map((f) => ({ id: f.id, name: f.name, sizeBytes: f.sizeBytes, uploadedAt: f.uploadedAt })),
      upload: async (fieldKey, file) => {
        const form = new FormData();
        form.set('file', file);
        try {
          const r = await uploadFieldFileAction(moduleSlug, recordId, fieldKey, form);
          if (!r.ok) return r.message ?? 'Could not attach that file.';
          router.refresh();
          return null;
        } catch {
          return 'Could not attach that file.';
        }
      },
      /* The tab is opened BEFORE the await and pointed at the link after: a
         window opened once a promise resolves is a popup, and browsers block
         it. Same approach as the Files tab. */
      open: (fileId) => {
        const tab = window.open('', '_blank');
        void getFileUrlAction(fileId).then(
          (url) => { if (tab) tab.location.href = url; else window.location.href = url; },
          () => tab?.close(),
        );
      },
      remove: async (fileId) => {
        try {
          await deleteFileAction(moduleSlug, fileId);
          router.refresh();
          return null;
        } catch {
          return 'Could not remove that file.';
        }
      },
    }),
    [filesByField, moduleSlug, recordId, router],
  );
  return <FieldFilesProvider value={value}>{children}</FieldFilesProvider>;
}
