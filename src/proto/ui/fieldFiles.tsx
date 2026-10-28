'use client';

/**
 * The uploads behind a Files field (UI/UX spec §4: "Attach / view files").
 *
 * Same arrangement as `fieldLinks`: the field registry is shared with the
 * prototype, which has no storage, so the record drawer hands the real
 * operations in through context. Without a provider the control says where
 * files can be attached instead of offering a button that cannot work.
 */
import { createContext, useContext, type ReactNode } from 'react';

export type FieldFile = { id: string; name: string; sizeBytes: number; uploadedAt: string };

export type FieldFiles = {
  /** The field's files, newest first. */
  list: (fieldKey: string) => FieldFile[];
  /** Uploads one file; resolves to an error sentence, or null when it worked. */
  upload: (fieldKey: string, file: File) => Promise<string | null>;
  /** Opens a file in a new tab (a short-lived signed link). */
  open: (fileId: string) => void;
  /** Moves a file to the Recycle Bin. */
  remove: (fileId: string) => Promise<string | null>;
};

const FieldFilesContext = createContext<FieldFiles | null>(null);

export function FieldFilesProvider({ value, children }: { value: FieldFiles; children: ReactNode }) {
  return <FieldFilesContext.Provider value={value}>{children}</FieldFilesContext.Provider>;
}

export function useFieldFiles(): FieldFiles | null {
  return useContext(FieldFilesContext);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
